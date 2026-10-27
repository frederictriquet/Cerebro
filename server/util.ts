import { unlinkSync } from 'node:fs';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

// The text shown to users and stored for an error: never the "Error: " prefix String() would add.
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function isEnoent(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

// Rethrows anything but a missing file.
export function ignoreEnoent(cause: unknown): void {
  if (!isEnoent(cause)) throw cause;
}

export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    ignoreEnoent(error);
  }
}
