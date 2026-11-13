import { randomUUID } from 'node:crypto';
import type { CerebroDatabase } from './db.ts';
import { assertNoGitOperation, GitOperationInProgress } from './git-plan.ts';
import { runGit as runGitProcess } from './git-process.ts';
import { currentBranch, isDirty, keyFor, type GitPushes } from './git-push.ts';
import { git as runGit, gitEnv, repositoryRoot } from './git.ts';
import { repositoryActivity, sessionBusy } from './repository-activity.ts';
import type { PullOperation } from '../shared/git.ts';
import { errorMessage } from './util.ts';
import { canonicalWorktreePath, type WorktreeGate } from './worktree-gate.ts';

const LIMIT = 64 * 1024;
const git = async (path: string, args: string[]): Promise<string> => (await runGit(path, args)).trim();

function pullFailureMessage(output: string, stderr: string, code: number | null): string {
  if (/Not possible to fast-forward/i.test(output)) {
    return 'Avance rapide impossible : la branche locale et son upstream ont divergé.';
  }
  if (/couldn't find remote ref|no such ref was fetched/i.test(output)) {
    return 'La branche upstream n’existe plus sur le remote.';
  }
  const lines = stderr
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fatal = lines.findLast((line) => /^fatal:/i.test(line));
  return fatal ?? lines.at(-1) ?? `git pull : code ${code ?? 'inconnu'}`;
}

/** Fast-forward pull operations of a server, at most one running per repository. */
export class GitPulls {
  private readonly listeners = new Set<(path: string, operation: PullOperation) => void>();
  private readonly active = new Map<string, PullOperation>();
  private readonly latest = new Map<string, PullOperation>();
  private readonly gate: WorktreeGate;
  private readonly pushes: GitPushes;
  private readonly db?: CerebroDatabase;

  constructor(gate: WorktreeGate, pushes: GitPushes, db?: CerebroDatabase) {
    this.gate = gate;
    this.pushes = pushes;
    this.db = db;
  }

  onComplete(listener: (path: string, operation: PullOperation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async current(path: string): Promise<PullOperation | null> {
    return this.latest.get(await keyFor(path)) ?? null;
  }

  /** Returns an existing operation on double submission; locks the worktree for the whole pull. */
  async start(path: string): Promise<PullOperation> {
    const [key, root, push] = await Promise.all([keyFor(path), repositoryRoot(path), this.pushes.current(path)]);
    const existing = this.active.get(key);
    if (existing) return existing;
    if (push?.status === 'running') {
      throw new Error('Un push est en cours : attendez sa fin avant de tirer.');
    }
    const release = this.gate.lock([root]);
    const op: PullOperation = {
      id: randomUUID(),
      branch: null,
      upstream: null,
      beforeHead: null,
      afterHead: null,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      exitCode: null,
      output: '',
    };
    this.active.set(key, op);
    this.latest.set(key, op);
    void execute(root, op, this.db)
      .catch((cause: unknown) => {
        op.error = errorMessage(cause);
        op.status = 'failed';
      })
      .finally(() => {
        op.finishedAt = Date.now();
        this.active.delete(key);
        release();
        for (const listener of this.listeners) {
          try {
            listener(path, op);
          } catch (cause) {
            console.error(
              '[pull] Notification de fin de pull en échec :',
              cause instanceof Error ? cause.message : cause,
            );
          }
        }
      });
    return op;
  }
}

async function execute(path: string, op: PullOperation, db?: CerebroDatabase): Promise<void> {
  if (db) {
    const activity = repositoryActivity(db, canonicalWorktreePath(path));
    if (activity.sessions.some((session) => sessionBusy(session.status))) {
      throw new Error('Une session utilise encore ce dépôt : attendez la fin de son tour avant de tirer.');
    }
    if (activity.commands > 0) {
      throw new Error('Une commande utilise encore ce dépôt : attendez sa fin avant de tirer.');
    }
    if (activity.automaticCommits > 0) {
      throw new Error('Un commit automatique utilise encore ce dépôt : attendez sa fin avant de tirer.');
    }
  }
  try {
    await assertNoGitOperation(path);
  } catch (cause) {
    if (cause instanceof GitOperationInProgress && cause.operation) {
      throw new Error(`Opération Git en cours (${cause.operation}) : terminez-la ou annulez-la avant de tirer.`, {
        cause,
      });
    }
    throw cause;
  }
  if (await isDirty(path)) {
    throw new Error('Le dépôt a des modifications en attente : commitez ou annulez-les avant de tirer.');
  }
  const branch = await currentBranch(path);
  if (!branch) throw new Error('HEAD détachée : choisissez une branche.');
  op.branch = branch;
  op.beforeHead = (await git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => '')) || null;
  const remote = await git(path, ['config', '--get', `branch.${branch}.remote`]).catch(() => '');
  const merge = await git(path, ['config', '--get', `branch.${branch}.merge`]).catch(() => '');
  if (!remote && !merge) throw new Error('Aucun upstream configuré pour cette branche.');
  if (Boolean(remote) !== Boolean(merge)) {
    throw new Error('Configuration upstream incomplète : corrigez-la avant de tirer.');
  }
  op.upstream = await git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(
    () => `${remote}/${merge.replace(/^refs\/heads\//, '')}`,
  );
  if (
    (await currentBranch(path)) !== branch ||
    ((await git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => '')) || null) !== op.beforeHead ||
    (await isDirty(path))
  ) {
    throw new Error('L’état du dépôt a changé avant le pull ; relancez après vérification.');
  }
  // --no-autostash and --no-rebase override user gitconfig; --ff-only never leaves merge conflicts in the project folder.
  const args = ['pull', '--progress', '--no-autostash', '--no-rebase', '--ff-only'];
  const append = (data: Buffer): void => {
    op.output = (op.output + data.toString()).slice(-LIMIT);
  };
  const result = await runGitProcess(['-C', path, ...args], {
    env: gitEnv(),
    maxBuffer: 16 * 1024 * 1024,
    onOutput: append,
  });
  op.exitCode = result.code;
  op.afterHead = (await git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => '')) || null;
  if (result.code === 0) {
    op.status = 'succeeded';
    return;
  }
  op.status = 'failed';
  op.error = pullFailureMessage(op.output, result.stderr.toString('utf8'), result.code);
}
