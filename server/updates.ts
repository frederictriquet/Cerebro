import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR } from './config.ts';
import { AGENTS, type Agent } from '../shared/types.ts';
import type { AgentUpdate } from '../shared/machine.ts';
import { errorMessage, isRecord } from './util.ts';

const execFileAsync = promisify(execFile);

// Each CLI installs a release in its own folder and only moves a link: updating while sessions
// run is safe, they keep their binary until relaunched.

const SETTINGS_FILE = join(DATA_DIR, 'updates.json');
const CHECK_INTERVAL_MS = 60 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL = 2_000;

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

/** Semver precedence: numeric x.y.z, then pre-release identifiers (a pre-release sorts before its release). */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string): [number[], string[]] => {
    const version = v.split('+', 1)[0] ?? '';
    const dash = version.indexOf('-');
    const core = dash === -1 ? version : version.slice(0, dash);
    const pre = dash === -1 ? '' : version.slice(dash + 1);
    return [core.split('.').map(Number), pre === '' ? [] : pre.split('.')];
  };
  const [a, preA] = parse(candidate);
  const [b, preB] = parse(current);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  if (preA.length === 0 || preB.length === 0) return preA.length === 0 && preB.length > 0;
  const numeric = /^\d+$/;
  for (let i = 0; i < Math.max(preA.length, preB.length); i += 1) {
    const x = preA[i];
    const y = preB[i];
    // A larger set of identifiers wins when all preceding ones are equal.
    if (x === undefined) return false;
    if (y === undefined) return true;
    if (x === y) continue;
    const xNum = numeric.test(x);
    const yNum = numeric.test(y);
    if (xNum && yNum) return Number(x) > Number(y);
    // Numeric identifiers sort before alphanumeric ones.
    if (xNum !== yNum) return yNum;
    return x > y;
  }
  return false;
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
    console.error('[updates] réglages illisibles :', errorMessage(error));
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
      Object.assign(current, { installed: null, latest: null, available: false, checkedAt: missing ? null : new Date().toISOString(), error: errorMessage(cause) });
      return;
    }
    current.installed = installed;
    try {
      current.latest = await LATEST[agent]();
      current.error = null;
    } catch (cause) {
      current.error = `Vérification impossible : ${errorMessage(cause)}`;
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
        // Codex's own switch for unattended runs: only its process gets it.
        env: agent === 'codex' ? { ...process.env, CODEX_NON_INTERACTIVE: '1' } : process.env,
      });
      // No one to answer a prompt: an empty stdin makes any CLI fail instead of hanging.
      pending.child.stdin?.end();
      const { stdout, stderr } = await pending;
      output = `${stdout}\n${stderr}`;
      ok = true;
    } catch (cause) {
      const failed = cause as { stdout?: string; stderr?: string; killed?: boolean };
      output = `${failed.stdout ?? ''}\n${failed.stderr ?? ''}\n${failed.killed === true ? 'Délai dépassé' : errorMessage(cause)}`;
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
