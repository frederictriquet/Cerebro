import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HOST = process.env.CEREBRO_HOST ?? '127.0.0.1';
export const PORT = Number(process.env.CEREBRO_PORT ?? 4317);
export const BIND_TOKEN = process.env.CEREBRO_BIND_TOKEN;
export const DATA_DIR = process.env.CEREBRO_DATA_DIR ?? join(homedir(), '.cerebro');
export const LOG_DIR = join(DATA_DIR, 'logs');
export const HOOK_SCRIPT = join(ROOT, 'bin', 'cerebro-hook.mjs');
// URL used by hook scripts (always local, even when the UI is exposed elsewhere).
export const INTERNAL_URL = `http://127.0.0.1:${PORT}`;

mkdirSync(LOG_DIR, { recursive: true });
export const HOOK_LOG = join(DATA_DIR, 'hooks.jsonl');
