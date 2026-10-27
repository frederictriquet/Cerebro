import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Physical identity of a path. A copy already deleted keeps the identity of its nearest remaining ancestor, so a
 * data directory reached through a link still matches the realpath recorded while the copy existed.
 */
export function canonicalWorktreePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalWorktreePath(parent), basename(absolute));
  }
}

/** Whether `path` is `root` or lies below it. Both are compared as given: canonicalize them first. */
export function pathWithin(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

interface Lease {
  paths: string[];
  queued: (() => void)[];
}
const overlaps = (left: string, right: string): boolean => pathWithin(left, right) || pathWithin(right, left);

/** Leases held on workspaces by Git operations; one instance is shared by every service of a server. */
export class WorktreeGate {
  private readonly leases = new Set<Lease>();

  private leaseFor(path: string): Lease | undefined {
    if (!this.leases.size) return undefined;
    const absolute = canonicalWorktreePath(path);
    return [...this.leases].find((lease) => lease.paths.some((root) => overlaps(root, absolute)));
  }
  assertAvailable(path: string): void {
    if (this.leaseFor(path)) throw new Error('Une opération Git utilise cet espace de travail ; attendez sa fin.');
  }
  /** Terminal input is deferred, rather than dropped, while an idle session is being merged. */
  deferInput(path: string, send: () => void): boolean {
    const lease = this.leaseFor(path);
    if (!lease) return false;
    lease.queued.push(send);
    return true;
  }
  lock(paths: string[]): () => void {
    const absolute = [...new Set(paths.map(canonicalWorktreePath))];
    absolute.forEach((path) => this.assertAvailable(path));
    const lease: Lease = { paths: absolute, queued: [] };
    this.leases.add(lease);
    return () => {
      if (!this.leases.delete(lease)) return;
      // Called from the callers' finally: a failing delivery must neither skip the next ones nor mask their error.
      for (const send of lease.queued) {
        try {
          send();
        } catch (cause) {
          console.error('[worktrees] Saisie différée non transmise :', cause instanceof Error ? cause.message : cause);
        }
      }
    };
  }
}
