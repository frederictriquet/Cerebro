import { appendFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SerializeAddon } from '@xterm/addon-serialize';
import * as headlessPackage from '@xterm/headless';
import { isRecord } from './util.ts';

// Shared between the server (sessions.ts) and the detached holder process (holder.ts): the holder
// imports nothing from config.ts, so every path here derives from the sessions directory.

// @xterm/headless is CommonJS at runtime despite exposing ESM-shaped typings.
const Terminal = (headlessPackage as unknown as { default: typeof headlessPackage }).default.Terminal;

export interface HolderConfig {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
}

/** Fields read back by the server; the holder also writes `signal` and `at`, kept for diagnosis only. */
export interface ExitRecord {
  exitCode: number | null;
}

/** Server → holder, one JSON object per line. */
export type ClientMessage =
  { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number } | { type: 'kill'; signal: string };

/** Holder → server, one JSON object per line. */
export type HolderMessage =
  | { type: 'hello'; pid: number; cols: number; rows: number }
  | { type: 'snapshot'; data: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number; signal: number | undefined };

export interface HolderPaths {
  config: string;
  socket: string;
  exit: string;
  holderLog: string;
}

const CONFIG_SUFFIX = '.config.json';

export function holderPaths(sessionsDir: string, id: string): HolderPaths {
  return {
    config: join(sessionsDir, `${id}${CONFIG_SUFFIX}`),
    socket: join(sessionsDir, `${id}.sock`),
    exit: join(sessionsDir, `${id}.exit.json`),
    holderLog: join(sessionsDir, `${id}.holder.log`),
  };
}

/** The holder receives its config path as sole argument: the sessions directory and id derive from it. */
export function parseConfigPath(configPath: string): { sessionsDir: string; id: string } {
  return { sessionsDir: dirname(configPath), id: basename(configPath, CONFIG_SUFFIX) };
}

export function isHolderConfig(value: unknown): value is HolderConfig {
  if (!isRecord(value)) return false;
  const config = value;
  return (
    typeof config.cmd === 'string' &&
    Array.isArray(config.args) &&
    config.args.every((argument) => typeof argument === 'string') &&
    typeof config.cwd === 'string' &&
    isRecord(config.env) &&
    Number.isInteger(config.cols) &&
    Number(config.cols) > 0 &&
    Number.isInteger(config.rows) &&
    Number(config.rows) > 0
  );
}

export function encodeMessage(message: ClientMessage | HolderMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function writeExitRecord(path: string, exitCode: number, signal: number | undefined): void {
  writeFileSync(path, `${JSON.stringify({ exitCode, signal, at: Date.now() })}\n`, { mode: 0o600 });
}

export function appendHolderLog(path: string, error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  appendFileSync(path, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
}

export function createTerminal(
  cols = 120,
  rows = 32,
): {
  terminal: import('@xterm/headless').Terminal;
  serializer: SerializeAddon;
} {
  const terminal = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 5000 });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  return { terminal, serializer };
}
