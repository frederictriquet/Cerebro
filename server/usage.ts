import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Agent } from '../shared/types.ts';
import type { AgentAuth, AgentUsage, UsageWindow } from '../shared/machine.ts';
import { codexHome, listCodexRollouts } from './codex-config.ts';
import { readJsonlTail } from './jsonl.ts';
import { asRecord, errorMessage } from './util.ts';

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
    const payload = asRecord(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')));
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
  const auth = asRecord(JSON.parse(readFileSync(join(codexHome(), 'auth.json'), 'utf8')));
  const tokens = asRecord(auth?.tokens);
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
  const auth = asRecord(JSON.parse(readFileSync(join(homedir(), '.grok', 'auth.json'), 'utf8')));
  let latest: AgentAuth | null = null;
  for (const value of Object.values(auth ?? {})) {
    const entry = asRecord(value);
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
  const body = asRecord(await res.json());
  const windows: UsageWindow[] = [];
  for (const [key, label, minutes] of CLAUDE_WINDOWS) {
    const entry = asRecord(body?.[key]);
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

// Rollouts of the most recent days, ordered by last write.
async function codexRollouts(): Promise<string[]> {
  const files = (await listCodexRollouts(undefined, CODEX_MAX_FILES)).map((path) => ({ path, mtime: statSync(path).mtimeMs }));
  return files.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
}

function codexWindow(value: unknown): UsageWindow | null {
  const entry = asRecord(value);
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
async function readCodex(): Promise<AgentUsage> {
  let latest: { timestamp: string; limits: Record<string, unknown> } | null = null;
  // Newest rollout first: the first rate_limits event found from the end is the latest one.
  for (const path of await codexRollouts()) {
    for (const record of readJsonlTail(path, CODEX_TAIL_BYTES, '"rate_limits"')) {
      const event = asRecord(record);
      const limits = asRecord(asRecord(event?.payload)?.rate_limits);
      if (limits !== null && typeof event?.timestamp === 'string') {
        latest = { timestamp: event.timestamp, limits };
        break;
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
          const oauth = asRecord(asRecord(JSON.parse(raw))?.claudeAiOauth);
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
        this.codex = await readCodex();
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
