import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AGENTS } from './agents.ts';
import { DATA_DIR } from './config.ts';
import type { Agent } from './db.ts';

const execFileAsync = promisify(execFile);

// Each CLI installs a release in its own folder and only moves a link: updating while sessions
// run is safe, they keep their binary until relaunched.

export interface AgentUpdate {
  agent: Agent;
  installed: string | null;
  latest: string | null;
  available: boolean;
  auto: boolean;
  updating: boolean;
  /** Last check (ISO). */
  checkedAt: string | null;
  /** Outcome of the last `<cli> update`, kept until the next one. */
  lastRun: { at: string; ok: boolean; output: string } | null;
  error: string | null;
}

const SETTINGS_FILE = join(DATA_DIR, 'updates.json');
const CHECK_INTERVAL_MS = 60 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL = 2_000;

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Numeric comparison of x.y.z; a pre-release sorts before its release. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string): [number[], string] => {
    const [core = '', pre = ''] = v.split('-', 2);
    return [core.split('.').map(Number), pre];
  };
  const [a, preA] = parse(candidate);
  const [b, preB] = parse(current);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  if (preA === preB) return false;
  if (preA === '') return true;
  if (preB === '') return false;
  return preA > preB;
}

async function installedVersion(agent: Agent): Promise<string> {
  const { stdout } = await execFileAsync(agent, ['--version'], { timeout: COMMAND_TIMEOUT_MS });
  const match = VERSION.exec(stdout);
  if (match === null) throw new Error(`version illisible : ${stdout.trim().slice(0, 80)}`);
  return match[0];
}

async function npmDistTag(pkg: string, tag: string): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/-/package/${pkg}/dist-tags`, {
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`registre npm : HTTP ${res.status}`);
  const tags: unknown = await res.json();
  const version = isRecord(tags) ? tags[tag] : undefined;
  if (typeof version !== 'string') throw new Error(`registre npm : pas de tag ${tag} pour ${pkg}`);
  return version;
}

/** Channel followed by Claude Code's own updater (`autoUpdatesChannel`), "latest" by default. */
function claudeChannel(): string {
  try {
    const settings: unknown = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    if (isRecord(settings) && settings.autoUpdatesChannel === 'stable') return 'stable';
  } catch {
    // No settings file: default channel.
  }
  return 'latest';
}

async function grokLatest(): Promise<string> {
  const { stdout } = await execFileAsync('grok', ['update', '--check', '--json'], { timeout: COMMAND_TIMEOUT_MS });
  const result: unknown = JSON.parse(stdout);
  if (!isRecord(result)) throw new Error('sortie de `grok update --check` illisible');
  if (typeof result.error === 'string' && result.error !== '') throw new Error(result.error);
  if (typeof result.latestVersion !== 'string') throw new Error('sortie de `grok update --check` illisible');
  return result.latestVersion;
}

const LATEST: Record<Agent, () => Promise<string>> = {
  claude: () => npmDistTag('@anthropic-ai/claude-code', claudeChannel()),
  codex: () => npmDistTag('@openai/codex', 'latest'),
  grok: grokLatest,
};

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g, '');
}

function loadAuto(): Record<Agent, boolean> {
  const auto: Record<Agent, boolean> = { claude: false, codex: false, grok: false };
  if (!existsSync(SETTINGS_FILE)) return auto;
  try {
    const value: unknown = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    const saved = isRecord(value) && isRecord(value.auto) ? value.auto : {};
    for (const agent of AGENTS) if (typeof saved[agent] === 'boolean') auto[agent] = saved[agent];
  } catch (error) {
    console.error('[updates] réglages illisibles :', errorText(error));
  }
  return auto;
}

function initial(agent: Agent, auto: boolean): AgentUpdate {
  return {
    agent,
    installed: null,
    latest: null,
    available: false,
    auto,
    updating: false,
    checkedAt: null,
    lastRun: null,
    error: null,
  };
}

export class UpdateManager {
  private readonly state: Map<Agent, AgentUpdate>;
  private checking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    const auto = loadAuto();
    this.state = new Map(AGENTS.map((agent) => [agent, initial(agent, auto[agent])]));
  }

  /** First check right away, then hourly; auto-enabled CLIs are updated as soon as one is found. */
  start(): void {
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  list(): AgentUpdate[] {
    // Not checked yet, or not installed: nothing to show.
    return [...this.state.values()].filter((s) => s.checkedAt !== null).map((s) => ({ ...s }));
  }

  checkAll(): Promise<void> {
    this.checking ??= Promise.all(AGENTS.map((agent) => this.check(agent)))
      .then(() => this.autoUpdate())
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  setAuto(agent: Agent, auto: boolean): AgentUpdate {
    const current = this.get(agent);
    current.auto = auto;
    const saved = Object.fromEntries([...this.state.values()].map((s) => [s.agent, s.auto]));
    writeFileSync(SETTINGS_FILE, `${JSON.stringify({ auto: saved }, null, 2)}\n`);
    if (auto) void this.autoUpdate();
    return { ...current };
  }

  /** Starts `<cli> update` in the background; the state shows `updating` until it ends. */
  update(agent: Agent): AgentUpdate {
    const current = this.get(agent);
    if (!current.updating) void this.run(agent);
    return { ...current };
  }

  private get(agent: Agent): AgentUpdate {
    const current = this.state.get(agent);
    if (current === undefined) throw new Error(`Agent inconnu : ${agent}`);
    return current;
  }

  private async check(agent: Agent): Promise<void> {
    const current = this.get(agent);
    let installed: string;
    try {
      installed = await installedVersion(agent);
    } catch (cause) {
      const missing = (cause as NodeJS.ErrnoException).code === 'ENOENT';
      Object.assign(current, { installed: null, latest: null, available: false, checkedAt: missing ? null : new Date().toISOString(), error: errorText(cause) });
      return;
    }
    current.installed = installed;
    try {
      current.latest = await LATEST[agent]();
      current.error = null;
    } catch (cause) {
      current.error = `Vérification impossible : ${errorText(cause)}`;
    }
    current.available = current.latest !== null && isNewer(current.latest, installed);
    current.checkedAt = new Date().toISOString();
  }

  private async autoUpdate(): Promise<void> {
    await Promise.all([...this.state.values()]
      .filter((s) => s.auto && s.available && !s.updating)
      .map((s) => this.run(s.agent)));
  }

  private async run(agent: Agent): Promise<void> {
    const current = this.get(agent);
    current.updating = true;
    const before = current.installed;
    let ok = false;
    let output = '';
    try {
      const pending = execFileAsync(agent, ['update'], {
        timeout: UPDATE_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CODEX_NON_INTERACTIVE: '1' },
      });
      // No one to answer a prompt: an empty stdin makes it fail instead of hanging.
      pending.child.stdin?.end();
      const { stdout, stderr } = await pending;
      output = `${stdout}\n${stderr}`;
      ok = true;
    } catch (cause) {
      const failed = cause as { stdout?: string; stderr?: string; killed?: boolean };
      output = `${failed.stdout ?? ''}\n${failed.stderr ?? ''}\n${failed.killed === true ? 'Délai dépassé' : errorText(cause)}`;
    }
    await this.check(agent);
    // Exit 0 without a new version (e.g. a CLI that only reports) is not a success.
    if (ok && current.available) ok = false;
    const tail = stripAnsi(output).trim();
    current.lastRun = {
      at: new Date().toISOString(),
      ok,
      output: tail.length > OUTPUT_TAIL ? `…${tail.slice(-OUTPUT_TAIL)}` : tail,
    };
    current.updating = false;
    console.log(`[updates] ${agent} ${before ?? '?'} → ${current.installed ?? '?'} : ${ok ? 'ok' : 'échec'}`);
  }
}
