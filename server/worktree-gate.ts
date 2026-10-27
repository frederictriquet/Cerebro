import { basename, dirname, join, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Physical identity of a path. A copy already deleted keeps the identity of its nearest remaining ancestor, so a
 * data directory reached through a link still matches the realpath recorded while the copy existed.
 */
export function canonicalWorktreePath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalWorktreePath(parent), basename(absolute));
  }
}

interface Lease { paths: string[]; queued: (() => void)[] }
const leases = new Set<Lease>();
const overlaps = (left: string, right: string): boolean => left === right || left.startsWith(right + sep) || right.startsWith(left + sep);
function leaseFor(path: string): Lease | undefined {
  const absolute = canonicalWorktreePath(path);
  return [...leases].find(lease => lease.paths.some(root => overlaps(root, absolute)));
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
    // Called from the callers' finally: a failing delivery must neither skip the next ones nor mask their error.
    for (const send of lease.queued) {
      try { send(); } catch (cause) { console.error('[worktrees] Saisie différée non transmise :', cause instanceof Error ? cause.message : cause); }
    }
  };
}
