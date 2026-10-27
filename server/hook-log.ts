import { appendFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { HOOK_LOG } from './config.ts';

// hooks.jsonl stores full payloads (including last_assistant_message): rotate it by size
// so it cannot grow without bound. Archives are hooks.jsonl.1 (newest) to hooks.jsonl.N.
export const HOOK_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const HOOK_LOG_KEEP = 3;

export interface HookLogLimits {
  maxBytes?: number;
  keep?: number;
}

export function appendHookLog(entry: unknown, path = HOOK_LOG, limits: HookLogLimits = {}): void {
  const maxBytes = limits.maxBytes ?? HOOK_LOG_MAX_BYTES;
  const keep = limits.keep ?? HOOK_LOG_KEEP;
  const line = `${JSON.stringify(entry)}\n`;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // Missing file: the append below creates it.
  }
  if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate(path, keep);
  appendFileSync(path, line, { mode: 0o600 });
}

function rotate(path: string, keep: number): void {
  if (keep < 1) {
    rmSync(path, { force: true });
    return;
  }
  rmSync(`${path}.${keep}`, { force: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    if (existsSync(`${path}.${index}`)) renameSync(`${path}.${index}`, `${path}.${index + 1}`);
  }
  renameSync(path, `${path}.1`);
}
