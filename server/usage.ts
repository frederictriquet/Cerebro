import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Agent } from './db.ts';
import { errorMessage } from './errors.ts';

export interface UsageWindow {
  label: string;
  /** 0-100 */
  percent: number;
  /** Window length, to show how much of it has elapsed. */
  minutes: number | null;
  /** ISO date, null when unknown. */
  resetsAt: string | null;
}

/** When the CLI's login lapses, read from its credentials file (no token leaves the server). */
export interface AgentAuth {
  /** Date a new login will be required (ISO), when the CLI records it: only Claude does. */
  loginExpiresAt: string | null;
  /** Access token expiry (ISO): the CLI renews it by itself the next time it runs. */
  accessExpiresAt: string | null;
  /** Last login or token renewal (ISO), when known. */
  renewedAt: string | null;
  error: string | null;
}

export interface AgentUsage {
  agent: Agent;
  windows: UsageWindow[];
  auth: AgentAuth | null;
  /** When the figures were measured (ISO); for Codex, the last time it ran. */
  updatedAt: string | null;
  error: string | null;
}

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// The endpoint is rate limited: never query it more often than this.
const CLAUDE_MIN_INTERVAL_MS = 2 * 60_000;
const CODEX_MIN_INTERVAL_MS = 30_000;
const CODEX_MAX_FILES = 30;
const CODEX_TAIL_BYTES = 512 * 1024;

const CLAUDE_WINDOWS: readonly [key: string, label: string, minutes: number][] = [
  ['five_hour', '5 h', 300],
  ['seven_day', 'Semaine', 10_080],
  ['seven_day_opus', 'Semaine Opus', 10_080],
  ['seven_day_sonnet', 'Semaine Sonnet', 10_080],
];


function windowLabel(minutes: number): string {
  if (minutes === 300) return '5 h';
  if (minutes === 10_080) return 'Semaine';
  if (minutes % 1_440 === 0) return `${minutes / 1_440} j`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** A window whose reset date has passed starts over at 0 %. */
function freshen(window: UsageWindow, now: number): UsageWindow {
  if (window.resetsAt !== null && Date.parse(window.resetsAt) <= now) return { ...window, percent: 0, resetsAt: null };
  return window;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const execFileAsync = promisify(execFile);

/**
 * Claude Code's OAuth credentials: a file on Linux, the login Keychain on macOS (service
 * "Claude Code-credentials", suffixed with a hash of CLAUDE_CONFIG_DIR when that is set).
 */
async function readClaudeCredentials(): Promise<string> {
  const customDir = process.env.CLAUDE_CONFIG_DIR;
  const configDir = customDir ?? join(homedir(), '.claude');
  try {
    return readFileSync(join(configDir, '.credentials.json'), 'utf8');
  } catch (cause) {
    if (process.platform !== 'darwin') throw cause;
  }
  const service = 'Claude Code-credentials';
  const services = customDir === undefined
    ? [service]
    : [`${service}-${createHash('sha256').update(customDir).digest('hex').slice(0, 8)}`, service];
  for (const name of services) {
    try {
      const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', name, '-w'], { timeout: 10_000 });
      if (stdout.trim() !== '') return stdout;
    } catch {
      // Try the next service name.
    }
  }
  throw new Error('Identifiants Claude introuvables dans le trousseau macOS');
}

function isoFromMillis(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function isoFromString(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** Expiry of a JWT, read from its payload without checking the signature (display only). */
function jwtExpiry(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  try {
    const payload = record(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')));
    return typeof payload?.exp === 'number' ? isoFromMillis(payload.exp * 1_000) : null;
  } catch {
    return null;
  }
}

function claudeAuth(oauth: Record<string, unknown> | null): AgentAuth {
  return {
    loginExpiresAt: isoFromMillis(oauth?.refreshTokenExpiresAt),
    accessExpiresAt: isoFromMillis(oauth?.expiresAt),
    renewedAt: null,
    error: oauth === null ? 'Pas de connexion OAuth Claude' : null,
  };
}

function readCodexAuth(): AgentAuth {
  const auth = record(JSON.parse(readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'), 'utf8')));
  const tokens = record(auth?.tokens);
  if (tokens === null) {
    const apiKey = typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY !== '';
    return { loginExpiresAt: null, accessExpiresAt: null, renewedAt: null, error: apiKey ? null : 'Pas de connexion Codex' };
  }
  return {
    loginExpiresAt: null,
    accessExpiresAt: jwtExpiry(tokens.access_token),
    renewedAt: isoFromString(auth?.last_refresh),
    error: null,
  };
}

/** ~/.grok/auth.json maps "<issuer>::<id>" to a login: take the most recently renewed one. */
function readGrokAuth(): AgentAuth {
  const auth = record(JSON.parse(readFileSync(join(homedir(), '.grok', 'auth.json'), 'utf8')));
  let latest: AgentAuth | null = null;
  for (const value of Object.values(auth ?? {})) {
    const entry = record(value);
    if (entry === null) continue;
    const candidate: AgentAuth = {
      loginExpiresAt: null,
      accessExpiresAt: isoFromString(entry.expires_at) ?? jwtExpiry(entry.key),
      renewedAt: isoFromString(entry.create_time),
      error: null,
    };
    if (latest === null || (candidate.renewedAt ?? '') > (latest.renewedAt ?? '')) latest = candidate;
  }
  return latest ?? { loginExpiresAt: null, accessExpiresAt: null, renewedAt: null, error: 'Pas de connexion Grok' };
}

function readAuth(read: () => AgentAuth): AgentAuth {
  try {
    return read();
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException).code === 'ENOENT';
    return { loginExpiresAt: null, accessExpiresAt: null, renewedAt: null, error: missing ? 'Non connecté' : errorMessage(cause) };
  }
}

async function fetchClaude(oauth: Record<string, unknown> | null): Promise<AgentUsage> {
  const token = oauth?.accessToken;
  if (typeof token !== 'string') throw new Error('Pas de connexion OAuth Claude');
  if (typeof oauth?.expiresAt === 'number' && oauth.expiresAt < Date.now()) {
    throw new Error('Jeton Claude expiré : lancez une session claude pour le renouveler');
  }

  const res = await fetch(CLAUDE_USAGE_URL, {
    headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`API Claude : HTTP ${res.status}`);
  const body = record(await res.json());
  const windows: UsageWindow[] = [];
  for (const [key, label, minutes] of CLAUDE_WINDOWS) {
    const entry = record(body?.[key]);
    if (entry === null || typeof entry.utilization !== 'number') continue;
    windows.push({
      label,
      percent: clampPercent(entry.utilization),
      minutes,
      resetsAt: typeof entry.resets_at === 'string' ? entry.resets_at : null,
    });
  }
  return { agent: 'claude', windows, auth: null, updatedAt: new Date().toISOString(), error: null };
}

/** Runs a filesystem read, returning null when the entry vanished in the meantime (ENOENT). */
function ignoreMissing<T>(read: () => T): T | null {
  try {
    return read();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}

function codexRollouts(): string[] {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  const subdirs = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((name) => /^\d+$/.test(name)).sort().reverse();
    } catch {
      return [];
    }
  };
  // sessions/YYYY/MM/DD/rollout-*.jsonl: gather the most recent days, then order by last write
  // (a resumed session keeps writing into the directory of the day it started).
  const files: { path: string; mtime: number }[] = [];
  for (const year of subdirs(root)) {
    for (const month of subdirs(join(root, year))) {
      for (const day of subdirs(join(root, year, month))) {
        const dir = join(root, year, month, day);
        for (const name of ignoreMissing(() => readdirSync(dir)) ?? []) {
          if (!name.endsWith('.jsonl')) continue;
          // Codex may delete or rename a rollout while we scan: skip it rather than fail the whole read.
          const mtime = ignoreMissing(() => statSync(join(dir, name)).mtimeMs);
          if (mtime !== null) files.push({ path: join(dir, name), mtime });
        }
        if (files.length >= CODEX_MAX_FILES) return files.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
}

function readTail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const length = Math.min(size, CODEX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function codexWindow(value: unknown): UsageWindow | null {
  const entry = record(value);
  if (entry === null || typeof entry.used_percent !== 'number') return null;
  const minutes = typeof entry.window_minutes === 'number' ? entry.window_minutes : null;
  return {
    label: minutes === null ? 'Limite' : windowLabel(minutes),
    percent: clampPercent(entry.used_percent),
    minutes,
    resetsAt: typeof entry.resets_at === 'number' ? new Date(entry.resets_at * 1_000).toISOString() : null,
  };
}

/** Codex only reports its limits inside session rollouts: take the latest token_count event. */
export function readCodex(): AgentUsage {
  let latest: { timestamp: string; limits: Record<string, unknown> } | null = null;
  // Newest rollout first: the first rate_limits event found from the end is the latest one.
  for (const path of codexRollouts()) {
    const tail = ignoreMissing(() => readTail(path));
    if (tail === null) continue;
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0 && latest === null; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      try {
        const event = record(JSON.parse(lines[i]));
        const limits = record(record(event?.payload)?.rate_limits);
        if (limits !== null && typeof event?.timestamp === 'string') latest = { timestamp: event.timestamp, limits };
      } catch {
        // Truncated first line of the tail: keep looking.
      }
    }
    if (latest !== null) break;
  }
  if (latest === null) return { agent: 'codex', windows: [], auth: null, updatedAt: null, error: 'Aucune session Codex récente' };
  const windows = [codexWindow(latest.limits.primary), codexWindow(latest.limits.secondary)]
    .filter((w): w is UsageWindow => w !== null);
  return { agent: 'codex', windows, auth: null, updatedAt: latest.timestamp, error: null };
}

const GROK_USAGE: AgentUsage = {
  agent: 'grok',
  windows: [],
  auth: null,
  updatedAt: null,
  error: "Compte d'équipe xAI : aucun quota publié (même /usage dans grok n'en affiche pas)",
};

export class UsageTracker {
  private claude: AgentUsage = { agent: 'claude', windows: [], auth: null, updatedAt: null, error: 'Chargement…' };
  private claudeAuth: AgentAuth | null = null;
  private claudeFetchedAt = 0;
  private claudePending: Promise<void> | null = null;
  private codex: AgentUsage = { agent: 'codex', windows: [], auth: null, updatedAt: null, error: 'Chargement…' };
  private codexReadAt = 0;
  private codexAuth: AgentAuth | null = null;
  private grokAuth: AgentAuth | null = null;

  async get(): Promise<AgentUsage[]> {
    const now = Date.now();
    if (now - this.claudeFetchedAt >= CLAUDE_MIN_INTERVAL_MS) {
      this.claudeFetchedAt = now;
      this.claudePending = readClaudeCredentials()
        .then(async (raw) => {
          const oauth = record(record(JSON.parse(raw))?.claudeAiOauth);
          this.claudeAuth = claudeAuth(oauth);
          this.claude = await fetchClaude(oauth);
        })
        .catch((cause: unknown) => {
          // Keep the last good figures and say why they are not refreshed.
          this.claude = { ...this.claude, error: errorMessage(cause) };
          this.claudeAuth ??= { loginExpiresAt: null, accessExpiresAt: null, renewedAt: null, error: errorMessage(cause) };
        })
        .finally(() => {
          this.claudePending = null;
        });
    }
    if (this.claudePending !== null) await this.claudePending;

    if (now - this.codexReadAt >= CODEX_MIN_INTERVAL_MS) {
      this.codexReadAt = now;
      try {
        this.codex = readCodex();
      } catch (cause) {
        this.codex = { ...this.codex, error: errorMessage(cause) };
      }
      this.codexAuth = readAuth(readCodexAuth);
      this.grokAuth = readAuth(readGrokAuth);
    }

    const auth: Record<Agent, AgentAuth | null> = { claude: this.claudeAuth, codex: this.codexAuth, grok: this.grokAuth };
    return [this.claude, this.codex, GROK_USAGE].map((usage) => ({
      ...usage,
      auth: auth[usage.agent],
      windows: usage.windows.map((w) => freshen(w, now)),
    }));
  }
}
