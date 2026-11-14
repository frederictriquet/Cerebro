import { randomUUID } from 'node:crypto';
import type { Catalog } from './catalog.ts';
import type { CerebroDatabase } from './db.ts';
import { assertNoGitOperation, GitOperationInProgress } from './git-plan.ts';
import { GitOutputLimitError, runGit as runGitProcess } from './git-process.ts';
import {
  draftRebaseResolution,
  rebaseOntoUpstream,
  resolveRebaseSettings,
  type ConflictResolver,
} from './git-rebase.ts';
import { GitError, git as runGit, gitEnv, repositoryRoot } from './git.ts';
import { repositoryActivity, sessionBusy } from './repository-activity.ts';
import type { AutomaticCommit, PushOperation, PushRemoteResult } from '../shared/git.ts';
import { errorMessage } from './util.ts';
import { canonicalWorktreePath, pathWithin, type WorktreeGate } from './worktree-gate.ts';

const LIMIT = 64 * 1024;
const MAX_SYNC_ATTEMPTS = 2;
const git = async (path: string, args: string[]): Promise<string> => (await runGit(path, args)).trim();

/** An overflowing status is not empty: that alone proves the worktree is dirty. */
export async function isDirty(path: string): Promise<boolean> {
  try {
    return (await git(path, ['status', '--porcelain=v1', '-z'])) !== '';
  } catch (cause) {
    if (cause instanceof GitOutputLimitError) return true;
    throw cause;
  }
}

/** `symbolic-ref --quiet` exits with 1 on a detached HEAD: that is a state, not a failure. */
export async function currentBranch(path: string): Promise<string | null> {
  try {
    return (await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) || null;
  } catch (cause) {
    if ((cause as { code?: unknown }).code === 1) return null;
    throw cause;
  }
}

/** Canonical worktree identity also serializes aliases of the same project path. */
export async function keyFor(path: string): Promise<string> {
  return git(path, ['rev-parse', '--absolute-git-dir']);
}

export interface PushOptions {
  allowDirty?: boolean;
  expectedHead?: string | null;
  expectedBranch?: string | null;
}

function isNonFastForwardPushOutput(output: string): boolean {
  return (
    /\[rejected\][^\r\n]*\((?:non-fast-forward|fetch first)\)/i.test(output) ||
    /Updates were rejected because the (?:tip of your current branch is behind|remote contains work)/i.test(output)
  );
}

async function assertSafeToRebaseOnPush(root: string, db?: CerebroDatabase): Promise<void> {
  if (db) {
    const canonical = canonicalWorktreePath(root);
    const activity = repositoryActivity(db, canonical);
    if (activity.sessions.some((session) => sessionBusy(session.status))) {
      throw new Error('Une session utilise encore ce dépôt : attendez la fin de son tour avant de synchroniser.');
    }
    if (activity.commands > 0) {
      throw new Error('Une commande utilise encore ce dépôt : attendez sa fin avant de synchroniser.');
    }
    const commits = (db.connection.prepare('SELECT data FROM automatic_commits').all() as { data: string }[]).map(
      (row) => JSON.parse(row.data) as AutomaticCommit,
    );
    const nonPushingCommit = commits.some(
      (run) =>
        run.status === 'running' &&
        run.phase !== 'pushing' &&
        Boolean(run.path) &&
        pathWithin(canonical, canonicalWorktreePath(run.path)),
    );
    if (nonPushingCommit) {
      throw new Error('Un commit automatique prépare encore ce dépôt : attendez sa fin avant de synchroniser.');
    }
  }
  try {
    await assertNoGitOperation(root);
  } catch (cause) {
    if (cause instanceof GitOperationInProgress && cause.operation) {
      throw new Error(
        `Opération Git en cours (${cause.operation}) : terminez-la ou annulez-la avant de synchroniser.`,
        { cause },
      );
    }
    throw cause;
  }
}

/** Push operations of a server, at most one running per repository. */
export class GitPushes {
  private readonly listeners = new Set<(path: string, operation: PushOperation) => void>();
  private readonly active = new Map<string, { op: PushOperation; done: Promise<void> }>();
  private readonly latest = new Map<string, PushOperation>();
  private readonly gate: WorktreeGate;
  private readonly db?: CerebroDatabase;
  private readonly catalog?: Catalog;
  resolveConflicts: ConflictResolver;

  constructor(
    gate: WorktreeGate,
    db?: CerebroDatabase,
    catalog?: Catalog,
    resolver: ConflictResolver = draftRebaseResolution,
  ) {
    this.gate = gate;
    this.db = db;
    this.catalog = catalog;
    this.resolveConflicts = resolver;
  }

  get busy(): boolean {
    return this.active.size > 0;
  }

  async shutdown(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((item) => item.done));
    }
  }

  onComplete(listener: (path: string, operation: PushOperation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async current(path: string): Promise<PushOperation | null> {
    return this.latest.get(await keyFor(path)) ?? null;
  }

  /** Returns an existing operation on double submission; validation happens inside the lock. */
  async start(path: string, options: PushOptions = {}): Promise<PushOperation> {
    const key = await keyFor(path);
    this.gate.assertAvailable(path);
    const existing = this.active.get(key);
    if (existing) return existing.op;
    const op: PushOperation = {
      id: randomUUID(),
      branch: null,
      head: null,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      remotes: [],
      rebasedFrom: null,
      resolvedFiles: [],
      syncOutput: '',
    };
    this.latest.set(key, op);
    const done = execute(path, op, options, this.gate, this.db, this.catalog, (ctx, sig) =>
      this.resolveConflicts(ctx, sig),
    )
      .catch((cause: unknown) => {
        op.error = errorMessage(cause);
        op.status = 'failed';
      })
      .finally(() => {
        op.finishedAt = Date.now();
        this.active.delete(key);
        // A listener runs inside a detached promise: its failure is logged rather than left as an unhandled rejection.
        for (const listener of this.listeners) {
          try {
            listener(path, op);
          } catch (cause) {
            console.error(
              '[push] Notification de fin de push en échec :',
              cause instanceof Error ? cause.message : cause,
            );
          }
        }
      });
    this.active.set(key, { op, done });
    return op;
  }
}

async function pushSingleRemote(root: string, branch: string, head: string, result: PushRemoteResult): Promise<void> {
  result.status = 'running';
  result.exitCode = null;
  result.output = '';
  try {
    if ((await currentBranch(root)) !== branch || (await git(root, ['rev-parse', 'HEAD'])) !== head) {
      throw new Error('La branche ou HEAD a changé pendant le push ; relancez après vérification.');
    }
    // Explicit refspec avoids push.default, remote.*.push and implicit tag publication.
    // --no-mirror overrides remote.*.mirror, without bypassing any hook.
    const args = [
      'push',
      '--porcelain',
      '--progress',
      '--no-force',
      '--no-mirror',
      '--no-follow-tags',
      ...(result.upstream ? ['--set-upstream'] : []),
      '--',
      result.remote,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ];
    const append = (data: Buffer): void => {
      result.output = (result.output + data.toString()).slice(-LIMIT);
    };
    // Exit code kept as a result; the visible output is the streamed tail, the captured buffer only has to outlast a verbose remote.
    result.exitCode = (
      await runGitProcess(['-C', root, ...args], { env: gitEnv(), maxBuffer: 16 * 1024 * 1024, onOutput: append })
    ).code;
    result.status = result.exitCode === 0 ? 'succeeded' : 'failed';
  } catch (cause) {
    result.status = 'failed';
    result.output += errorMessage(cause);
  }
}

async function execute(
  path: string,
  op: PushOperation,
  options: PushOptions,
  gate: WorktreeGate,
  db: CerebroDatabase | undefined,
  catalog: Catalog | undefined,
  resolver: ConflictResolver,
): Promise<void> {
  const root = await repositoryRoot(path);
  if (!options.allowDirty && (await isDirty(root))) {
    throw new Error('Le dépôt a des changements : préparez un commit avant de pousser.');
  }
  const branch = await currentBranch(root);
  if (!branch) throw new Error('HEAD détachée : choisissez une branche.');
  op.branch = branch;
  op.head = await git(root, ['rev-parse', '--verify', 'HEAD']);
  if (
    (options.expectedHead !== undefined && options.expectedHead !== op.head) ||
    (options.expectedBranch !== undefined && options.expectedBranch !== `refs/heads/${branch}`)
  )
    throw new Error('La branche ou HEAD a changé avant le push ; vérifiez les nouveaux commits.');
  const remotes = (await git(root, ['remote'])).split('\n').filter(Boolean);
  if (remotes.length === 0) throw new Error('Aucun remote configuré.');
  const upstream = await git(root, ['config', '--get', `branch.${branch}.remote`]).catch(() => '');
  const merge = await git(root, ['config', '--get', `branch.${branch}.merge`]).catch(() => '');
  if (Boolean(upstream) !== Boolean(merge))
    throw new Error('Configuration upstream incomplète : corrigez-la avant de pousser.');
  const upstreamRemote = upstream
    ? null
    : remotes.includes('origin')
      ? 'origin'
      : remotes.length === 1
        ? remotes[0]
        : null;
  if (!upstream && upstreamRemote === null) {
    throw new Error('Plusieurs remotes sans origin ni upstream : choisissez explicitement un upstream dans Git.');
  }

  const syncRemote = upstream || upstreamRemote;
  const remoteBranch = (merge || `refs/heads/${branch}`).replace(/^refs\/heads\//, '');
  const trackingRef = syncRemote && syncRemote !== '.' ? `refs/remotes/${syncRemote}/${remoteBranch}` : '';
  const upstreamLabel = syncRemote ? (syncRemote === '.' ? remoteBranch : `${syncRemote}/${remoteBranch}`) : '';

  const appendSync = (data: Buffer): void => {
    op.syncOutput = ((op.syncOutput ?? '') + data.toString()).slice(-LIMIT);
  };

  const syncWithUpstream = async (): Promise<boolean> => {
    if (!syncRemote) return false;
    await assertSafeToRebaseOnPush(root, db);
    let upstreamCommit: string;
    if (syncRemote === '.') {
      upstreamCommit = await git(root, ['rev-parse', '--verify', merge || `refs/heads/${remoteBranch}`]).catch(
        () => '',
      );
    } else {
      const fetched = await runGitProcess(
        [
          '-C',
          root,
          '-c',
          'gc.auto=0',
          'fetch',
          '--quiet',
          '--no-write-fetch-head',
          '--no-auto-maintenance',
          '--',
          syncRemote,
          `+refs/heads/${remoteBranch}:${trackingRef}`,
        ],
        { env: gitEnv(), maxBuffer: 16 * 1024 * 1024, onOutput: appendSync },
      );
      if (fetched.code !== 0) return false;
      upstreamCommit = await git(root, ['rev-parse', '--verify', trackingRef]).catch(() => '');
    }
    if (!upstreamCommit) return false;

    const currentHead = op.head!;
    const counts = await git(root, ['rev-list', '--left-right', '--count', `${upstreamCommit}...${currentHead}`, '--']);
    const [behindText, aheadText] = counts.split(/\s+/);
    const behind = Number(behindText);
    const ahead = Number(aheadText);
    if (!Number.isFinite(behind) || behind <= 0) return false;

    const release = gate.lock([root]);
    try {
      await assertSafeToRebaseOnPush(root, db);
      if ((await currentBranch(root)) !== branch || (await git(root, ['rev-parse', 'HEAD'])) !== currentHead) {
        throw new Error('La branche ou HEAD a changé avant la synchronisation ; relancez après vérification.');
      }
      if (!options.allowDirty && (await isDirty(root))) {
        throw new Error('Des modifications locales sont apparues avant la synchronisation.');
      }

      if (ahead === 0) {
        try {
          await runGit(root, ['read-tree', '-m', '-u', currentHead, upstreamCommit], { kind: 'write' });
        } catch (cause) {
          if (cause instanceof GitError) {
            throw new Error(
              'Des modifications locales non commitées touchent des fichiers mis à jour sur le remote : commitez ou annulez-les avant de pousser.',
              { cause },
            );
          }
          throw cause;
        }
        try {
          await runGit(
            root,
            [
              'update-ref',
              '-m',
              `cerebro: avance rapide sur ${upstreamLabel}`,
              `refs/heads/${branch}`,
              upstreamCommit,
              currentHead,
            ],
            { kind: 'write' },
          );
        } catch (cause) {
          await runGit(root, ['read-tree', '-m', '-u', upstreamCommit, currentHead], { kind: 'write' }).catch(() => {});
          throw cause;
        }
        op.rebasedFrom ??= currentHead;
        op.head = upstreamCommit;
        return true;
      }

      const settings = resolveRebaseSettings(root, db, catalog);
      const rebased = await rebaseOntoUpstream({
        root,
        branch,
        beforeHead: currentHead,
        upstreamLabel,
        upstreamCommit,
        allowDirty: Boolean(options.allowDirty),
        settings,
        resolver,
        onOutput: appendSync,
        verifyBeforeApply: () => assertSafeToRebaseOnPush(root, db),
      });
      op.rebasedFrom ??= currentHead;
      op.head = rebased.afterHead;
      if (rebased.resolvedFiles.length > 0) {
        op.resolvedFiles = [...new Set([...(op.resolvedFiles ?? []), ...rebased.resolvedFiles])];
      }
      return true;
    } finally {
      release();
    }
  };

  op.remotes = remotes.map((remote) => ({
    remote,
    status: 'pending',
    upstream: remote === upstreamRemote,
    exitCode: null,
    output: '',
  }));

  let syncAttempts = 0;
  // When local tracking refs already know upstream is ahead (e.g. from AutoFetch), rebase before the first push attempt.
  if (trackingRef) {
    const knownUpstream = await git(root, ['rev-parse', '--verify', '--quiet', trackingRef]).catch(() => '');
    if (knownUpstream) {
      const behindKnown = Number(
        await git(root, ['rev-list', '--count', `${op.head}..${knownUpstream}`, '--']).catch(() => '0'),
      );
      if (behindKnown > 0) {
        syncAttempts++;
        await syncWithUpstream();
      }
    }
  }

  // Push the authoritative upstream remote first so any needed rebase happens before secondary mirrors receive commits.
  const executionOrder = [...op.remotes].sort((a, b) =>
    a.remote === syncRemote ? -1 : b.remote === syncRemote ? 1 : 0,
  );

  for (const result of executionOrder) {
    await pushSingleRemote(root, branch, op.head, result);
    if (
      result.remote === syncRemote &&
      result.status === 'failed' &&
      syncAttempts < MAX_SYNC_ATTEMPTS &&
      isNonFastForwardPushOutput(result.output)
    ) {
      while (
        result.status === 'failed' &&
        syncAttempts < MAX_SYNC_ATTEMPTS &&
        isNonFastForwardPushOutput(result.output)
      ) {
        syncAttempts++;
        try {
          const synced = await syncWithUpstream();
          if (!synced) break;
        } catch (syncCause) {
          const msg = errorMessage(syncCause);
          op.error = msg;
          result.output = `${result.output}\n${msg}`.slice(-LIMIT);
          break;
        }
        await pushSingleRemote(root, branch, op.head, result);
      }
    }
  }

  op.status = op.remotes.every((remote) => remote.status === 'succeeded') ? 'succeeded' : 'failed';
}
