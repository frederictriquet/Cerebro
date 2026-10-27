import { assertWorktreeAvailable } from './worktree-gate.ts';
import { randomUUID } from 'node:crypto';
import { git as runGit, GitError } from './git.ts';
import type { PushOperation } from '../shared/git.ts';
import { errorMessage } from './util.ts';

const LIMIT = 64 * 1024;
const listeners=new Set<(path:string,operation:PushOperation)=>void>();
export function onPushComplete(listener:(path:string,operation:PushOperation)=>void):()=>void{listeners.add(listener);return()=>listeners.delete(listener);}
const active = new Map<string, PushOperation>();
const latest = new Map<string, PushOperation>();
const git = async (path: string, args: string[]): Promise<string> => (await runGit(path, args)).trim();

/** Canonical worktree identity also serializes aliases of the same project path. */
async function keyFor(path: string): Promise<string> {
  return git(path, ['rev-parse', '--absolute-git-dir']);
}
export async function currentPush(path: string): Promise<PushOperation | null> {
  return latest.get(await keyFor(path)) ?? null;
}

/** Returns an existing operation on double submission; validation happens inside the lock. */
interface PushOptions { allowDirty?: boolean; expectedHead?: string | null; expectedBranch?: string | null }
export async function startPush(path: string, options: PushOptions = {}): Promise<PushOperation> {
  const key = await keyFor(path);
  assertWorktreeAvailable(path);
  const existing = active.get(key);
  if (existing) return existing;
  const op: PushOperation = {
    id: randomUUID(), branch: null, head: null, status: 'running', startedAt: Date.now(),
    finishedAt: null, error: null, remotes: [],
  };
  active.set(key, op);
  latest.set(key, op);
  void execute(path, op, options).catch((cause: unknown) => {
    op.error = errorMessage(cause);
    op.status = 'failed';
  }).finally(() => {
    op.finishedAt = Date.now();
    active.delete(key);
    for(const listener of listeners)listener(path,op);
  });
  return op;
}

async function execute(path: string, op: PushOperation, options: PushOptions): Promise<void> {
  if (!options.allowDirty && await git(path, ['status', '--porcelain=v1', '-z']) !== '') {
    throw new Error('Le dépôt a des changements : préparez un commit avant de pousser.');
  }
  const branch = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) throw new Error('HEAD détachée : choisissez une branche.');
  op.branch = branch;
  op.head = await git(path, ['rev-parse', '--verify', 'HEAD']);
  if (options.expectedHead !== undefined && options.expectedHead !== op.head
    || options.expectedBranch !== undefined && options.expectedBranch !== `refs/heads/${branch}`) throw new Error('La branche ou HEAD a changé avant le push ; vérifiez les nouveaux commits.');
  const remotes = (await git(path, ['remote'])).split('\n').filter(Boolean);
  if (remotes.length === 0) throw new Error('Aucun remote configuré.');
  const upstream = await git(path, ['config', '--get', `branch.${branch}.remote`]).catch(() => '');
  const merge = await git(path, ['config', '--get', `branch.${branch}.merge`]).catch(() => '');
  if (Boolean(upstream) !== Boolean(merge)) throw new Error('Configuration upstream incomplète : corrigez-la avant de pousser.');
  const upstreamRemote = upstream ? null : remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
  if (!upstream && upstreamRemote === null) {
    throw new Error('Plusieurs remotes sans origin ni upstream : choisissez explicitement un upstream dans Git.');
  }
  op.remotes = remotes.map((remote) => ({ remote, status: 'pending', upstream: remote === upstreamRemote, exitCode: null, output: '' }));
  for (const result of op.remotes) {
    result.status = 'running';
    try {
      if (await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== branch
        || await git(path, ['rev-parse', 'HEAD']) !== op.head) {
        throw new Error('La branche ou HEAD a changé pendant le push ; relancez après vérification.');
      }
      // Explicit refspec avoids push.default, remote.*.push and implicit tag publication.
      // --no-mirror overrides remote.*.mirror, without bypassing any hook.
      const args = ['push', '--porcelain', '--progress', '--no-force', '--no-mirror', '--no-follow-tags',
        ...(result.upstream ? ['--set-upstream'] : []), '--', result.remote, `refs/heads/${branch}:refs/heads/${branch}`];
      // No timeout: a push waits on the network and on remote hooks.
      const append = (data: Buffer): void => { result.output = (result.output + data.toString()).slice(-LIMIT); };
      result.exitCode = await runGit(path, args, { timeout: 0, onOutput: append })
        .then(() => 0, cause => { if (cause instanceof GitError) return cause.code; throw cause; });
      result.status = result.exitCode === 0 ? 'succeeded' : 'failed';
    } catch (cause) {
      result.status = 'failed';
      result.output += errorMessage(cause);
    }
  }
  op.status = op.remotes.every((remote) => remote.status === 'succeeded') ? 'succeeded' : 'failed';
}
