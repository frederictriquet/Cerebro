import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';

/**
 * Only what Git tracks: a copy recreated by checkout-index gets its permissions from the umask, so read/write
 * bits differ from the source without any visible change. Git's executable bit is the owner's.
 */
export function regularFileSignature(mode: number, content: Buffer): string {
  return `${mode & 0o100 ? 0o100755 : 0o100644}:${createHash('sha256').update(content).digest('hex')}`;
}

/** Same representation for the persisted baseline and the current workspace. */
export async function workspaceFileSignature(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return `link:${await readlink(path)}`;
    if (stat.isFile()) return regularFileSignature(stat.mode, await readFile(path));
    throw new Error(`Fichier spécial non comparable : ${path}`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
}
