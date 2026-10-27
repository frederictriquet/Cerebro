import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { delimiter, join } from 'node:path';
import { SerializeAddon } from '@xterm/addon-serialize';
import * as headlessPackage from '@xterm/headless';
import { withoutCerebroVariables } from './agent-env.ts';
import { secretMatches } from './secret-compare.ts';
import { buildAgentCommand, type Tuning } from './agents.ts';
import { ATTACHMENTS_DIR, INTERNAL_URL, KILL_ON_EXIT, LOG_DIR, ROOT, SESSIONS_DIR } from './config.ts';
import type { Agent, Mode, Project, Session, SessionDefaults } from './db.ts';
import { CerebroDatabase, resolveSessionDefaults, SessionProtectionError } from './db.ts';
import type { AgentQuestion } from './questions.ts';
import { archiveSessionWorktree } from './worktrees.ts';
import { assertWorktreeAvailable, deferWorktreeInput } from './worktree-gate.ts';
import { createWorkspace, createWorkspaceInContext, joinWorkspace, workspaceAt, workspaceFor, type Workspace, type WorkspaceContext } from './provenance.ts';
import { assertEpicWorkspace, epicWorkspace, rememberEpicWorkspace, withEpicWorkspace } from './epic-workspace.ts';
import { findProcessesByArgument, isAlive, processTree, signalProcesses, type ProcessInfo } from './proc.ts';

// @xterm/headless is CommonJS at runtime despite exposing ESM-shaped typings.
const Terminal = (headlessPackage as unknown as { default: typeof headlessPackage }).default.Terminal;

export type SessionEvent =
  | { type: 'session'; session: Session }
  | { type: 'projects'; projects: Project[] }
  | { type: 'session-deleted'; id: string }
  | { type: 'alert'; session: Session }
  // End of an agent turn, with its final message when the agent's hook provides it.
  | { type: 'turn-complete'; id: string; message: string | null };

export type TerminalEvent =
  | { type: 'snapshot'; data: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number | null };

interface Runtime {
  agent: Agent;
  socket: Socket | null;
  terminal: import('@xterm/headless').Terminal;
  serializer: SerializeAddon;
  terminalListeners: Set<(event: TerminalEvent) => void>;
  terminalClients: number;
  focusMode: boolean;
  oscTail: string;
  idleTimer: NodeJS.Timeout | null;
  screenTimer: NodeJS.Timeout | null;
  focusTimer: NodeJS.Timeout | null;
  reconnecting: boolean;
  /** Stopping an unreachable holder by signals (no socket to send it the kill message). */
  signalling: boolean;
  detaching: boolean;
  receivedExit: boolean;
  cols: number;
  rows: number;
  exitWaiters: Set<() => void>;
  lastOutputAt: number;
  /** Directory gating terminal input, resolved on first input and cleared on session or project events. */
  inputCwd?: string | null;
}

interface HolderConfig {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
}

interface ExitRecord {
  exitCode: number | null;
  signal: number | null;
  at: number;
}

const IDLE_DELAY_MS = 20_000;
// Même seuil que DORMANT_AFTER_MS côté web : au-delà, la session est « en sommeil » et purgeable.
const DORMANT_AFTER_MS = 60 * 60_000;

function isDormant(session: Session, now: number): boolean {
  return session.pendingFindings === 0 && (session.status === 'idle' || session.status === 'exited') && now - session.updatedAt >= DORMANT_AFTER_MS;
}
const SCREEN_CHECK_DELAY_MS = 2_000;
const CATCH_UP_DELAY_MS = 4_000;
// Interactive dialogs that hooks do not report (folder trust, y/n confirmations, numbered menus...).
const PROMPT_PATTERNS = [
  /trust (this|the) (folder|directory|files)/i,
  /do you want to (proceed|continue|make this edit|create|run|allow)/i,
  /enter to confirm/i,
  /enter continue/i,
  /\((y\/n|yes\/no)\)|\[y\/n\]/i,
  /^\s*[❯›>]\s*1\.\s+\S/m,
  /allow (once|always|this)/i,
];
// Inline TUIs (Claude, Codex) draw their dialogs at the very bottom of the screen, in place of the composer.
const PROMPT_WINDOW_LINES = 15;
// Composer line (Claude « ❯ », Codex « › »), as opposed to a numbered dialog option (« ❯ 1. Yes »).
const COMPOSER_LINE = /^[❯›>](?!\s*\d+\.)(\s|$)/;
const FORCE_KILL_DELAY_MS = 3_000;
const FOCUS_OUT_DELAY_MS = 1_500;
const MAX_LOG_SNAPSHOT = 2 * 1024 * 1024;
const HOLDER_START_TIMEOUT_MS = 10_000;
const HOLDER_START_RETRY_MS = 100;
const HOLDER_RECONNECT_ATTEMPTS = 3;
const HOLDER_RECONNECT_DELAY_MS = 1_000;
const HOLDER_RECONNECT_MAX_DELAY_MS = 10_000;
const HOLDER_EXIT_GRACE_MS = 1_500;
const HOLDER_KILL_WAIT_MS = 2_000;

function titleFor(agent: Agent, prompt: string): string {
  // Pasted images arrive as long attachment paths: show them as a short marker in the title.
  const text = prompt.split(ATTACHMENTS_DIR).join('\0').replace(/\0\/\S+/g, '[image]').trim();
  return text === '' ? `${agent} session` : text.slice(0, 120);
}

function ptyEnvironment(sessionId: string, token: string): Record<string, string | undefined> {
  const env = withoutCerebroVariables();
  const binPath = join(ROOT, 'bin');
  // Strip markers that make a CLI think it runs nested inside another agent session
  // (e.g. when Cerebro itself is started from Claude Code): they disable transcripts/resume.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT' || key === 'GROK_READ_ONLY_SANDBOX'
      || /^CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|EXECPATH|MESSAGING_)/.test(key)) {
      delete env[key];
    }
  }
  // Only the variables the bin/ helpers and hooks read: never the bind token or Slack credentials.
  return {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CEREBRO_SESSION_ID: sessionId,
    CEREBRO_TOKEN: token,
    CEREBRO_URL: INTERNAL_URL,
    CEREBRO_NOTIFY: join(binPath, 'cerebro-notify'),
    CEREBRO_BACKLOG: join(binPath, 'cerebro-backlog'),
    PATH: env.PATH === undefined ? binPath : `${binPath}${delimiter}${env.PATH}`,
  };
}

function readLogTail(path: string): string {
  if (!existsSync(path)) return '';
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, MAX_LOG_SNAPSHOT);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(length < size ? tailStart(buffer) : 0).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Where a truncated log tail may start without replaying a cut UTF-8 character or escape sequence. */
function tailStart(buffer: Buffer): number {
  // A line feed never occurs inside a multi-byte character, and output after it starts on a fresh line.
  const newline = buffer.indexOf(0x0a);
  if (newline >= 0) return newline + 1;
  const escape = buffer.indexOf(0x1b);
  if (escape >= 0) return escape;
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return start;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

function createTerminal(cols = 120, rows = 32): {
  terminal: import('@xterm/headless').Terminal;
  serializer: SerializeAddon;
} {
  const terminal = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 5000 });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  return { terminal, serializer };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SessionManager {
  readonly db: CerebroDatabase;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly deleting = new Set<string>();
  /** Launches still preparing their workspace (no holder yet): a deletion waits for them, then they abort. */
  private readonly preparing = new Map<string, Promise<void>>();
  private readonly questions = new Map<string, AgentQuestion[]>();
  /** Free-text question sent by the agent (`cerebro-notify --ask`), unanswered yet. */
  private readonly askedQuestions = new Map<string, string>();
  private readonly eventListeners = new Set<(event: SessionEvent) => void>();
  private shuttingDown = false;
  /** The session's process really stopped, or the session was deleted: its isolated copy may now be unused. */
  onSessionReleased: (id: string, workspaceRoot: string | null) => void = () => {};
  /** Stop project-scoped background work and prevent new starts until removal finishes. */
  withProjectDeletion: (id: string, remove: () => Promise<void>) => Promise<void> = async (_id, remove) => remove();
  /** Starts the detached holder process for a session config file. */
  spawnHolder: (configPath: string) => ChildProcess = (configPath) => spawn(
    process.execPath,
    [join(ROOT, 'server', 'holder.ts'), configPath],
    // Parent direct de l'agent : son /proc/<pid>/environ lui est lisible, il ne doit donc porter aucun secret.
    { detached: true, stdio: 'ignore', env: withoutCerebroVariables() },
  );

  constructor(db: CerebroDatabase) {
    this.db = db;
  }

  async initialize(): Promise<void> {
    for (const session of this.db.listSessions()) {
      if (session.status === 'exited') {
        this.cleanupExitArtifacts(session.id);
        continue;
      }
      if (this.db.getHookToken(session.id) === null) {
        this.db.setHookToken(session.id, randomBytes(32).toString('hex'));
      }
      const runtime = this.newRuntime(session.agent);
      this.runtimes.set(session.id, runtime);
      if (await this.connectOnce(session.id, runtime)) {
        this.resumeAttached(session, runtime);
        continue;
      }
      const exit = this.readExitRecord(session.id);
      // A holder still starting (or briefly stalled) refuses connections: concluding would delete its socket for good.
      if (exit === null && this.holderAlive(session.id)) {
        void this.reconnect(session.id, runtime, () => {
          const current = this.db.getSession(session.id);
          if (current !== null) this.resumeAttached(current, runtime);
        });
        continue;
      }
      this.finishSession(session.id, exit?.exitCode ?? null);
      this.cleanupExitArtifacts(session.id);
    }
  }

  private resumeAttached(session: Session, runtime: Runtime): void {
    // Codex always enables focus reporting, but that escape sequence predates the reattach.
    if (session.agent === 'codex') runtime.focusMode = true;
    if (session.status === 'idle' || session.status === 'waiting') {
      // Keep the known state: re-alerting every idle session at each server restart would be noise.
      // A dialog that appeared meanwhile is still caught by the screen check below.
      this.emit({ type: 'session', session });
    } else {
      const running = this.db.updateSession(session.id, { status: 'running' });
      if (running !== null) this.emit({ type: 'session', session: running });
      this.scheduleIdleCheck(session.id);
      this.scheduleCatchUpCheck(session.id, runtime);
    }
    this.scheduleImmediateScreenCheck(session.id, runtime);
    this.scheduleFocusOut(session.id, runtime);
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private emit(event: SessionEvent): void {
    if (event.type === 'session') delete this.runtimes.get(event.session.id)?.inputCwd;
    else if (event.type === 'projects') this.forgetInputContexts();
    for (const listener of this.eventListeners) listener(event);
  }

  async create(project: Project, overrides: Partial<SessionDefaults> = {}, validate?: () => Promise<void>, contextPath?: string, title?: string, options: { rememberDefaults?: boolean; epicId?: string | null; workspace?: WorkspaceContext } = {}): Promise<Session> {
    const create = (): Promise<Session> => this.createInContext(project, overrides, validate, contextPath, title, options);
    return options.epicId ? withEpicWorkspace(this.db, options.epicId, create) : create();
  }

  private async createInContext(project: Project, overrides: Partial<SessionDefaults>, validate: (() => Promise<void>) | undefined, contextPath: string | undefined, title: string | undefined, options: { rememberDefaults?: boolean; epicId?: string | null; workspace?: WorkspaceContext }): Promise<Session> {
    const current = this.db.getProject(project.id);
    if (current === null) throw new Error('Projet introuvable');
    // An explicit workspace (a copy to repair) is joined whatever the project's current preference.
    const context = options.epicId ? epicWorkspace(this.db, options.epicId) : options.workspace ?? null;
    if (options.epicId && context) assertEpicWorkspace(this.db, context);
    // Automated launches must not replace the user's form settings with generated instructions.
    const defaults = options.rememberDefaults === false
      ? resolveSessionDefaults(current.sessionDefaults, overrides)
      : this.rememberDefaults(project.id, overrides);
    const path=context?.path??(current.workspaceMode==='shared'?current.path:contextPath??current.path);
    assertWorktreeAvailable(path);
    // A context inside an existing copy (next epic step) reuses it instead of copying the copy.
    const joined=context||current.workspaceMode==='shared'||!contextPath?null:workspaceAt(this.db,contextPath);
    return this.launch({...current,path}, defaults.agent, defaults.mode, defaults, defaults.prompt, null, null, validate, joined, title, options.epicId, context);
  }

  rememberDefaults(projectId: string, overrides: Partial<SessionDefaults>): SessionDefaults {
    const project = this.db.getProject(projectId);
    if (project === null) throw new Error('Projet introuvable');
    const defaults = resolveSessionDefaults(project.sessionDefaults, overrides);
    this.db.setSessionDefaults(projectId, defaults);
    this.emit({ type: 'projects', projects: this.db.listProjects() });
    return defaults;
  }

  async resume(id: string): Promise<Session> {
    const oldSession = this.db.getSession(id);
    if (oldSession === null) throw new Error('Session introuvable');
    if (oldSession.status !== 'exited') throw new Error("La session n'est pas terminée");
    if (oldSession.agentSessionId === null) throw new Error("Cette session ne peut pas être reprise");
    const project = this.db.getProject(oldSession.projectId);
    if (project === null) throw new Error('Projet introuvable');
    const workspace=workspaceFor(this.db,id);
    if(workspace?.removedAt)throw new Error(workspace.removedAutomatically
      ?'La copie de travail de cette conversation a été nettoyée automatiquement à sa fin, car elle ne contenait rien à conserver. La conversation reste consultable mais ne peut plus être reprise : Cerebro ne la reprend pas dans le dossier du projet.'
      :'Le worktree a été supprimé ; la conversation reste consultable mais ne peut plus être reprise dans cet espace.');
    assertWorktreeAvailable(workspace?.path??project.path);
    const tuning = { model: oldSession.model, effort: oldSession.effort };
    return this.launch(project, oldSession.agent, oldSession.mode, tuning, '', oldSession.agentSessionId, oldSession.id);
  }

  private async launch(
    project: Project,
    agent: Agent,
    mode: Mode,
    tuning: Tuning,
    prompt: string,
    resumeSessionId: string | null,
    existingId: string | null = null,
    validate?: () => Promise<void>,
    joined: Workspace | null = null,
    title?: string,
    epicId: string | null = null,
    context: WorkspaceContext | null = null,
  ): Promise<Session> {
    const id = existingId ?? randomUUID();
    if (this.deleting.has(id)) throw new Error('Suppression en cours pour cette session');
    const command = buildAgentCommand(agent, mode, prompt, id, resumeSessionId, tuning);
    const token = this.db.getHookToken(id) ?? randomBytes(32).toString('hex');
    let session: Session;
    if (existingId === null) {
      session = this.db.createSession({
        id,
        projectId: project.id,
        agent,
        mode,
        ...tuning,
        prompt,
        title: title ?? titleFor(agent, prompt),
        status: 'starting',
        agentSessionId: command.agentSessionId,
      }, token, epicId);
    } else {
      this.db.setHookToken(id, token);
      const updated = this.db.updateSession(id, {
        status: 'starting',
        attention: false,
        attentionReason: null,
        exitCode: null,
      });
      if (updated === null) throw new Error('Session introuvable');
      session = updated;
    }
    this.emit({ type: 'session', session });

    const configPath = this.configPath(id);
    const preparation = this.prepareWorkspace(id, project, existingId, context, joined, epicId, validate);
    this.preparing.set(id, preparation.then(() => {}, () => {}));
    // Any failure before the holder spawn must end the session: left in 'starting' without runtime,
    // it could neither be stopped nor resumed.
    try {
      const cwd = await preparation;
      if (this.deleting.has(id) || this.db.getSession(id) === null) throw new Error('Session supprimée pendant son lancement');
      this.cleanupLaunchArtifacts(id);
      const config: HolderConfig = {
        cmd: command.cmd,
        args: command.args,
        cwd,
        env: ptyEnvironment(id, token),
        cols: 120,
        rows: 32,
      };
      writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: 'wx' });
    } catch (cause) {
      this.finishSession(id, 1);
      throw cause;
    } finally {
      this.preparing.delete(id);
    }

    const runtime = this.newRuntime(agent);
    this.runtimes.set(id, runtime);
    let spawned = false;
    let failed = false;
    const fail = (error: unknown): void => {
      if (failed) return;
      failed = true;
      this.logHolderError(id, error);
      removeFile(configPath);
      this.finishSession(id, 1);
    };
    try {
      const holder = this.spawnHolder(configPath);
      holder.once('spawn', () => { spawned = true; });
      // EAGAIN, EMFILE, ENOMEM… arrive as an 'error' event: unhandled, it would crash the server.
      holder.on('error', (error) => {
        if (spawned) this.logHolderError(id, error);
        else fail(error);
      });
      holder.unref();
    } catch (error) {
      fail(error);
    }

    const deadline = Date.now() + HOLDER_START_TIMEOUT_MS;
    let connected = false;
    while (!connected && !failed && this.runtimes.get(id) === runtime && Date.now() < deadline) {
      connected = await this.connectOnce(id, runtime);
      if (!connected) {
        const exit = this.readExitRecord(id);
        if (exit !== null) break;
        await delay(HOLDER_START_RETRY_MS);
      }
    }
    // Failed, or stopped by kill() before the holder ever listened.
    if (failed || this.runtimes.get(id) !== runtime) return this.db.getSession(id) ?? session;
    if (!connected) {
      this.logHolderError(id, new Error('Connexion au holder impossible après 10 secondes'));
      return this.finishSession(id, 1) ?? session;
    }

    const running = this.db.updateSession(id, { status: 'running' });
    if (running === null) return session;
    session = running;
    this.emit({ type: 'session', session });
    this.scheduleIdleCheck(id);
    this.scheduleFocusOut(id, runtime);
    return session;
  }

  private async prepareWorkspace(
    id: string,
    project: Project,
    existingId: string | null,
    context: WorkspaceContext | null,
    joined: Workspace | null,
    epicId: string | null,
    validate?: () => Promise<void>,
  ): Promise<string> {
    const workspace = existingId !== null ? workspaceFor(this.db, id) : context ? await createWorkspaceInContext(this.db, id, project, context) : joined ? await joinWorkspace(this.db, id, joined) : await createWorkspace(this.db, id, project);
    const cwd = workspace?.path ?? project.path;
    if(workspace?.removedAt)throw new Error('Le worktree de cette conversation a été supprimé.');
    if (epicId && workspace) rememberEpicWorkspace(this.db, epicId, {path:workspace.path,mode:workspace.mode});
    assertWorktreeAvailable(cwd);
    if (validate) await validate();
    assertWorktreeAvailable(cwd);
    if (!existsSync(cwd)) throw new Error(`Espace de session introuvable : ${cwd}`);
    return cwd;
  }

  private newRuntime(agent: Agent): Runtime {
    const { terminal, serializer } = createTerminal();
    return {
      agent,
      socket: null,
      terminal,
      serializer,
      terminalListeners: new Set(),
      terminalClients: 0,
      focusMode: false,
      oscTail: '',
      idleTimer: null,
      screenTimer: null,
      focusTimer: null,
      reconnecting: false,
      signalling: false,
      detaching: false,
      receivedExit: false,
      cols: 120,
      rows: 32,
      exitWaiters: new Set(),
      lastOutputAt: 0,
    };
  }

  private connectOnce(id: string, runtime: Runtime): Promise<boolean> {
    return new Promise((resolve) => {
      if (runtime.detaching || this.runtimes.get(id) !== runtime) {
        resolve(false);
        return;
      }
      const socket = createConnection(this.socketPath(id));
      socket.setEncoding('utf8');
      let connected = false;
      let settled = false;
      let input = '';
      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      socket.on('connect', () => {
        if (runtime.detaching || this.runtimes.get(id) !== runtime) {
          socket.destroy();
          settle(false);
          return;
        }
        connected = true;
        runtime.socket?.destroy();
        runtime.socket = socket;
        settle(true);
      });
      socket.on('data', (chunk) => {
        input += chunk;
        let newline = input.indexOf('\n');
        while (newline >= 0) {
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          try {
            const message: unknown = JSON.parse(line);
            if (isRecord(message)) this.handleHolderMessage(id, runtime, message);
          } catch {
            // Ignore malformed holder messages.
          }
          newline = input.indexOf('\n');
        }
      });
      socket.on('error', () => settle(false));
      socket.on('close', () => {
        settle(false);
        if (!connected || runtime.socket !== socket) return;
        runtime.socket = null;
        if (!runtime.detaching && !runtime.receivedExit && !this.shuttingDown) void this.reconnect(id, runtime);
      });
    });
  }

  private handleHolderMessage(id: string, runtime: Runtime, message: Record<string, unknown>): void {
    if (this.runtimes.get(id) !== runtime) return;
    if (message.type === 'hello') {
      if (typeof message.cols === 'number' && Number.isInteger(message.cols) && message.cols > 0) runtime.cols = message.cols;
      if (typeof message.rows === 'number' && Number.isInteger(message.rows) && message.rows > 0) runtime.rows = message.rows;
      return;
    }
    if (message.type === 'snapshot' && typeof message.data === 'string') {
      runtime.terminal.dispose();
      const replacement = createTerminal(runtime.cols, runtime.rows);
      runtime.terminal = replacement.terminal;
      runtime.serializer = replacement.serializer;
      runtime.terminal.write(message.data, () => this.scheduleImmediateScreenCheck(id, runtime));
      if (runtime.agent === 'codex' && message.data.includes('\x1b[?1004h')) runtime.focusMode = true;
      for (const listener of runtime.terminalListeners) listener({ type: 'snapshot', data: message.data });
      return;
    }
    if (message.type === 'output' && typeof message.data === 'string') {
      this.handleOutput(id, message.data);
      return;
    }
    if (message.type === 'exit' && (typeof message.exitCode === 'number' || message.exitCode === null)) {
      runtime.receivedExit = true;
      const exitCode = typeof message.exitCode === 'number' ? message.exitCode : null;
      runtime.socket?.end();
      this.finishSession(id, exitCode);
    }
  }

  // Beyond the first attempts, only a vanished holder process ends the session: a live one is merely
  // slow (still starting, or this server was stalled), and finishing would strand it without a socket.
  private async reconnect(id: string, runtime: Runtime, onConnected?: () => void): Promise<void> {
    if (runtime.reconnecting) return;
    runtime.reconnecting = true;
    try {
      let wait = HOLDER_RECONNECT_DELAY_MS;
      for (let attempt = 0; attempt < HOLDER_RECONNECT_ATTEMPTS || this.holderAlive(id); attempt += 1) {
        const exit = this.readExitRecord(id);
        if (exit !== null) {
          this.finishSession(id, exit.exitCode);
          return;
        }
        await delay(wait);
        if (attempt >= HOLDER_RECONNECT_ATTEMPTS) wait = Math.min(wait * 2, HOLDER_RECONNECT_MAX_DELAY_MS);
        if (runtime.detaching || this.runtimes.get(id) !== runtime || this.shuttingDown) return;
        if (await this.connectOnce(id, runtime)) {
          onConnected?.();
          return;
        }
      }
      const exit = this.readExitRecord(id);
      this.finishSession(id, exit?.exitCode ?? null);
    } finally {
      runtime.reconnecting = false;
    }
  }

  private handleOutput(id: string, data: string): void {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return;
    runtime.terminal.write(data);
    runtime.lastOutputAt = Date.now();
    if (runtime.agent === 'codex' && data.includes('\x1b[?1004h')) runtime.focusMode = true;
    this.inspectOsc(id, runtime, data);
    for (const listener of runtime.terminalListeners) listener({ type: 'output', data });
    this.scheduleIdleCheck(id);
  }

  private inspectOsc(id: string, runtime: Runtime, data: string): void {
    const combined = runtime.oscTail + data;
    runtime.oscTail = '';
    const osc9 = /\x1b\]9;([^\x07]*?)(?:\x07|\x1b\\)/g;
    const osc777 = /\x1b\]777;notify;([^;\x07]*);([^\x07]*?)(?:\x07|\x1b\\)/g;
    let match: RegExpExecArray | null;
    while ((match = osc9.exec(combined)) !== null) this.handleOscMessage(id, match[1] ?? '');
    while ((match = osc777.exec(combined)) !== null) this.handleOscMessage(id, match[2] ?? '');

    const lastOsc = combined.lastIndexOf('\x1b]');
    if (lastOsc >= 0) {
      const suffix = combined.slice(lastOsc);
      if (!suffix.includes('\x07') && !suffix.includes('\x1b\\')) runtime.oscTail = suffix.slice(-4096);
    } else if (combined.endsWith('\x1b')) {
      runtime.oscTail = '\x1b';
    }
  }

  private handleOscMessage(id: string, message: string): void {
    const waiting = /approv|permission|confirm/i.test(message);
    // Claude émet « Claude is waiting for your input » en fin de tour : c'est un idle, pas une question.
    const genericIdle = /waiting for your input/i.test(message);
    const reason = waiting ? message || 'Permission demandée' : genericIdle || !message ? 'Tour terminé' : message;
    this.setReliableState(id, waiting ? 'waiting' : 'idle', reason);
  }

  private scheduleIdleCheck(id: string): void {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return;
    if (runtime.idleTimer !== null) clearTimeout(runtime.idleTimer);
    if (runtime.screenTimer !== null) clearTimeout(runtime.screenTimer);
    runtime.screenTimer = setTimeout(() => {
      runtime.screenTimer = null;
      if (this.runtimes.get(id) === runtime) this.inspectScreen(id, runtime);
    }, SCREEN_CHECK_DELAY_MS);
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = null;
      const session = this.db.getSession(id);
      if (session?.status === 'running') {
        const updated = this.db.updateSession(id, {
          status: 'idle',
          attention: false,
          attentionReason: 'Inactif (heuristique)',
        });
        if (updated !== null) this.emit({ type: 'session', session: updated });
      }
    }, IDLE_DELAY_MS);
  }

  /**
   * The session was working when the server went away: its end-of-turn hook may have been lost.
   * Agents redraw constantly while working (spinners), so a quiet screen shortly after reattaching
   * means the turn ended during the outage.
   */
  private scheduleCatchUpCheck(id: string, runtime: Runtime): void {
    const reattachedAt = Date.now();
    setTimeout(() => {
      if (this.runtimes.get(id) !== runtime || runtime.lastOutputAt > reattachedAt) return;
      if (this.db.getSession(id)?.status !== 'running') return;
      this.setReliableState(id, 'idle', 'Terminé pendant la coupure du serveur');
    }, CATCH_UP_DELAY_MS);
  }

  private scheduleImmediateScreenCheck(id: string, runtime: Runtime): void {
    if (runtime.screenTimer !== null) clearTimeout(runtime.screenTimer);
    runtime.screenTimer = setTimeout(() => {
      runtime.screenTimer = null;
      if (this.runtimes.get(id) === runtime) this.inspectScreen(id, runtime);
    }, 0);
  }

  private scheduleFocusOut(id: string, runtime: Runtime): void {
    if (runtime.focusTimer !== null) clearTimeout(runtime.focusTimer);
    runtime.focusTimer = setTimeout(() => {
      runtime.focusTimer = null;
      if (runtime.focusMode && this.runtimes.get(id) === runtime) this.sendHolder(runtime, { type: 'input', data: '\x1b[O' });
    }, FOCUS_OUT_DELAY_MS);
  }

  private visibleLines(runtime: Runtime, count = 20): string[] {
    const buffer = runtime.terminal.buffer.active;
    const lines: string[] = [];
    // Scan the whole viewport: full-screen TUIs (alternate buffer) often draw dialogs at the top.
    const end = buffer.baseY + runtime.terminal.rows;
    for (let y = buffer.baseY; y < end; y += 1) {
      const line = buffer.getLine(y)?.translateToString(true).trim();
      if (line) lines.push(line);
    }
    return lines.slice(-count);
  }

  /** Last non-empty lines of the live screen (text only), or null when the session has no live terminal. */
  screenText(id: string, count = 20): string[] | null {
    const runtime = this.runtimes.get(id);
    return runtime === undefined ? null : this.visibleLines(runtime, count);
  }

  /**
   * Lines where a pending dialog can be: on an inline screen, only the bottom lines below the last
   * composer, so that transcript text (a `cat` showing « (y/n) », an echoed prompt « ❯ 1. … », a dialog
   * already answered) never passes for a question.
   */
  private promptRegion(runtime: Runtime): string[] {
    const lines = this.visibleLines(runtime, 60);
    // Full-screen TUIs (alternate buffer) draw dialogs anywhere, often at the top.
    if (runtime.terminal.buffer.active.type === 'alternate') return lines;
    const bottom = lines.slice(-PROMPT_WINDOW_LINES);
    return bottom.slice(bottom.findLastIndex((line) => COMPOSER_LINE.test(line)) + 1);
  }

  private inspectScreen(id: string, runtime: Runtime): void {
    const session = this.db.getSession(id);
    if (session === null || session.status === 'exited' || session.status === 'waiting') return;
    const lines = this.promptRegion(runtime);
    const screen = lines.join('\n');
    if (!PROMPT_PATTERNS.some((pattern) => pattern.test(screen))) return;
    // Use the question sentence as the reason (e.g. "Trust this folder?"), else a generic label.
    let question = 'Confirmation requise';
    for (const line of lines) {
      const match = /([^?│|]{6,}\?)/.exec(line);
      if (match?.[1] !== undefined) question = match[1].replace(/^.*[.:]\s+/, '').trim();
    }
    this.setReliableState(id, 'waiting', question.slice(0, 160));
  }

  setReliableState(id: string, requested: 'waiting' | 'idle', requestedReason: string): Session | null {
    const session = this.db.getSession(id);
    if (session === null || session.status === 'exited') return null;
    // The agent asked through cerebro-notify then ended its turn: it is waiting for an answer, not done.
    const asked = requested === 'idle' ? this.askedQuestions.get(id) : undefined;
    const status = asked === undefined ? requested : 'waiting';
    const reason = asked === undefined ? requestedReason : `Question : ${asked}`.slice(0, 160);
    if (session.status === status && session.attentionReason === reason) return session;
    // Several signals often report the same transition (codex OSC 9 + notify, Claude Stop + idle_prompt):
    // only the first one alerts, the others just refine the reason.
    const alreadySignaled = session.status === status && session.attention;
    const updated = this.db.updateSession(id, {
      status,
      attention: true,
      attentionReason: alreadySignaled && session.attentionReason !== null ? session.attentionReason : reason,
    });
    if (updated !== null) {
      this.emit({ type: 'session', session: updated });
      if (!alreadySignaled) this.emit({ type: 'alert', session: updated });
    }
    return updated;
  }

  reportTurnComplete(id: string, message: string | null): void {
    this.emit({ type: 'turn-complete', id, message });
  }

  /** Structured questions currently shown by the agent (AskUserQuestion), if any. */
  pendingQuestions(id: string): AgentQuestion[] | null {
    return this.questions.get(id) ?? null;
  }

  /** Called on `cerebro-notify --ask`: the end of the turn will then show as a question. */
  markAsked(id: string, question: string): void {
    this.askedQuestions.set(id, question.replace(/\s+/g, ' ').trim());
  }

  /** The user answered (prompt submitted): the next end of turn is a plain one again. */
  clearAsked(id: string): void {
    this.askedQuestions.delete(id);
  }

  setPendingQuestions(id: string, questions: AgentQuestion[] | null): void {
    if (questions === null) this.questions.delete(id);
    else this.questions.set(id, questions);
  }

  setRunning(id: string): Session | null {
    const session = this.db.getSession(id);
    if (session === null || session.status === 'exited') return null;
    if (session.status === 'running') return session;
    // The previous end-of-turn reason ("Tour terminé", a question…) no longer applies once work resumes.
    const updated = this.db.updateSession(id, { status: 'running', attention: false, attentionReason: null });
    if (updated !== null) this.emit({ type: 'session', session: updated });
    this.scheduleIdleCheck(id);
    return updated;
  }

  setAgentSessionId(id: string, agentSessionId: string): Session | null {
    const session = this.db.getSession(id);
    if (session === null || session.agentSessionId === agentSessionId) return session;
    const updated = this.db.updateSession(id, { agentSessionId });
    if (updated !== null) this.emit({ type: 'session', session: updated });
    return updated;
  }

  tokenMatches(id: string, token: string | undefined): boolean {
    return secretMatches(this.db.getHookToken(id), token);
  }

  seen(id: string): Session | null {
    const session = this.db.getSession(id);
    if (session === null) return null;
    if (!session.attention) return session;
    const updated = this.db.updateSession(id, { attention: false });
    if (updated !== null) this.emit({ type: 'session', session: updated });
    return updated;
  }

  rename(id: string, title: string): Session | null {
    const updated = this.db.updateSession(id, { title });
    if (updated !== null) this.emit({ type: 'session', session: updated });
    return updated;
  }

  setProtected(id: string, value: boolean): Session | null {
    if (this.deleting.has(id)) throw new SessionProtectionError('Suppression déjà en cours pour cette session.');
    const updated = this.db.setSessionProtected(id, value);
    if (updated !== null) this.emit({ type: 'session', session: updated });
    return updated;
  }

  writeInput(id: string, data: string): boolean {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return false;
    // xterm sends every keystroke: the database is only read to resolve the directory, then on Enter.
    if (runtime.inputCwd === undefined) runtime.inputCwd = this.inputCwd(id);
    if(runtime.inputCwd&&deferWorktreeInput(runtime.inputCwd,()=>{this.writeInput(id,data);}))return true;
    if (!this.sendHolder(runtime, { type: 'input', data })) return false;
    if (!data.includes('\r')) return true;
    const session = this.db.getSession(id);
    if (session?.status === 'waiting' || session?.status === 'idle') {
      this.clearAsked(id);
      this.setRunning(id);
    }
    return true;
  }

  /** A project moved: shared sessions must gate their input on its new path. */
  forgetInputContexts(): void {
    for (const runtime of this.runtimes.values()) delete runtime.inputCwd;
  }

  private inputCwd(id: string): string | null {
    const workspace = workspaceFor(this.db, id);
    if (workspace) return workspace.path;
    const session = this.db.getSession(id);
    return session ? this.db.getProject(session.projectId)?.path ?? null : null;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return false;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return false;
    runtime.cols = cols;
    runtime.rows = rows;
    runtime.terminal.resize(cols, rows);
    return this.sendHolder(runtime, { type: 'resize', cols, rows });
  }

  terminalSnapshot(id: string): string | null {
    const runtime = this.runtimes.get(id);
    if (runtime !== undefined) return runtime.serializer.serialize();
    if (this.db.getSession(id) === null) return null;
    return readLogTail(join(LOG_DIR, `${id}.log`));
  }

  onTerminalEvent(id: string, listener: (event: TerminalEvent) => void): (() => void) | null {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return null;
    runtime.terminalListeners.add(listener);
    runtime.terminalClients += 1;
    return () => {
      if (!runtime.terminalListeners.delete(listener)) return;
      runtime.terminalClients = Math.max(0, runtime.terminalClients - 1);
      if (runtime.terminalClients === 0 && runtime.focusMode && this.runtimes.get(id) === runtime) {
        this.sendHolder(runtime, { type: 'input', data: '\x1b[O' });
      }
    };
  }

  kill(id: string): boolean {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return false;
    if (this.sendHolder(runtime, { type: 'kill', signal: 'SIGTERM' })) return true;
    // A live holder that does not answer (still starting, stalled, socket file gone) keeps the session
    // reconnecting indefinitely: stop it through its processes instead.
    const holders = findProcessesByArgument(this.configPath(id));
    if (holders.length === 0) return false;
    void this.signalHolder(id, runtime, holders);
    return true;
  }

  private async signalHolder(id: string, runtime: Runtime, holders: ProcessInfo[]): Promise<void> {
    if (runtime.signalling) return;
    runtime.signalling = true;
    try {
      this.logHolderError(id, new Error(`Holder injoignable, arrêt par signal (pid ${holders.map((h) => h.pid).join(', ')})`));
      const targets = holders.flatMap((holder) => processTree(holder.pid));
      signalProcesses(targets, 'SIGTERM');
      const deadline = Date.now() + FORCE_KILL_DELAY_MS;
      while (targets.some(isAlive) && Date.now() < deadline) await delay(HOLDER_START_RETRY_MS);
      // SIGTERM stays pending on a stopped process: only SIGKILL reaches it.
      signalProcesses(targets, 'SIGKILL');
      const killDeadline = Date.now() + HOLDER_KILL_WAIT_MS;
      while (targets.some(isAlive) && Date.now() < killDeadline) await delay(HOLDER_START_RETRY_MS);
      if (this.runtimes.get(id) !== runtime) return;
      if (targets.some(isAlive)) {
        this.logHolderError(id, new Error("Impossible d'arrêter les processus de la session"));
        return;
      }
      this.finishSession(id, this.readExitRecord(id)?.exitCode ?? null);
    } finally {
      runtime.signalling = false;
    }
  }

  killProject(projectId: string): void {
    for (const session of this.db.listProjectSessions(projectId)) this.kill(session.id);
  }

  async deleteProject(projectId: string): Promise<boolean> {
    const project = this.db.getProject(projectId);
    if (project === null) return false;
    const projectSessions = this.db.listProjectSessions(projectId);
    if (projectSessions.some((session) => session.protected)) {
      throw new SessionProtectionError('Ce projet contient des sessions protégées. Décochez leur protection avant de le supprimer.');
    }
    if (projectSessions.some((session) => this.deleting.has(session.id))) {
      throw new SessionProtectionError('Suppression déjà en cours pour une session de ce projet.');
    }
    projectSessions.forEach((session) => this.deleting.add(session.id));
    try {
      await this.withProjectDeletion(projectId, async () => {
        const preparations = projectSessions.flatMap((session) => this.preparing.get(session.id) ?? []);
        if (preparations.length > 0) await Promise.all(preparations);
        await Promise.all(projectSessions.map((session) => this.stopProcesses(session.id)));
        await Promise.all(projectSessions.map(session=>archiveSessionWorktree(this.db,session.id)));
        const roots = projectSessions.map((session) => workspaceFor(this.db, session.id)?.root ?? null);
        this.db.deleteProject(projectId);
        projectSessions.forEach((session, index) => this.onSessionReleased(session.id, roots[index] ?? null));
        rmSync(join(ATTACHMENTS_DIR, `project-${projectId}`), { recursive: true, force: true });
        for (const session of projectSessions) {
          this.cleanupAllArtifacts(session.id);
          this.questions.delete(session.id);
          this.askedQuestions.delete(session.id);
          this.emit({ type: 'session-deleted', id: session.id });
        }
      });
      return true;
    } finally {
      projectSessions.forEach((session) => this.deleting.delete(session.id));
    }
  }

  async purgeProject(projectId: string): Promise<number | null> {
    if (this.db.getProject(projectId) === null) return null;
    const inactive = this.db
      .listProjectSessions(projectId)
      .filter((session) => !session.protected && isDormant(session, Date.now()));
    const results = await Promise.allSettled(inactive.map((session) => this.delete(session.id)));
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length > 0) {
      const deleted = results.length - failed.length;
      throw new Error(`${failed.length} session(s) impossible(s) à arrêter (${deleted} supprimée(s))`);
    }
    return inactive.length;
  }

  async delete(id: string): Promise<boolean> {
    const session = this.db.getSession(id);
    if (session === null) return false;
    if (session.protected) throw new SessionProtectionError('Session protégée. Décochez sa protection avant de la supprimer.');
    if (this.deleting.has(id)) throw new SessionProtectionError('Suppression déjà en cours pour cette session.');
    this.deleting.add(id);
    try {
      // A launch still creating its copy records it first (so it is archived below), then aborts before spawning.
      const preparation = this.preparing.get(id);
      if (preparation !== undefined) await preparation;
      await this.stopProcesses(id);
      await archiveSessionWorktree(this.db,id);
      const root = workspaceFor(this.db, id)?.root ?? null;
      this.db.deleteSession(id);
      this.onSessionReleased(id, root);
      this.cleanupAllArtifacts(id);
      this.questions.delete(id);
      this.askedQuestions.delete(id);
      this.emit({ type: 'session-deleted', id });
      return true;
    } finally {
      this.deleting.delete(id);
    }
  }

  // Deleting a session must not leave its holder running: once its socket file is removed, nothing
  // could reach it again. Graceful stop first, then SIGKILL on whatever is left; throws if it survives.
  private async stopProcesses(id: string): Promise<void> {
    await this.terminate(id);
    const holderArgument = this.configPath(id);
    const deadline = Date.now() + HOLDER_EXIT_GRACE_MS;
    while (findProcessesByArgument(holderArgument).length > 0 && Date.now() < deadline) {
      await delay(HOLDER_START_RETRY_MS);
    }
    const holders = findProcessesByArgument(holderArgument);
    if (holders.length === 0) return;
    this.logHolderError(id, new Error(`Holder toujours actif après l'arrêt, SIGKILL (pid ${holders.map((h) => h.pid).join(', ')})`));
    const targets = holders.flatMap((holder) => processTree(holder.pid));
    signalProcesses(targets, 'SIGKILL');
    const killDeadline = Date.now() + HOLDER_KILL_WAIT_MS;
    while (targets.some(isAlive) && Date.now() < killDeadline) await delay(HOLDER_START_RETRY_MS);
    if (targets.some(isAlive)) throw new Error("Impossible d'arrêter les processus de la session");
  }

  private holderAlive(id: string): boolean {
    return findProcessesByArgument(this.configPath(id)).length > 0;
  }

  private async terminate(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return;
    const exited = new Promise<void>((resolve) => runtime.exitWaiters.add(resolve));
    const killDeadline = Date.now() + HOLDER_RECONNECT_ATTEMPTS * HOLDER_RECONNECT_DELAY_MS + 500;
    let killSent = this.kill(id);
    while (!killSent && this.runtimes.get(id) === runtime && Date.now() < killDeadline) {
      await delay(HOLDER_START_RETRY_MS);
      killSent = this.kill(id);
    }
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, FORCE_KILL_DELAY_MS + 1_000);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    runtime.exitWaiters.clear();
    if (this.runtimes.get(id) === runtime) this.detachRuntime(id, runtime);
  }

  private finishSession(id: string, exitCode: number | null): Session | null {
    const runtime = this.runtimes.get(id);
    if (runtime !== undefined) {
      this.runtimes.delete(id);
      runtime.receivedExit = true;
      runtime.detaching = true;
      this.clearRuntimeTimers(runtime);
      runtime.socket?.destroy();
      runtime.socket = null;
      runtime.terminal.dispose();
    }
    // A question left unanswered by the stopped agent must not resurface as the reason of a resumed session.
    this.questions.delete(id);
    this.askedQuestions.delete(id);
    const updated = this.db.updateSession(id, {
      status: 'exited',
      exitCode,
      attention: false,
      attentionReason: null,
    });
    if (updated !== null) {
      this.emit({ type: 'session', session: updated });
      this.onSessionReleased(id, workspaceFor(this.db, id)?.root ?? null);
    }
    if (runtime !== undefined) {
      for (const listener of runtime.terminalListeners) listener({ type: 'exit', exitCode });
      for (const resolve of runtime.exitWaiters) resolve();
      runtime.exitWaiters.clear();
    }
    return updated;
  }

  private sendHolder(runtime: Runtime, message: unknown): boolean {
    if (runtime.socket === null || runtime.socket.destroyed || !runtime.socket.writable) return false;
    runtime.socket.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  private detachRuntime(id: string, runtime: Runtime): void {
    if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
    runtime.detaching = true;
    this.clearRuntimeTimers(runtime);
    runtime.socket?.destroy();
    runtime.socket = null;
    runtime.terminal.dispose();
    for (const resolve of runtime.exitWaiters) resolve();
    runtime.exitWaiters.clear();
  }

  private clearRuntimeTimers(runtime: Runtime): void {
    if (runtime.idleTimer !== null) clearTimeout(runtime.idleTimer);
    if (runtime.screenTimer !== null) clearTimeout(runtime.screenTimer);
    if (runtime.focusTimer !== null) clearTimeout(runtime.focusTimer);
    runtime.idleTimer = null;
    runtime.screenTimer = null;
    runtime.focusTimer = null;
  }

  private readExitRecord(id: string): ExitRecord | null {
    try {
      const value: unknown = JSON.parse(readFileSync(this.exitPath(id), 'utf8'));
      if (!isRecord(value)) return null;
      return {
        exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
        signal: typeof value.signal === 'number' ? value.signal : null,
        at: typeof value.at === 'number' ? value.at : 0,
      };
    } catch {
      return null;
    }
  }

  private cleanupLaunchArtifacts(id: string): void {
    removeFile(this.configPath(id));
    removeFile(this.socketPath(id));
    removeFile(this.exitPath(id));
  }

  private cleanupExitArtifacts(id: string): void {
    removeFile(this.configPath(id));
    removeFile(this.socketPath(id));
    removeFile(this.exitPath(id));
  }

  private cleanupAllArtifacts(id: string): void {
    this.cleanupExitArtifacts(id);
    removeFile(this.holderLogPath(id));
    removeFile(join(LOG_DIR, `${id}.log`));
    rmSync(join(ATTACHMENTS_DIR, id), { recursive: true, force: true });
  }

  private configPath(id: string): string {
    return join(SESSIONS_DIR, `${id}.config.json`);
  }

  private socketPath(id: string): string {
    return join(SESSIONS_DIR, `${id}.sock`);
  }

  private exitPath(id: string): string {
    return join(SESSIONS_DIR, `${id}.exit.json`);
  }

  private holderLogPath(id: string): string {
    return join(SESSIONS_DIR, `${id}.holder.log`);
  }

  private logHolderError(id: string, error: unknown): void {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    appendFileSync(this.holderLogPath(id), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  }

  async shutdown(): Promise<void> {
    if (KILL_ON_EXIT) {
      const pending = [...this.runtimes.keys()].map((id) => this.terminate(id));
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(pending),
        new Promise<void>((resolve) => {
          timeout = setTimeout(
            resolve,
            HOLDER_RECONNECT_ATTEMPTS * HOLDER_RECONNECT_DELAY_MS + FORCE_KILL_DELAY_MS + 2_000,
          );
        }),
      ]);
      if (timeout !== undefined) clearTimeout(timeout);
    }
    this.shuttingDown = true;
    for (const [id, runtime] of [...this.runtimes]) this.detachRuntime(id, runtime);
  }
}
