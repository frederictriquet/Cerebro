import { createHash } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute, join, sep } from 'node:path';
import { git, GitError, splitZ } from './git.ts';

// Read-only access to the files of a session's working folder, for the desktop « Fichiers » panel.
// [SPEC: Fonctions complémentaires › Serveur, fichiers du dossier de travail d'une session]

export const MAX_FILE_BYTES = 1024 * 1024;
// Same heuristic as Git: a NUL byte near the start means binary content.
const BINARY_PROBE_BYTES = 8 * 1024;
// Outside Git, the listing walks the folder: bounded, the panel says when it is cut.
export const MAX_WALKED_FILES = 5_000;
// Outside Git nothing says what is ignored: hidden entries (.env, .git, .DS_Store) and dependencies are skipped.
const SKIPPED_DIRECTORIES = new Set(['node_modules']);

export class SessionFileError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export type SessionFileRead =
  { path: string; version: string; content: string } | { path: string; version: string; unchanged: true };

export interface SessionFileList {
  files: string[];
  /** True when a folder outside Git has more than MAX_WALKED_FILES files: only the first ones are listed. */
  truncated: boolean;
}

async function isGitWorkTree(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch (cause) {
    if (cause instanceof GitError && /not a git repository/i.test(cause.message)) return false;
    throw cause;
  }
}

/** Whether a relative path is one the walk of a folder outside Git can list. */
function walkable(path: string): boolean {
  const segments = path.split('/');
  return segments.every(
    (segment) => segment !== '' && segment !== '..' && !segment.startsWith('.') && !SKIPPED_DIRECTORIES.has(segment),
  );
}

async function linksToFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (cause) {
    // A dangling link lists nothing.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

/** Regular files of a folder outside Git, in path order, without following links to directories. */
async function walkFiles(root: string): Promise<SessionFileList> {
  const files: string[] = [];
  const visit = async (relativeDir: string): Promise<boolean> => {
    const entries = await readdir(join(root, relativeDir), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (!walkable(path)) continue;
      if (entry.isDirectory()) {
        if (!(await visit(path))) return false;
      } else if (entry.isFile() || (entry.isSymbolicLink() && (await linksToFile(join(root, path))))) {
        if (files.length === MAX_WALKED_FILES) return false;
        files.push(path);
      }
    }
    return true;
  };
  const complete = await visit('');
  return { files: files.sort(), truncated: !complete };
}

/**
 * Files of `root`, relative to it, sorted. In a Git work tree: tracked and untracked files, ignored ones
 * excluded. Elsewhere: a bounded walk of the folder, hidden entries and node_modules skipped.
 */
export async function listSessionFiles(root: string): Promise<SessionFileList> {
  if (!(await isGitWorkTree(root))) return walkFiles(root);
  const output = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return { files: [...new Set(splitZ(output))].sort(), truncated: false };
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * Content of `path` (relative to `root`). Only a path `listSessionFiles` can list (outside Git: whatever the
 * bound) whose real location stays inside `root` is served: absolute paths, `..`, ignored or hidden files and
 * symlinks leading outside are refused.
 * `known` is a version previously returned; when it still matches, the content is not sent again.
 */
export async function readSessionFile(root: string, path: string, known?: string): Promise<SessionFileRead> {
  const notFound = new SessionFileError(`Fichier introuvable dans le dossier de la session : ${path}`, 404);
  if (path === '' || isAbsolute(path)) throw notFound;
  const listed = (await isGitWorkTree(root)) ? (await listSessionFiles(root)).files.includes(path) : walkable(path);
  if (!listed) throw notFound;
  let real: string;
  try {
    real = await realpath(join(root, path));
  } catch (cause) {
    // Listed but deleted from disk since, or never there.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw notFound;
    throw cause;
  }
  if (!inside(await realpath(root), real)) throw notFound;
  const handle = await open(real, 'r');
  let buffer: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw notFound;
    if (stat.size > MAX_FILE_BYTES)
      throw new SessionFileError(
        `Fichier trop volumineux pour être affiché (${Math.ceil(stat.size / 1024)} Kio, 1 Mio au plus).`,
        413,
      );
    buffer = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (buffer.length > MAX_FILE_BYTES)
    throw new SessionFileError('Fichier trop volumineux pour être affiché (1 Mio au plus).', 413);
  if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0))
    throw new SessionFileError('Fichier binaire : il ne peut pas être affiché.', 415);
  const version = createHash('sha256').update(buffer).digest('hex');
  if (known === version) return { path, version, unchanged: true };
  return { path, version, content: buffer.toString('utf8') };
}
