import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, mkdirSync } from 'node:fs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HOST = process.env.CEREBRO_HOST ?? '127.0.0.1';
export const PORT = Number(process.env.CEREBRO_PORT ?? 4317);
export const BIND_TOKEN = process.env.CEREBRO_BIND_TOKEN;
export const KILL_ON_EXIT = process.env.CEREBRO_KILL_ON_EXIT === '1';
export const DATA_DIR = process.env.CEREBRO_DATA_DIR ?? join(homedir(), '.cerebro');
export const LOG_DIR = join(DATA_DIR, 'logs');
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
export const ATTACHMENTS_DIR = join(DATA_DIR, 'attachments');
export const HOOK_SCRIPT = join(ROOT, 'bin', 'cerebro-hook.mjs');
// URL used by hook scripts (always local, even when the UI is exposed elsewhere).
export const INTERNAL_URL = `http://127.0.0.1:${PORT}`;

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
chmodSync(SESSIONS_DIR, 0o700);
export const HOOK_LOG = join(DATA_DIR, 'hooks.jsonl');
