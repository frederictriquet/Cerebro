import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, stat, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { routeErrors, statusCodeOf } from './routes-util.ts';
import { defaultTranscriptRoots } from './transcripts.ts';

const MAX_SYMLINK_HOPS = 40;

export interface ClaudeTranscriptEntry {
  /** Path relative to `<claude>/projects`, separated with `/`. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** Last modification time (Unix epoch in milliseconds). */
  mtimeMs: number;
}

export class TranscriptError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function fsCode(cause: unknown): string | undefined {
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function validateRelativeJsonlPath(rawPath: unknown): string[] {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    throw new TranscriptError(400, 'Paramètre path (.jsonl relatif) requis');
  }
  if (isAbsolute(rawPath) || rawPath.includes('\\') || /^[A-Za-z]:/.test(rawPath)) {
    throw new TranscriptError(400, 'Les chemins absolus sont refusés');
  }
  if (!rawPath.endsWith('.jsonl')) {
    throw new TranscriptError(400, 'Seuls les fichiers .jsonl sont autorisés');
  }
  const segments = rawPath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TranscriptError(400, 'Chemin hors de la racine des transcripts');
  }
  if (segments.at(-1) === '.jsonl') {
    throw new TranscriptError(400, 'Nom de fichier .jsonl invalide');
  }
  return segments;
}

async function resolveSymlinkStep(rootReal: string, linkPath: string): Promise<string> {
  try {
    const targetReal = await realpath(linkPath);
    if (!isInside(rootReal, targetReal)) {
      throw new TranscriptError(400, 'Chemin hors de la racine des transcripts');
    }
    return targetReal;
  } catch (cause) {
    if (cause instanceof TranscriptError) throw cause;
    const code = fsCode(cause);
    if (code === 'ELOOP') throw new TranscriptError(400, 'Lien symbolique invalide');
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw cause;
  }

  // Target is missing: still reject with 400 when a dangling symlink points outside `projects`.
  let probe = linkPath;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    const rawTarget = await readlink(probe).catch(() => null);
    if (rawTarget === null) throw new TranscriptError(404, 'Transcript introuvable');
    const target = resolve(dirname(probe), rawTarget);
    if (!isInside(rootReal, target)) {
      throw new TranscriptError(400, 'Chemin hors de la racine des transcripts');
    }
    const info = await lstat(target).catch(() => null);
    if (info === null || !info.isSymbolicLink()) {
      throw new TranscriptError(404, 'Transcript introuvable');
    }
    probe = target;
  }
  throw new TranscriptError(400, 'Lien symbolique invalide');
}

/** Lists all `.jsonl` files under `<claudeRoot>/projects` (including subagents), sorted by relative path. */
export async function listClaudeTranscripts(
  claudeRoot: string = defaultTranscriptRoots().claude,
): Promise<ClaudeTranscriptEntry[]> {
  let rootReal: string;
  try {
    rootReal = await realpath(join(claudeRoot, 'projects'));
    const rootInfo = await stat(rootReal);
    if (!rootInfo.isDirectory()) return [];
  } catch (cause) {
    const code = fsCode(cause);
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw cause;
  }

  const visited = new Set<string>([rootReal]);
  const found: ClaudeTranscriptEntry[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.includes('\\')) continue;
      const fullPath = join(dir, entry.name);
      const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (visited.has(fullPath)) continue;
        visited.add(fullPath);
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        if (!entry.name.endsWith('.jsonl') || entry.name === '.jsonl') continue;
        const info = await stat(fullPath).catch(() => null);
        if (info !== null && info.isFile()) {
          found.push({ path: relPath, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) });
        }
      } else if (entry.isSymbolicLink()) {
        const targetReal = await realpath(fullPath).catch(() => null);
        if (targetReal === null || !isInside(rootReal, targetReal)) continue;
        const info = await stat(targetReal).catch(() => null);
        if (info === null) continue;
        if (info.isDirectory()) {
          if (!visited.has(targetReal)) {
            visited.add(targetReal);
            await walk(targetReal, relPath);
          }
        } else if (
          info.isFile() &&
          entry.name.endsWith('.jsonl') &&
          entry.name !== '.jsonl' &&
          targetReal.endsWith('.jsonl')
        ) {
          found.push({ path: relPath, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) });
        }
      }
    }
  };

  await walk(rootReal, '');
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return found;
}

/** Validates `rawPath` and opens the raw `.jsonl` file inside `<claudeRoot>/projects` for streaming. */
export async function openClaudeTranscript(
  rawPath: unknown,
  claudeRoot: string = defaultTranscriptRoots().claude,
): Promise<FileHandle> {
  const segments = validateRelativeJsonlPath(rawPath);
  const projectsDir = join(claudeRoot, 'projects');

  let rootReal: string;
  try {
    rootReal = await realpath(projectsDir);
  } catch (cause) {
    const code = fsCode(cause);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new TranscriptError(404, 'Transcript introuvable');
    if (code === 'ELOOP') throw new TranscriptError(400, 'Chemin hors de la racine des transcripts');
    throw cause;
  }

  let current = rootReal;
  for (const segment of segments) {
    const next = join(current, segment);
    let linkInfo;
    try {
      linkInfo = await lstat(next);
    } catch (cause) {
      const code = fsCode(cause);
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new TranscriptError(404, 'Transcript introuvable');
      throw cause;
    }
    current = linkInfo.isSymbolicLink() ? await resolveSymlinkStep(rootReal, next) : next;
  }

  if (!isInside(rootReal, current) || !current.endsWith('.jsonl')) {
    throw new TranscriptError(400, 'Chemin hors de la racine des transcripts');
  }

  let handle: FileHandle;
  try {
    handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (cause) {
    const code = fsCode(cause);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new TranscriptError(404, 'Transcript introuvable');
    if (code === 'ELOOP' || code === 'EISDIR') throw new TranscriptError(400, 'Fichier .jsonl attendu');
    throw cause;
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new TranscriptError(400, 'Fichier .jsonl attendu');
    return handle;
  } catch (cause) {
    await handle.close().catch(() => {});
    throw cause;
  }
}

const { orError } = routeErrors(statusCodeOf(TranscriptError, 500));

/** Raw Claude Code `.jsonl` transcripts under `<claude>/projects` (protected like `/api/sessions`). */
export function registerTranscriptRoutes(app: FastifyInstance): void {
  app.get('/api/transcripts', async (_request, reply) => {
    const result = await orError(reply, () => listClaudeTranscripts());
    return result.ok ? reply.send(result.value) : result.reply;
  });

  app.get<{ Querystring: { path?: unknown } }>('/api/transcripts/file', async (request, reply) => {
    const result = await orError(reply, () => openClaudeTranscript(request.query.path));
    if (!result.ok) return result.reply;
    const stream = result.value.createReadStream();
    stream.on('error', (cause) => {
      request.log.warn({ err: cause }, 'transcript illisible');
    });
    return reply.header('content-type', 'application/x-ndjson; charset=utf-8').send(stream);
  });
}
