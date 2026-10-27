import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sep } from 'node:path';
import type { CerebroDatabase, CommitSettings } from './db.ts';
import {
  executeCommitPlan,
  prepareCommit,
  reviewedDiffs,
  verifySnapshot,
  type CommitPlan,
  type CommitResult,
  type GitSnapshot,
} from './git-plan.ts';
import { currentPush, startPush, type PushOperation } from './git-push.ts';
import { parseCommitProposal, proposeCommits, type ProposalContext, type CommitProposal } from './commit-proposal.ts';
import { assertWorktreeAvailable, canonicalWorktreePath } from './worktree-gate.ts';
import { workspaceFor } from './provenance.ts';
import { INHERITED_WARNING } from './session-git.ts';

export interface AutomaticCommit {
  id: string;
  scope: string;
  path: string;
  projectId: string | null;
  sessionId: string | null;
  settings: CommitSettings;
  push: boolean;
  status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'interrupted';
  phase: 'collecting' | 'drafting' | 'committing' | 'pushing' | 'finished';
  files: string[];
  exclusions: { path: string; reason: string }[];
  commits: CommitResult['commits'];
  pushOperation: PushOperation | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  needsProjectScope: boolean;
  /** Files the user reviewed in a diff snapshot; included despite warnings only while that diff is unchanged. */
  reviewed?: { snapshotId: string; paths: string[] };
}
export interface AutomaticCommitContext {
  scope: string;
  path: string;
  projectId: string | null;
  sessionId: string | null;
  settings: CommitSettings;
  prepare?: () => Promise<GitSnapshot>;
  execute?: (plan: CommitPlan) => Promise<CommitResult>;
}
class CommitBlocked extends Error {}
const exec = promisify(execFile);
const inside = (root: string, path: string): boolean => {
  const cwd = canonicalWorktreePath(path);
  return cwd === root || cwd.startsWith(root + sep);
};

export class AutomaticCommits {
  private db: CerebroDatabase;
  private active = new Map<string, { operation: AutomaticCommit; abort: AbortController; done: Promise<void> }>();
  private closed = false;
  onComplete: (operation: AutomaticCommit) => void = () => {};
  constructor(db: CerebroDatabase) {
    this.db = db;
    for (const operation of this.list())
      if (operation.status === 'running') {
        operation.status = 'interrupted';
        operation.phase = 'finished';
        operation.finishedAt = Date.now();
        operation.error =
          'Serveur redémarré : vérifiez les commits et le push avant de relancer. Aucune action rejouée.';
        this.save(operation);
      }
  }
  list(): AutomaticCommit[] {
    return (
      this.db.connection.prepare('SELECT data FROM automatic_commits ORDER BY rowid DESC').all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  get(id: string): AutomaticCommit | null {
    return this.list().find((operation) => operation.id === id) ?? null;
  }
  private save(operation: AutomaticCommit): void {
    this.db.connection
      .prepare('INSERT INTO automatic_commits VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(operation.id, JSON.stringify(operation));
  }
  async propose(context: ProposalContext, signal: AbortSignal): Promise<CommitProposal> {
    return proposeCommits(context, signal);
  }
  private idle(path: string): void {
    assertWorktreeAvailable(path);
    for (const session of this.db.listSessions()) {
      const cwd = workspaceFor(this.db, session.id)?.root ?? this.db.getProject(session.projectId)?.path;
      if (cwd && inside(path, cwd) && ['starting', 'running', 'waiting'].includes(session.status))
        throw new CommitBlocked('Une session utilise encore ce dépôt. Attendez la fin de son tour avant de commiter.');
    }
    for (const row of this.db.connection.prepare('SELECT data FROM command_runs').all() as { data: string }[]) {
      const run = JSON.parse(row.data);
      if (run.status === 'running' && inside(path, run.cwd))
        throw new CommitBlocked('Une commande utilise encore ce dépôt. Attendez sa fin avant de commiter.');
    }
  }
  async start(
    context: AutomaticCommitContext,
    id: unknown,
    push: unknown,
    reviewed?: unknown,
    strategy?: unknown,
  ): Promise<AutomaticCommit> {
    if (this.closed) throw new Error('Serveur en cours d’arrêt.');
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id) || typeof push !== 'boolean')
      throw new Error('Identifiant de lancement ou option push invalide.');
    if (strategy !== undefined && strategy !== 'single' && strategy !== 'atomic')
      throw new Error('Stratégie de commit invalide.');
    const review = reviewed as AutomaticCommit['reviewed'] | undefined;
    if (
      review !== undefined &&
      (typeof review?.snapshotId !== 'string' ||
        !Array.isArray(review.paths) ||
        !review.paths.every((path) => typeof path === 'string'))
    )
      throw new Error('Sélection des fichiers examinés invalide.');
    const path = canonicalWorktreePath(
      (await exec('git', ['-C', context.path, 'rev-parse', '--show-toplevel'])).stdout.trim(),
    );
    if (this.closed) throw new Error('Serveur en cours d’arrêt.');
    const request = this.db.connection
      .prepare('SELECT operation_id,scope,push FROM automatic_commit_requests WHERE id=?')
      .get(id) as { operation_id: string; scope: string; push: number } | undefined;
    if (request && (request.scope !== context.scope || Boolean(request.push) !== push))
      throw new Error('Ce lancement correspond à une autre action.');
    const previous = this.get(request?.operation_id ?? id);
    if (previous) {
      if (
        previous.scope !== context.scope ||
        previous.push !== push ||
        (strategy !== undefined && previous.settings.strategy !== strategy)
      )
        throw new Error('Ce lancement correspond à une autre action.');
      return previous;
    }
    if (request) throw new Error('Le résultat de ce lancement n’est plus disponible. Vérifiez Git avant de relancer.');
    const effectiveStrategy = strategy ?? context.settings.strategy;
    const remember = (operationId: string): void => {
      this.db.connection
        .prepare('INSERT INTO automatic_commit_requests VALUES (?,?,?,?)')
        .run(id, operationId, context.scope, push ? 1 : 0);
    };
    const active = this.active.get(path);
    if (active) {
      if (
        active.operation.scope !== context.scope ||
        active.operation.push !== push ||
        active.operation.settings.strategy !== effectiveStrategy
      )
        throw new Error('Un commit est déjà en préparation dans ce dépôt.');
      remember(active.operation.id);
      return active.operation;
    }
    const operation: AutomaticCommit = {
      id,
      scope: context.scope,
      path,
      projectId: context.projectId,
      sessionId: context.sessionId,
      settings: { ...context.settings, strategy: effectiveStrategy },
      push,
      status: 'running',
      phase: 'collecting',
      files: [],
      exclusions: [],
      commits: [],
      pushOperation: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      needsProjectScope: false,
      ...(review ? { reviewed: { snapshotId: review.snapshotId, paths: [...new Set(review.paths)] } } : {}),
    };
    this.db.connection.exec('BEGIN IMMEDIATE');
    try {
      this.save(operation);
      remember(operation.id);
      this.db.connection.exec('COMMIT');
    } catch (cause) {
      this.db.connection.exec('ROLLBACK');
      throw cause;
    }
    const abort = new AbortController();
    const done = Promise.resolve()
      .then(() => this.execute(context, operation, abort.signal))
      .finally(() => this.active.delete(path));
    this.active.set(path, { operation, abort, done });
    return operation;
  }
  cancel(id: string): AutomaticCommit {
    const active = [...this.active.values()].find((item) => item.operation.id === id);
    if (!active) throw new Error('Cette opération est déjà terminée.');
    if (active.operation.phase !== 'collecting' && active.operation.phase !== 'drafting')
      throw new Error('Git a commencé ; attendez son résultat pour conserver un état vérifiable.');
    active.abort.abort();
    return active.operation;
  }
  private async execute(
    context: AutomaticCommitContext,
    operation: AutomaticCommit,
    signal: AbortSignal,
  ): Promise<void> {
    const phase = (value: AutomaticCommit['phase']): void => {
      signal.throwIfAborted();
      operation.phase = value;
      this.save(operation);
    };
    try {
      this.idle(operation.path);
      signal.throwIfAborted();
      if ((await currentPush(operation.path))?.status === 'running')
        throw new CommitBlocked('Un push est déjà en cours dans ce dépôt.');
      const snapshot = await (context.prepare?.() ?? prepareCommit(operation.path));
      signal.throwIfAborted();
      const shown = operation.reviewed ? reviewedDiffs(operation.reviewed.snapshotId, operation.path) : null;
      // A secret is never acknowledged; other warnings yield to a review of this exact diff.
      const acknowledged = snapshot.files
        .filter(
          (file) =>
            !file.blocked &&
            file.warnings.length &&
            operation.reviewed?.paths.includes(file.path) &&
            shown?.get(file.path) === file.diff,
        )
        .map((file) => file.path);
      const eligible = snapshot.files.filter(
        (file) => !file.blocked && (!file.warnings.length || acknowledged.includes(file.path)),
      );
      const staleReview = (path: string): string | null =>
        !operation.reviewed?.paths.includes(path)
          ? null
          : !shown
            ? 'Examen expiré : réaffichez les diffs puis recommencez.'
            : 'Modifié depuis votre examen : réexaminez son diff.';
      operation.exclusions = snapshot.files
        .filter((file) => !eligible.includes(file))
        .map((file) => ({
          path: file.path,
          reason:
            [...file.warnings, ...(file.blocked ? [] : [staleReview(file.path) ?? ''])].filter(Boolean).join(' ; ') ||
            'Fichier exclu par le scanner.',
        }));
      operation.files = eligible.map((file) => file.path);
      this.save(operation);
      if (snapshot.files.length && !eligible.length) {
        const mode = (snapshot as GitSnapshot & { provenance?: { workspace: { mode: string } } }).provenance?.workspace
          .mode;
        operation.needsProjectScope = mode === 'unknown' || mode === 'shared';
        throw new CommitBlocked(
          operation.needsProjectScope
            ? 'Cette ancienne conversation ne permet pas d’attribuer les changements. Pour traiter le dépôt entier, utilisez les boutons de commit dans l’en-tête du projet.'
            : snapshot.files.every((file) => file.warnings.includes(INHERITED_WARNING))
              ? 'Rien de nouveau à commiter : ces fichiers ont encore le contenu copié du projet à la création de la copie. Ils ne sont pas le travail de cette conversation.'
              : 'Tous les fichiers demandent une vérification : aucun commit automatique ne peut être créé.',
        );
      }
      if (eligible.length) {
        phase('drafting');
        const input = { settings: operation.settings, files: eligible, log: snapshot.log };
        const proposal = parseCommitProposal(await this.propose(input, signal), input);
        signal.throwIfAborted();
        this.idle(operation.path);
        await verifySnapshot(operation.path, snapshot.id);
        signal.throwIfAborted();
        const plan: CommitPlan = {
          snapshotId: snapshot.id,
          push: false,
          acknowledged,
          commits: proposal.commits.map((step) => ({
            message: step.message,
            selection: step.paths.map((path) => ({ path, all: true })),
          })),
        };
        phase('committing');
        const result = await (context.execute?.(plan) ?? executeCommitPlan(operation.path, plan));
        operation.commits = result.commits;
        this.save(operation);
        if (result.error) throw new Error(result.error);
      }
      if (operation.push) {
        phase('pushing');
        this.idle(operation.path);
        // The snapshot already checked the tree (a snapshot with only excluded files is blocked above), and
        // shared dependency links stay untracked on purpose, so a raw `git status` check would refuse them.
        operation.pushOperation = structuredClone(
          await startPush(operation.path, {
            allowDirty: true,
            expectedHead: operation.commits.at(-1)?.hash ?? snapshot.head,
            expectedBranch: snapshot.branch,
          }),
        );
        this.save(operation);
        while (operation.pushOperation.status === 'running') {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const latest = await currentPush(operation.path);
          if (!latest || latest.id !== operation.pushOperation.id)
            throw new Error('Le résultat du push n’est plus disponible ; vérifiez les remotes.');
          operation.pushOperation = structuredClone(latest);
          this.save(operation);
        }
        if (operation.pushOperation.status !== 'succeeded')
          throw new Error(
            operation.pushOperation.error ??
              'Le push a échoué sur au moins un remote. Les commits créés sont conservés.',
          );
      }
      operation.status = 'succeeded';
    } catch (cause) {
      operation.status = signal.aborted ? 'cancelled' : cause instanceof CommitBlocked ? 'blocked' : 'failed';
      operation.error = signal.aborted
        ? 'Préparation annulée.'
        : cause instanceof Error
          ? cause.message
          : String(cause);
    } finally {
      operation.phase = 'finished';
      operation.finishedAt = Date.now();
      this.save(operation);
      this.onComplete(operation);
    }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const item of this.active.values()) item.abort.abort();
    await Promise.allSettled([...this.active.values()].map((item) => item.done));
  }
}
