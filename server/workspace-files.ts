import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { git, splitZ } from './git.ts';

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

/** Whether `name` stays outside the `excluded` entries and their subtrees. */
export const inScope = (name: string, excluded: string[]): boolean => !excluded.some(prefix => name === prefix || name.startsWith(`${prefix}/`));

/** Signature of every Git-visible file (tracked or untracked, not ignored), by path; `excluded` entries and their content are skipped. */
export async function workspaceManifest(path: string, excluded: string[] = []): Promise<Record<string, string>> {
  const entries: [string, string][] = [];
  const names = [...new Set(splitZ(await git(path, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])))]
    .filter(name => inScope(name, excluded)).sort();
  for (const name of names) entries.push([name, await workspaceFileSignature(join(path, name)) ?? 'missing']);
  return Object.fromEntries(entries);
}
