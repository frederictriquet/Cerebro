import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';

/** Same representation for the persisted baseline and the current workspace. */
export async function workspaceFileSignature(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return `link:${await readlink(path)}`;
    if (stat.isFile()) return `${stat.mode}:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
    throw new Error(`Fichier spécial non comparable : ${path}`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
}
