import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asRecord } from './util.ts';

function isErrno(cause: unknown, ...codes: string[]): boolean {
  return codes.includes((cause as NodeJS.ErrnoException).code ?? '');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (isErrno(cause, 'ESRCH')) return false;
    // EPERM : le processus existe, il appartient à un autre utilisateur.
    if (isErrno(cause, 'EPERM')) return true;
    throw cause;
  }
}

async function readRegistration(path: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    // La session s'est terminée entre le listage du dossier et la lecture.
    if (isErrno(cause, 'ENOENT')) return null;
    throw cause;
  }
  try {
    return asRecord(JSON.parse(text));
  } catch (cause) {
    // Fichier d'une autre session écrit à ce moment par Claude : il ne peut pas désigner la nôtre.
    if (cause instanceof SyntaxError) return null;
    throw cause;
  }
}

/**
 * Nom sous lequel les autres sessions Claude joignent celle-ci avec `SendMessage`.
 * Claude Code l'écrit dans `<claudeRoot>/sessions/<pid>.json` avec l'identifiant de la session (`--session-id`).
 * Null quand aucun processus vivant n'a cet identifiant.
 */
export async function findPeerName(claudeRoot: string, agentSessionId: string): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(join(claudeRoot, 'sessions'));
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) return null;
    throw cause;
  }
  let best: { name: string; updatedAt: number } | null = null;
  for (const file of files.filter((entry) => entry.endsWith('.json'))) {
    const registration = await readRegistration(join(claudeRoot, 'sessions', file));
    if (registration === null || registration.sessionId !== agentSessionId) continue;
    const { pid, name } = registration;
    if (typeof pid !== 'number' || typeof name !== 'string' || name === '' || !alive(pid)) continue;
    const updatedAt = typeof registration.updatedAt === 'number' ? registration.updatedAt : 0;
    if (best === null || updatedAt > best.updatedAt) best = { name, updatedAt };
  }
  return best?.name ?? null;
}
