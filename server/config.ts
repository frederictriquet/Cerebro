import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Optional secrets file (e.g. Slack token) so they stay out of the shell profile and the repo.
const ENV_FILE = join(process.env.CEREBRO_DATA_DIR ?? join(homedir(), '.cerebro'), 'env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HOST = process.env.CEREBRO_HOST ?? '127.0.0.1';
export const PORT = Number(process.env.CEREBRO_PORT ?? 4317);
export const BIND_TOKEN = process.env.CEREBRO_BIND_TOKEN;
export const KILL_ON_EXIT = process.env.CEREBRO_KILL_ON_EXIT === '1';
export const DATA_DIR = process.env.CEREBRO_DATA_DIR ?? join(homedir(), '.cerebro');
export const MACHINE_NAME = process.env.CEREBRO_MACHINE_NAME ?? hostname();
export const LOG_DIR = join(DATA_DIR, 'logs');
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
export const ATTACHMENTS_DIR = join(DATA_DIR, 'attachments');
export const REMOTES_FILE = join(DATA_DIR, 'remotes.json');
export const HOOK_SCRIPT = join(ROOT, 'bin', 'cerebro-hook.mjs');
export const SLACK_TOKEN = process.env.CEREBRO_SLACK_TOKEN;
export const SLACK_USER = process.env.CEREBRO_SLACK_USER;
// Overridable for tests against a fake Slack API.
export const SLACK_API_URL = process.env.CEREBRO_SLACK_API_URL ?? 'https://slack.com/api';
export const SLACK_ALERTS = process.env.CEREBRO_SLACK_ALERTS ?? 'all';
export const SLACK_DELAY_MS = Number(process.env.CEREBRO_SLACK_DELAY ?? 30) * 1_000;
export const SLACK_ENABLED = SLACK_TOKEN !== undefined && SLACK_USER !== undefined;
export const PUBLIC_URL = process.env.CEREBRO_PUBLIC_URL ?? `http://${HOST}:${PORT}`;
// URL used by hook scripts (always local, even when the UI is exposed elsewhere).
export const INTERNAL_URL = `http://127.0.0.1:${PORT}`;

export interface RemoteMachine {
  id: string;
  name: string;
  url: string;
  token?: string;
}

const REMOTE_ID = /^[a-z0-9-]{1,32}$/;

export function loadRemotes(): RemoteMachine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(REMOTES_FILE, 'utf8')) as unknown;
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.warn(`[remotes] Impossible de lire ${REMOTES_FILE}:`, caught instanceof Error ? caught.message : caught);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[remotes] ${REMOTES_FILE} doit contenir un tableau`);
    return [];
  }

  const remotes: RemoteMachine[] = [];
  const ids = new Set<string>();
  for (const [index, value] of parsed.entries()) {
    const warn = (reason: string): void => console.warn(`[remotes] Entrée ${index + 1} ignorée: ${reason}`);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      warn('objet attendu');
      continue;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || !REMOTE_ID.test(record.id) || record.id === 'local') {
      warn('id invalide');
      continue;
    }
    if (ids.has(record.id)) {
      warn(`id dupliqué: ${record.id}`);
      continue;
    }
    if (record.name !== undefined && typeof record.name !== 'string') {
      warn('name invalide');
      continue;
    }
    if (record.token !== undefined && typeof record.token !== 'string') {
      warn('token invalide');
      continue;
    }
    if (typeof record.url !== 'string') {
      warn('url invalide');
      continue;
    }
    let url: URL;
    try {
      url = new URL(record.url);
    } catch {
      warn('url invalide');
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      warn('url non HTTP(S)');
      continue;
    }

    ids.add(record.id);
    remotes.push({
      id: record.id,
      name: record.name ?? record.id,
      url: url.toString().replace(/\/$/, ''),
      ...(record.token === undefined ? {} : { token: record.token }),
    });
  }
  return remotes;
}

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
chmodSync(SESSIONS_DIR, 0o700);
export const HOOK_LOG = join(DATA_DIR, 'hooks.jsonl');
