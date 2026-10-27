import { FINDING_INSTRUCTIONS } from './findings.ts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { prepareCommit, verifySnapshot } from './git-plan.ts';
const exec = promisify(execFile);
const git = async (path: string, args: string[]) =>
  (
    await exec('git', ['-C', path, ...args], {
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
  ).stdout.trim();
export interface PreparedReview {
  id: string;
  root: string;
  snapshotId: string;
  scope: 'working' | 'unpushed' | 'last-commit' | 'empty';
  head: string | null;
  upstream: string | null;
  commits: string[];
  files: string[];
  context: string;
}
const reviews = new Map<string, PreparedReview>();
export function reviewInstructions(root: string, selection: unknown, context: string): string {
  return `Fais une code review du périmètre immuable préparé par Cerebro ci-dessous. Cherche en priorité les bugs de correction, puis de sécurité et de simplicité. Vérifie chaque finding dans le code environnant, accessible dans ${root}. Ne modifie aucun fichier. Rapporte chaque finding avec gravité, fichier:ligne, problème, scénario concret et correctif attendu. ${FINDING_INSTRUCTIONS} Si une commande de review personnalisée est utilisée, applique ses critères uniquement à ce périmètre ; aucune autre règle automatique de choix du diff ne s’applique.\n\n<perimetre_cerebro>\n${JSON.stringify(selection)}\n</perimetre_cerebro>\n<contexte_git>\n${context}\n</contexte_git>`;
}
export async function prepareReview(path: string): Promise<PreparedReview> {
  const snapshot = await prepareCommit(path);
  path = snapshot.root;
  const upstream = await git(path, ['rev-parse', '--verify', '@{upstream}']).catch(() => null);
  const review: PreparedReview = {
    id: randomUUID(),
    root: path,
    snapshotId: snapshot.id,
    scope: 'empty',
    head: snapshot.head,
    upstream,
    commits: [],
    files: [],
    context: '',
  };
  if (snapshot.files.length || snapshot.stagedDiff) {
    review.scope = 'working';
    review.files = snapshot.files.map((f) => f.path);
    review.context = `Index préexistant (diff index / HEAD) :\n${snapshot.stagedDiff}\n\nDiffs worktree / HEAD, incluant les fichiers non suivis :\n${snapshot.files.map((f) => f.diff).join('\n')}`;
  } else if (snapshot.head) {
    review.commits = upstream
      ? (await git(path, ['rev-list', '--reverse', `${upstream}..${snapshot.head}`])).split('\n').filter(Boolean)
      : [snapshot.head];
    review.scope = review.commits.length ? (upstream ? 'unpushed' : 'last-commit') : 'empty';
    const files = new Set<string>();
    const patches: string[] = [];
    let size = 0;
    for (const oid of review.commits) {
      const patch = await git(path, [
        'show',
        '--first-parent',
        '--root',
        '--format=fuller',
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
        oid,
      ]);
      size += Buffer.byteLength(patch);
      if (size > 4 * 1024 * 1024) throw new Error('Contexte de review trop volumineux.');
      patches.push(patch);
      (await git(path, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-z', '-r', oid]))
        .split('\0')
        .filter(Boolean)
        .forEach((f) => files.add(f));
    }
    review.context = patches.join('\n');
    review.files = [...files];
  }
  if (Buffer.byteLength(review.context) > 4 * 1024 * 1024) throw new Error('Contexte de review trop volumineux.');
  await verifySnapshot(path, snapshot.id);
  if (upstream !== (await git(path, ['rev-parse', '--verify', '@{upstream}']).catch(() => null)))
    throw new Error('Upstream modifié pendant la préparation.');
  if (reviews.size >= 100) reviews.delete(reviews.keys().next().value!);
  reviews.set(review.id, review);
  return review;
}
export async function verifyReview(path: string, id: string): Promise<PreparedReview> {
  const review = reviews.get(id);
  if (!review) throw new Error('Review expirée : préparez son périmètre.');
  const snapshot = await verifySnapshot(path, review.snapshotId);
  if (
    snapshot.root !== review.root ||
    review.upstream !== (await git(review.root, ['rev-parse', '--verify', '@{upstream}']).catch(() => null))
  )
    throw new Error('Périmètre obsolète : upstream modifié.');
  if (review.scope === 'empty') throw new Error('Aucun changement à relire.');
  return review;
}
