import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, openSync, closeSync, fstatSync, readSync, unlinkSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join } from 'node:path';
import { SerializeAddon } from '@xterm/addon-serialize';
import * as headlessPackage from '@xterm/headless';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { buildAgentCommand } from './agents.ts';
import { INTERNAL_URL, LOG_DIR } from './config.ts';
import type { Agent, Mode, Project, Session } from './db.ts';
import { CerebroDatabase } from './db.ts';

// @xterm/headless is CommonJS at runtime despite exposing ESM-shaped typings.
const Terminal = (headlessPackage as unknown as { default: typeof headlessPackage }).default.Terminal;

export type SessionEvent =
  | { type: 'session'; session: Session }
  | { type: 'session-deleted'; id: string }
  | { type: 'alert'; session: Session };

export type TerminalEvent =
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number };

interface Runtime {
  agent: Agent;
  pty: IPty;
  token: string;
  terminal: import('@xterm/headless').Terminal;
  serializer: SerializeAddon;
  log: WriteStream;
  terminalListeners: Set<(event: TerminalEvent) => void>;
  terminalClients: number;
  focusMode: boolean;
  oscTail: string;
  idleTimer: NodeJS.Timeout | null;
  screenTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  focusTimer: NodeJS.Timeout | null;
}

const IDLE_DELAY_MS = 20_000;
const SCREEN_CHECK_DELAY_MS = 2_000;
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
const FORCE_KILL_DELAY_MS = 3_000;
const FOCUS_OUT_DELAY_MS = 1_500;
const MAX_LOG_SNAPSHOT = 2 * 1024 * 1024;

function titleFor(agent: Agent, prompt: string): string {
  return prompt === '' ? `${agent} session` : prompt.slice(0, 60);
}

function ptyEnvironment(sessionId: string, token: string): Record<string, string | undefined> {
  const env = { ...process.env };
  // Strip markers that make a CLI think it runs nested inside another agent session
  // (e.g. when Cerebro itself is started from Claude Code): they disable transcripts/resume.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT' || key === 'GROK_READ_ONLY_SANDBOX'
      || /^CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|EXECPATH|MESSAGING_)/.test(key)) {
      delete env[key];
    }
  }
  return {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CEREBRO_SESSION_ID: sessionId,
    CEREBRO_TOKEN: token,
    CEREBRO_URL: INTERNAL_URL,
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
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export class SessionManager {
  readonly db: CerebroDatabase;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly eventListeners = new Set<(event: SessionEvent) => void>();
  private readonly shutdownWaiters = new Set<() => void>();

  constructor(db: CerebroDatabase) {
    this.db = db;
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  create(project: Project, agent: Agent, mode: Mode, prompt: string): Session {
    return this.launch(project, agent, mode, prompt, null);
  }

  resume(id: string): Session {
    const oldSession = this.db.getSession(id);
    if (oldSession === null) throw new Error('Session introuvable');
    if (oldSession.status !== 'exited') throw new Error("La session n'est pas terminée");
    if (oldSession.agentSessionId === null) throw new Error("Cette session ne peut pas être reprise");
    const project = this.db.getProject(oldSession.projectId);
    if (project === null) throw new Error('Projet introuvable');
    return this.launch(project, oldSession.agent, oldSession.mode, '', oldSession.agentSessionId, oldSession.id);
  }

  private launch(
    project: Project,
    agent: Agent,
    mode: Mode,
    prompt: string,
    resumeSessionId: string | null,
    existingId: string | null = null,
  ): Session {
    const id = existingId ?? randomUUID();
    const command = buildAgentCommand(agent, mode, prompt, id, resumeSessionId);
    let session: Session;
    if (existingId === null) {
      session = this.db.createSession({
        id,
        projectId: project.id,
        agent,
        mode,
        prompt,
        title: titleFor(agent, prompt),
        status: 'starting',
        agentSessionId: command.agentSessionId,
      });
    } else {
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

    const token = randomBytes(32).toString('hex');
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 120,
      rows: 32,
      scrollback: 5000,
    });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    const log = createWriteStream(join(LOG_DIR, `${id}.log`), { flags: 'a' });

    let child: IPty;
    try {
      child = pty.spawn(command.cmd, command.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: project.path,
        env: ptyEnvironment(id, token),
      });
    } catch (error) {
      terminal.dispose();
      log.end();
      const failed = this.db.updateSession(id, {
        status: 'exited',
        attention: false,
        attentionReason: null,
        exitCode: 1,
      });
      if (failed !== null) this.emit({ type: 'session', session: failed });
      throw error;
    }

    const runtime: Runtime = {
      agent,
      pty: child,
      token,
      terminal,
      serializer,
      log,
      terminalListeners: new Set(),
      terminalClients: 0,
      focusMode: false,
      oscTail: '',
      idleTimer: null,
      screenTimer: null,
      killTimer: null,
      focusTimer: null,
    };
    this.runtimes.set(id, runtime);

    child.onData((data) => this.handleOutput(id, data));
    child.onExit(({ exitCode }) => this.handleExit(id, exitCode));

    const running = this.db.updateSession(id, { status: 'running' });
    if (running !== null) {
      session = running;
      this.emit({ type: 'session', session });
    }
    this.scheduleIdleCheck(id);
    runtime.focusTimer = setTimeout(() => {
      runtime.focusTimer = null;
      if (runtime.focusMode && this.runtimes.get(id) === runtime) runtime.pty.write('\x1b[O');
    }, FOCUS_OUT_DELAY_MS);
    return session;
  }

  private handleOutput(id: string, data: string): void {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return;
    runtime.log.write(data);
    runtime.terminal.write(data);
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
    this.setReliableState(id, waiting ? 'waiting' : 'idle', message || (waiting ? 'Permission demandée' : 'Tour terminé'));
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

  private inspectScreen(id: string, runtime: Runtime): void {
    const session = this.db.getSession(id);
    if (session === null || session.status === 'exited' || session.status === 'waiting') return;
    const lines = this.visibleLines(runtime, 60);
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

  setReliableState(id: string, status: 'waiting' | 'idle', reason: string): Session | null {
    const session = this.db.getSession(id);
    if (session === null || session.status === 'exited') return null;
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

  setRunning(id: string): Session | null {
    const session = this.db.getSession(id);
    if (session === null || session.status === 'exited') return null;
    if (session.status === 'running') return session;
    const updated = this.db.updateSession(id, { status: 'running' });
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
    const runtime = this.runtimes.get(id);
    return runtime !== undefined && token !== undefined && token === runtime.token;
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

  writeInput(id: string, data: string): boolean {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return false;
    runtime.pty.write(data);
    const session = this.db.getSession(id);
    if (data.includes('\r') && (session?.status === 'waiting' || session?.status === 'idle')) this.setRunning(id);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return false;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return false;
    runtime.pty.resize(cols, rows);
    runtime.terminal.resize(cols, rows);
    return true;
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
        runtime.pty.write('\x1b[O');
      }
    };
  }

  kill(id: string): boolean {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return false;
    try {
      runtime.pty.kill('SIGTERM');
    } catch {
      return false;
    }
    if (runtime.killTimer !== null) clearTimeout(runtime.killTimer);
    runtime.killTimer = setTimeout(() => {
      runtime.killTimer = null;
      if (this.runtimes.get(id) !== runtime) return;
      try {
        runtime.pty.kill('SIGKILL');
      } catch {
        // The PTY may have exited between the map check and kill().
      }
    }, FORCE_KILL_DELAY_MS);
    return true;
  }

  killProject(projectId: string): void {
    for (const session of this.db.listProjectSessions(projectId)) this.kill(session.id);
  }

  deleteProject(projectId: string): boolean {
    const project = this.db.getProject(projectId);
    if (project === null) return false;
    const projectSessions = this.db.listProjectSessions(projectId);
    for (const session of projectSessions) this.kill(session.id);
    this.db.deleteProject(projectId);
    for (const session of projectSessions) {
      try {
        unlinkSync(join(LOG_DIR, `${session.id}.log`));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      this.emit({ type: 'session-deleted', id: session.id });
    }
    return true;
  }

  delete(id: string): boolean {
    const existed = this.db.getSession(id) !== null;
    if (!existed) return false;
    this.kill(id);
    this.db.deleteSession(id);
    try {
      unlinkSync(join(LOG_DIR, `${id}.log`));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    this.emit({ type: 'session-deleted', id });
    return true;
  }

  private handleExit(id: string, exitCode: number): void {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return;
    this.runtimes.delete(id);
    if (runtime.idleTimer !== null) clearTimeout(runtime.idleTimer);
    if (runtime.screenTimer !== null) clearTimeout(runtime.screenTimer);
    if (runtime.killTimer !== null) clearTimeout(runtime.killTimer);
    if (runtime.focusTimer !== null) clearTimeout(runtime.focusTimer);
    runtime.log.end();
    runtime.terminal.dispose();
    const updated = this.db.updateSession(id, {
      status: 'exited',
      exitCode,
      attention: false,
      attentionReason: null,
    });
    if (updated !== null) this.emit({ type: 'session', session: updated });
    for (const listener of runtime.terminalListeners) listener({ type: 'exit', exitCode });
    if (this.runtimes.size === 0) {
      for (const resolve of this.shutdownWaiters) resolve();
      this.shutdownWaiters.clear();
    }
  }

  async shutdown(): Promise<void> {
    if (this.runtimes.size === 0) return;

    let resolveExited = (): void => {};
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
      this.shutdownWaiters.add(resolve);
    });
    for (const id of [...this.runtimes.keys()]) this.kill(id);

    let deadline: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, FORCE_KILL_DELAY_MS + 500);
    });
    await Promise.race([exited, timedOut]);
    if (deadline !== undefined) clearTimeout(deadline);
    this.shutdownWaiters.delete(resolveExited);

    // A broken PTY must not prevent the server from closing its database forever.
    for (const [id, runtime] of this.runtimes) {
      this.runtimes.delete(id);
      if (runtime.idleTimer !== null) clearTimeout(runtime.idleTimer);
      if (runtime.screenTimer !== null) clearTimeout(runtime.screenTimer);
      if (runtime.killTimer !== null) clearTimeout(runtime.killTimer);
      if (runtime.focusTimer !== null) clearTimeout(runtime.focusTimer);
      try {
        runtime.pty.kill('SIGKILL');
      } catch {
        // The process may have exited just before the forced shutdown.
      }
      runtime.log.end();
      runtime.terminal.dispose();
      this.db.updateSession(id, {
        status: 'exited',
        attention: false,
        attentionReason: null,
      });
    }
  }
}
