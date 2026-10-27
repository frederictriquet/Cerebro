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
const overlaps = (left: string, right: string): boolean =>
  left === right || left.startsWith(right + sep) || right.startsWith(left + sep);

/** Leases held on workspaces by Git operations; one instance is shared by every service of a server. */
export class WorktreeGate {
  private readonly leases = new Set<Lease>();

  private leaseFor(path: string): Lease | undefined {
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
      for (const send of lease.queued) send();
    };
  }
}
