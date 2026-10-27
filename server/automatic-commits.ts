import type { CerebroDatabase } from './db.ts';
import { assertNoGitOperation, GitOperationInProgress, type CommitPlan } from './git-plan.ts';
import { draftCommits, parseCommitProposal, type ProposalContext } from './commit-proposal.ts';
import type { Services } from './services.ts';
import { canonicalWorktreePath } from './worktree-gate.ts';
import { repositoryActivity, sessionBusy } from './repository-activity.ts';
import { INHERITED_WARNING } from './session-git.ts';
import { repositoryRoot } from './git.ts';
import type { CommitSettings } from '../shared/types.ts';
import type { AutomaticCommit, CommitResult, GitSnapshot, SessionGitSnapshot } from '../shared/git.ts';
import { errorMessage } from './util.ts';

export interface AutomaticCommitContext {
  scope: string;
  path: string;
  projectId: string | null;
  sessionId: string | null;
  settings: CommitSettings;
  prepareCommit?: () => Promise<PreparedSnapshot>;
  execute?: (plan: CommitPlan) => Promise<CommitResult>;
}
/** Session scopes return their provenance with the snapshot (SessionGit.prepareCommit). */
type PreparedSnapshot = GitSnapshot & Partial<Pick<SessionGitSnapshot, 'provenance'>>;
class CommitBlocked extends Error {}

export class AutomaticCommits {
  private db: CerebroDatabase;
  private services: Services;
  private active = new Map<string, { operation: AutomaticCommit; abort: AbortController; done: Promise<void> }>();
  private closed = false;
  onComplete: (operation: AutomaticCommit) => void = () => {};
  constructor(db: CerebroDatabase, services: Services) {
    this.db = db;
    this.services = services;
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
  /** Raw answer of the agent, checked once by `execute`. */
  async proposeCommits(context: ProposalContext, signal: AbortSignal): Promise<unknown> {
    return draftCommits(context, signal);
  }
  private async idle(path: string): Promise<void> {
    this.services.gate.assertAvailable(path);
    await assertNoGitOperation(path);
    // Its own operation is a running automatic commit of this repository: only sessions and commands block it.
    const activity = repositoryActivity(this.db, path);
    if (activity.sessions.some((session) => sessionBusy(session.status)))
      throw new CommitBlocked('Une session utilise encore ce dépôt. Attendez la fin de son tour avant de commiter.');
    if (activity.commands)
      throw new CommitBlocked('Une commande utilise encore ce dépôt. Attendez sa fin avant de commiter.');
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
    const path = canonicalWorktreePath(await repositoryRoot(context.path));
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
    this.db.transaction(() => {
      this.save(operation);
      remember(operation.id);
    }, 'IMMEDIATE');
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
      await this.idle(operation.path);
      signal.throwIfAborted();
      if ((await this.services.pushes.current(operation.path))?.status === 'running')
        throw new CommitBlocked('Un push est déjà en cours dans ce dépôt.');
      const snapshot: PreparedSnapshot = await (context.prepareCommit?.() ??
        this.services.git.prepareCommit(operation.path));
      signal.throwIfAborted();
      const shown = operation.reviewed
        ? this.services.git.reviewedDiffs(operation.reviewed.snapshotId, operation.path)
        : null;
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
        const mode = snapshot.provenance?.workspace.mode;
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
        const proposal = parseCommitProposal(await this.proposeCommits(input, signal), input);
        signal.throwIfAborted();
        await this.idle(operation.path);
        await this.services.git.verifySnapshot(operation.path, snapshot.id);
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
        const result = await (context.execute?.(plan) ?? this.services.git.executeCommitPlan(operation.path, plan));
        operation.commits = result.commits;
        this.save(operation);
        if (result.error) throw result.blocked ? new GitOperationInProgress(result.error) : new Error(result.error);
      }
      if (operation.push) {
        phase('pushing');
        await this.idle(operation.path);
        // The snapshot already checked the tree (a snapshot with only excluded files is blocked above), and
        // shared dependency links stay untracked on purpose, so a raw `git status` check would refuse them.
        operation.pushOperation = structuredClone(
          await this.services.pushes.start(operation.path, {
            allowDirty: true,
            expectedHead: operation.commits.at(-1)?.hash ?? snapshot.head,
            expectedBranch: snapshot.branch,
          }),
        );
        this.save(operation);
        while (operation.pushOperation.status === 'running') {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const latest = await this.services.pushes.current(operation.path);
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
      operation.status = signal.aborted
        ? 'cancelled'
        : cause instanceof CommitBlocked || cause instanceof GitOperationInProgress
          ? 'blocked'
          : 'failed';
      operation.error = signal.aborted ? 'Préparation annulée.' : errorMessage(cause);
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
