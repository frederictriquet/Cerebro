import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from './db.ts';

export interface UsageWindow {
  label: string;
  /** 0-100 */
  percent: number;
  /** Window length, to show how much of it has elapsed. */
  minutes: number | null;
  /** ISO date, null when unknown. */
  resetsAt: string | null;
}

export interface AgentUsage {
  agent: Agent;
  windows: UsageWindow[];
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

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

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

async function fetchClaude(): Promise<AgentUsage> {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const credentials = record(JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8')));
  const oauth = record(credentials?.claudeAiOauth);
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
  return { agent: 'claude', windows, updatedAt: new Date().toISOString(), error: null };
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
        for (const name of readdirSync(dir)) {
          if (name.endsWith('.jsonl')) files.push({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs });
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
function readCodex(): AgentUsage {
  let latest: { timestamp: string; limits: Record<string, unknown> } | null = null;
  // Newest rollout first: the first rate_limits event found from the end is the latest one.
  for (const path of codexRollouts()) {
    const lines = readTail(path).split('\n');
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
  if (latest === null) return { agent: 'codex', windows: [], updatedAt: null, error: 'Aucune session Codex récente' };
  const windows = [codexWindow(latest.limits.primary), codexWindow(latest.limits.secondary)]
    .filter((w): w is UsageWindow => w !== null);
  return { agent: 'codex', windows, updatedAt: latest.timestamp, error: null };
}

const GROK_USAGE: AgentUsage = {
  agent: 'grok',
  windows: [],
  updatedAt: null,
  error: "Compte d'équipe xAI : aucun quota publié (même /usage dans grok n'en affiche pas)",
};

export class UsageTracker {
  private claude: AgentUsage = { agent: 'claude', windows: [], updatedAt: null, error: 'Chargement…' };
  private claudeFetchedAt = 0;
  private claudePending: Promise<void> | null = null;
  private codex: AgentUsage = { agent: 'codex', windows: [], updatedAt: null, error: 'Chargement…' };
  private codexReadAt = 0;

  async get(): Promise<AgentUsage[]> {
    const now = Date.now();
    if (now - this.claudeFetchedAt >= CLAUDE_MIN_INTERVAL_MS) {
      this.claudeFetchedAt = now;
      this.claudePending = fetchClaude()
        .then((usage) => {
          this.claude = usage;
        })
        .catch((cause: unknown) => {
          // Keep the last good figures and say why they are not refreshed.
          this.claude = { ...this.claude, error: errorText(cause) };
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
        this.codex = { ...this.codex, error: errorText(cause) };
      }
    }

    return [this.claude, this.codex, GROK_USAGE].map((usage) => ({
      ...usage,
      windows: usage.windows.map((w) => freshen(w, now)),
    }));
  }
}
