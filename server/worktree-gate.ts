import { resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

export function canonicalWorktreePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

interface Lease {
  paths: string[];
  queued: (() => void)[];
}
const leases = new Set<Lease>();
const overlaps = (left: string, right: string): boolean =>
  left === right || left.startsWith(right + sep) || right.startsWith(left + sep);
function leaseFor(path: string): Lease | undefined {
  const absolute = canonicalWorktreePath(path);
  return [...leases].find((lease) => lease.paths.some((root) => overlaps(root, absolute)));
}
export function assertWorktreeAvailable(path: string): void {
  if (leaseFor(path)) throw new Error('Une opération Git utilise cet espace de travail ; attendez sa fin.');
}
/** Terminal input is deferred, rather than dropped, while an idle session is being merged. */
export function deferWorktreeInput(path: string, send: () => void): boolean {
  const lease = leaseFor(path);
  if (!lease) return false;
  lease.queued.push(send);
  return true;
}
export function lockWorktrees(paths: string[]): () => void {
  const absolute = [...new Set(paths.map(canonicalWorktreePath))];
  absolute.forEach(assertWorktreeAvailable);
  const lease: Lease = { paths: absolute, queued: [] };
  leases.add(lease);
  return () => {
    if (!leases.delete(lease)) return;
    for (const send of lease.queued) send();
  };
}
