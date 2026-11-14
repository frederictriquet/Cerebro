import { randomUUID } from 'node:crypto';
import type { Catalog } from './catalog.ts';
import type { CerebroDatabase } from './db.ts';
import { assertNoGitOperation, GitOperationInProgress } from './git-plan.ts';
import { runGit as runGitProcess } from './git-process.ts';
import { currentBranch, isDirty, keyFor, type GitPushes } from './git-push.ts';
import {
  draftRebaseResolution,
  rebaseOntoUpstream,
  resolveRebaseSettings,
  type ConflictResolver,
} from './git-rebase.ts';
import { git as runGit, gitEnv, repositoryRoot } from './git.ts';
import { repositoryActivity, sessionBusy } from './repository-activity.ts';
import type { PullOperation } from '../shared/git.ts';
import { errorMessage } from './util.ts';
import { canonicalWorktreePath, type WorktreeGate } from './worktree-gate.ts';

const LIMIT = 64 * 1024;
const git = async (path: string, args: string[]): Promise<string> => (await runGit(path, args)).trim();

function pullFailureMessage(output: string, stderr: string, code: number | null): string {
  if (/couldn't find remote ref|no such ref was fetched/i.test(output) || /couldn't find remote ref/i.test(stderr)) {
    return 'La branche upstream n’existe plus sur le remote.';
  }
  const lines = stderr
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fatal = lines.findLast((line) => /^fatal:/i.test(line));
  return fatal ?? lines.at(-1) ?? `git pull : code ${code ?? 'inconnu'}`;
}

/** Pull operations of a server (fast-forward when linear, automatic rebase + AI conflict resolution when diverged). */
export class GitPulls {
  private readonly listeners = new Set<(path: string, operation: PullOperation) => void>();
  private readonly active = new Map<string, PullOperation>();
  private readonly latest = new Map<string, PullOperation>();
  private readonly gate: WorktreeGate;
  private readonly pushes: GitPushes;
  private readonly db?: CerebroDatabase;
  private readonly catalog?: Catalog;
  resolveConflicts: ConflictResolver;

  constructor(
    gate: WorktreeGate,
    pushes: GitPushes,
    db?: CerebroDatabase,
    catalog?: Catalog,
    resolver: ConflictResolver = draftRebaseResolution,
  ) {
    this.gate = gate;
    this.pushes = pushes;
    this.db = db;
    this.catalog = catalog;
    this.resolveConflicts = resolver;
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
      rebased: false,
      resolvedFiles: [],
    };
    this.active.set(key, op);
    this.latest.set(key, op);
    void execute(root, op, this.db, this.catalog, (ctx, sig) => this.resolveConflicts(ctx, sig))
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

function assertIdleForPull(path: string, db?: CerebroDatabase): void {
  if (!db) return;
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

async function execute(
  path: string,
  op: PullOperation,
  db: CerebroDatabase | undefined,
  catalog: Catalog | undefined,
  resolver: ConflictResolver,
): Promise<void> {
  assertIdleForPull(path, db);
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
  const remoteBranch = merge.replace(/^refs\/heads\//, '');
  op.upstream = await git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() =>
    remote === '.' ? remoteBranch : `${remote}/${remoteBranch}`,
  );
  if (
    (await currentBranch(path)) !== branch ||
    ((await git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => '')) || null) !== op.beforeHead ||
    (await isDirty(path))
  ) {
    throw new Error('L’état du dépôt a changé avant le pull ; relancez après vérification.');
  }

  const append = (data: Buffer): void => {
    op.output = (op.output + data.toString()).slice(-LIMIT);
  };

  // Unborn local branch: delegate directly to fast-forward pull.
  if (!op.beforeHead) {
    const result = await runGitProcess(
      ['-C', path, 'pull', '--progress', '--no-autostash', '--no-rebase', '--ff-only'],
      {
        env: gitEnv(),
        maxBuffer: 16 * 1024 * 1024,
        onOutput: append,
      },
    );
    op.exitCode = result.code;
    op.afterHead = (await git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => '')) || null;
    if (result.code === 0) {
      op.status = 'succeeded';
      return;
    }
    op.status = 'failed';
    op.error = pullFailureMessage(op.output, result.stderr.toString('utf8'), result.code);
    return;
  }

  // 1. Fetch upstream ref without mutating the working tree.
  let upstreamCommit: string;
  if (remote === '.') {
    upstreamCommit = await git(path, ['rev-parse', '--verify', merge]).catch(() => '');
    if (!upstreamCommit) {
      op.status = 'failed';
      op.error = 'La branche upstream n’existe plus.';
      return;
    }
  } else {
    const fetched = await runGitProcess(
      [
        '-C',
        path,
        '-c',
        'gc.auto=0',
        'fetch',
        '--progress',
        '--no-write-fetch-head',
        '--no-auto-maintenance',
        '--',
        remote,
        `+refs/heads/${remoteBranch}:refs/remotes/${remote}/${remoteBranch}`,
      ],
      {
        env: gitEnv(),
        maxBuffer: 16 * 1024 * 1024,
        onOutput: append,
      },
    );
    if (fetched.code !== 0) {
      op.exitCode = fetched.code;
      op.afterHead = op.beforeHead;
      op.status = 'failed';
      op.error = pullFailureMessage(op.output, fetched.stderr.toString('utf8'), fetched.code);
      return;
    }
    upstreamCommit = await git(path, ['rev-parse', '--verify', `refs/remotes/${remote}/${remoteBranch}`]).catch(
      () => '',
    );
    if (!upstreamCommit) {
      op.afterHead = op.beforeHead;
      op.status = 'failed';
      op.error = 'La branche upstream n’existe plus sur le remote.';
      return;
    }
  }

  // 2. Inspect divergence between upstream and local HEAD.
  const counts = await git(path, ['rev-list', '--left-right', '--count', `${upstreamCommit}...${op.beforeHead}`, '--']);
  const [behindText, aheadText] = counts.split(/\s+/);
  const behind = Number(behindText);
  const ahead = Number(aheadText);

  if (behind === 0) {
    if (!op.output.trim()) op.output = 'Already up to date.\n';
    op.exitCode = 0;
    op.afterHead = op.beforeHead;
    op.status = 'succeeded';
    return;
  }

  if (ahead === 0) {
    if (
      (await currentBranch(path)) !== branch ||
      ((await git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => '')) || null) !== op.beforeHead ||
      (await isDirty(path))
    ) {
      throw new Error('L’état du dépôt a changé pendant le fetch ; relancez après vérification.');
    }
    const ff = await runGitProcess(['-C', path, 'merge', '--ff-only', upstreamCommit], {
      env: gitEnv(),
      maxBuffer: 16 * 1024 * 1024,
      onOutput: append,
    });
    op.exitCode = ff.code;
    op.afterHead = (await git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => '')) || null;
    if (ff.code === 0) {
      op.status = 'succeeded';
      return;
    }
    op.status = 'failed';
    op.error = pullFailureMessage(op.output, ff.stderr.toString('utf8'), ff.code);
    return;
  }

  // 3. Diverged branches (behind > 0 && ahead > 0): rebase local commits onto upstream (with AI conflict resolution if needed).
  const settings = resolveRebaseSettings(path, db, catalog);
  const rebased = await rebaseOntoUpstream({
    root: path,
    branch,
    beforeHead: op.beforeHead,
    upstreamLabel: op.upstream,
    upstreamCommit,
    allowDirty: false,
    settings,
    resolver,
    onOutput: append,
    verifyBeforeApply: async () => {
      assertIdleForPull(path, db);
      await assertNoGitOperation(path);
    },
  });
  op.exitCode = 0;
  op.afterHead = rebased.afterHead;
  op.rebased = true;
  op.resolvedFiles = rebased.resolvedFiles;
  op.status = 'succeeded';
}
