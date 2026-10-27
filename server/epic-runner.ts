import { createHash, randomUUID } from 'node:crypto';
import type { CerebroDatabase, SessionDefaults, Task } from './db.ts';
import type { CommandExecutor } from './commands.ts';
import type { SessionManager } from './sessions.ts';
import { workspaceFor, type WorkspaceContext } from './provenance.ts';
import { EpicWorkspaceConflict, type EpicWorkspaces } from './epic-workspace.ts';
import { epicReviewInstructions, epicReviewScope } from './epic-review.ts';
import { isReviewTask } from '../shared/epic-review.ts';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { canonicalWorktreePath } from './worktree-gate.ts';
export interface EpicRun {
  id: string;
  epicId: string;
  projectId: string;
  status: 'running' | 'waiting-validation' | 'blocked' | 'failed' | 'stopped' | 'succeeded';
  order: string[];
  members: string[];
  versions: Record<string, string>;
  results: Record<string, string>;
  currentTaskId: string | null;
  sessionId: string | null;
  commandRunId: string | null;
  stepStartedAt: number;
  contextRoot: string;
  options: SessionDefaults;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  // When the step's session was first seen waiting; null once it is no longer waiting.
  waitingSince?: number | null;
  // Explicit criteria reported by the current step, retained through blocking and replanning.
  validationReason?: string | null;
  autoValidate?: boolean;
  // Why a blocked run is blocked: 'session-waiting' clears by itself once the step's session stops waiting or its task is done; any other block needs an explicit resume.
  blockReason?: 'session-waiting' | null;
  // HEAD of the project folder when the run started: base of the epic review when work is not isolated in a worktree.
  baseHead?: string | null;
  workspace?: WorkspaceContext | null;
  workspaceConflict?: boolean;
}
const headOf = (path: string): string | null => {
  try {
    return (
      execFileSync('git', ['-C', path, 'rev-parse', '--verify', 'HEAD'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
};
const askedQuestion = (session: { status: string; attentionReason: string | null }): boolean =>
  session.status === 'waiting' && !!session.attentionReason?.startsWith('Question : ');
const version = (t: Task): string =>
  createHash('sha256')
    .update(JSON.stringify([t.text, t.dependsOn.slice().sort(), t.execution, t.epicId]))
    .digest('hex');
export function taskOrder(tasks: Task[], all: Task[]): Task[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  const ids = new Set(tasks.map((t) => t.id));
  const placed = new Set<string>();
  const result: Task[] = [];
  for (const task of tasks)
    for (const id of task.dependsOn) {
      const dependency = byId.get(id);
      if (!dependency) throw new Error('Dépendance introuvable.');
      if (!ids.has(id) && dependency.status !== 'done') throw new Error('Dépendance hors epic non terminée.');
    }
  while (result.length < tasks.length) {
    const next = tasks.find((t) => !placed.has(t.id) && t.dependsOn.every((id) => !ids.has(id) || placed.has(id)));
    if (!next) throw new Error('Cycle de dépendances.');
    result.push(next);
    placed.add(next.id);
  }
  return result;
}
export class EpicRunner {
  onResult: (run: EpicRun) => void = () => {};
  // A session often waits briefly at launch (accepted startup prompt, false positive of the screen heuristic): only a lasting wait blocks the run.
  waitingGraceMs = 12_000;
  private db: CerebroDatabase;
  private sessions: SessionManager;
  private commands: CommandExecutor;
  private workspaces: EpicWorkspaces;
  private broadcast: (event: unknown) => void;
  private busy = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private inFlight = new Set<Promise<void>>();
  constructor(
    db: CerebroDatabase,
    sessions: SessionManager,
    commands: CommandExecutor,
    broadcast: (event: unknown) => void,
    workspaces: EpicWorkspaces,
  ) {
    this.db = db;
    this.sessions = sessions;
    this.commands = commands;
    this.workspaces = workspaces;
    this.broadcast = broadcast;
  }
  initialize(): void {
    this.timer = setInterval(() => this.poke(), 1000);
    this.timer.unref();
    this.poke();
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }
  async shutdown(): Promise<void> {
    this.close();
    await Promise.allSettled([...this.inFlight]);
  }
  list(epicId?: string): EpicRun[] {
    const rows = this.db.connection
      .prepare(
        epicId
          ? 'SELECT data FROM epic_runs WHERE epic_id=? ORDER BY rowid DESC'
          : 'SELECT data FROM epic_runs ORDER BY rowid DESC',
      )
      .all(...(epicId ? [epicId] : [])) as { data: string }[];
    const contexts = new Map<string, WorkspaceContext | null | undefined>();
    const conflicts = new Set<string>();
    return rows.map((row) => {
      const run = JSON.parse(row.data) as EpicRun;
      // An ambiguous legacy epic must remain inspectable; start/resume report the conflict explicitly.
      if (!contexts.has(run.epicId)) {
        let context: WorkspaceContext | null | undefined;
        try {
          context = this.workspaces.current(run.epicId);
        } catch (cause) {
          if (cause instanceof EpicWorkspaceConflict) conflicts.add(run.epicId);
        }
        contexts.set(run.epicId, context);
      }
      const context = contexts.get(run.epicId);
      const workspace = context === undefined ? (run.workspace ?? null) : context;
      return {
        ...run,
        workspace,
        contextRoot: workspace?.path ?? run.contextRoot,
        workspaceConflict: conflicts.has(run.epicId),
      };
    });
  }
  reserved(taskId: string): boolean {
    return this.list().some(
      (r) => ['running', 'waiting-validation', 'blocked'].includes(r.status) && r.order.includes(taskId),
    );
  }
  private save(run: EpicRun, updateSettings = false): void {
    const previous = this.list(run.epicId).find((r) => r.id === run.id);
    // A setting can change while an asynchronous launch holds an older copy of the run.
    if (!updateSettings) run.autoValidate = previous?.autoValidate ?? run.autoValidate ?? false;
    run.updatedAt = Date.now();
    this.db.connection
      .prepare('INSERT INTO epic_runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(run.id, run.epicId, JSON.stringify(run));
    if (
      ['failed', 'succeeded', 'blocked'].includes(run.status) &&
      (previous?.status !== run.status || previous?.error !== run.error)
    )
      this.onResult(run);
  }
  private changeTask(id: string, patch: Parameters<CerebroDatabase['updateTask']>[1]): void {
    const task = this.db.updateTask(id, patch);
    if (task) this.broadcast({ type: 'task', task });
  }
  private plan(epicId: string) {
    const epic = this.db.getEpic(epicId);
    if (!epic) throw new Error('Epic introuvable.');
    const all = this.db.listTasks().filter((t) => t.projectId === epic.projectId);
    const members = all.filter((t) => t.epicId === epicId);
    const open = members.filter((t) => t.status !== 'done');
    for (const task of open)
      if (this.commands.active(task.id) || (task.sessionId && this.db.getSession(task.sessionId)?.status !== 'exited'))
        throw new Error('Une tâche est déjà confiée à une exécution active.');
    return { epic, members, order: taskOrder(open, all) };
  }
  start(epicId: string, options: SessionDefaults): EpicRun {
    const runs = this.list(epicId);
    if (runs.some((r) => ['running', 'waiting-validation', 'blocked'].includes(r.status)))
      throw new Error('Epic déjà en cours : utilisez reprendre ou arrêter.');
    const { epic, members, order } = this.plan(epicId);
    if (!order.length) throw new Error('Aucune tâche ouverte.');
    const project = this.db.getProject(epic.projectId)!;
    const previous = runs[0];
    const workspace = this.workspaces.current(epicId);
    if (workspace) this.workspaces.assert(workspace);
    const contextRoot = workspace?.path ?? project.path;
    // A later run (for example review fixes) continues the work and keeps its original review base.
    const baseHead =
      previous?.contextRoot === contextRoot ? (previous.baseHead ?? headOf(contextRoot)) : headOf(contextRoot);
    const run: EpicRun = {
      id: randomUUID(),
      epicId,
      projectId: epic.projectId,
      status: 'running',
      order: order.map((t) => t.id),
      members: members.map((t) => t.id),
      versions: Object.fromEntries(order.map((t) => [t.id, version(t)])),
      results: {},
      currentTaskId: null,
      sessionId: null,
      commandRunId: null,
      stepStartedAt: 0,
      contextRoot,
      workspace,
      baseHead,
      options,
      error: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.save(run);
    this.poke();
    return run;
  }
  report(
    sessionId: string,
    taskId: string,
    status: 'failed' | 'blocked' | 'waiting-validation',
    message: string,
  ): EpicRun {
    const run = this.list().find(
      (r) =>
        r.currentTaskId === taskId &&
        r.sessionId === sessionId &&
        ['running', 'waiting-validation', 'blocked'].includes(r.status),
    );
    if (!run || this.db.getTask(taskId)?.sessionId !== sessionId)
      throw new Error('Cette étape n’est pas confiée à cette session.');
    run.results[taskId] = status;
    run.status = status;
    run.error = message;
    run.validationReason = status === 'waiting-validation' ? message : null;
    run.blockReason = null;
    this.save(run);
    return run;
  }
  setAutoValidate(id: string, enabled: boolean): EpicRun {
    const run = this.list().find((r) => r.id === id);
    if (!run) throw new Error('Exécution introuvable.');
    if (!['running', 'waiting-validation', 'blocked'].includes(run.status))
      throw new Error('Cette exécution n’est plus en cours.');
    run.autoValidate = enabled;
    this.save(run, true);
    this.poke();
    return run;
  }
  async stop(id: string): Promise<EpicRun> {
    const run = this.list().find((r) => r.id === id);
    if (!run) throw new Error('Exécution introuvable.');
    run.status = 'stopped';
    run.error = 'Arrêt demandé par l’utilisateur.';
    this.save(run);
    if (run.commandRunId) this.commands.stop(run.commandRunId);
    if (run.sessionId) this.sessions.kill(run.sessionId);
    return run;
  }
  selectWorkspace(epicId: string, path: string): WorkspaceContext {
    if (!this.db.getEpic(epicId)) throw new Error('Epic introuvable.');
    const runs = this.list(epicId);
    if (
      runs.some(
        (run) =>
          this.busy.has(run.id) ||
          run.status === 'running' ||
          run.status === 'waiting-validation' ||
          (run.status === 'blocked' && run.blockReason === 'session-waiting'),
      )
    )
      throw new Error('Arrêtez l’epic avant de choisir son dossier de travail.');
    const tasks = this.db.listTasks().filter((task) => task.epicId === epicId);
    if (
      tasks.some(
        (task) =>
          this.commands.active(task.id) ||
          (task.status !== 'done' && task.sessionId && this.db.getSession(task.sessionId)?.status !== 'exited'),
      ) ||
      this.db
        .listSessions()
        .some((session) => session.epic?.id === epicId && ['starting', 'running', 'waiting'].includes(session.status))
    )
      throw new Error('Arrêtez les étapes encore actives avant de choisir le dossier de l’epic.');
    const context = this.workspaces.select(epicId, path);
    for (const run of runs)
      if (run.status === 'blocked' && run.error?.includes('Cet epic a utilisé plusieurs dossiers de travail')) {
        run.workspace = context;
        run.contextRoot = context.path;
        run.workspaceConflict = false;
        run.blockReason = null;
        run.error = 'Dossier choisi. Reprenez l’epic pour poursuivre.';
        this.save(run);
      }
    return context;
  }
  resume(id: string, replan = false): EpicRun {
    const run = this.list().find((r) => r.id === id);
    if (!run || run.status === 'succeeded' || run.status === 'running') throw new Error('Exécution non reprenable.');
    if (this.busy.has(id)) throw new Error('Une étape est encore en cours de lancement.');
    const another = this.list(run.epicId).some(
      (r) => r.id !== id && ['running', 'waiting-validation', 'blocked'].includes(r.status),
    );
    if (another) throw new Error('Une autre exécution est active.');
    const workspace = this.workspaces.current(run.epicId);
    if (workspace) {
      this.workspaces.assert(workspace);
      run.workspace = workspace;
      run.contextRoot = workspace.path;
    }
    if (run.currentTaskId) {
      const task = this.db.getTask(run.currentTaskId);
      const session = run.sessionId ? this.db.getSession(run.sessionId) : null;
      const command = run.commandRunId ? this.commands.listRuns().find((r) => r.id === run.commandRunId) : null;
      if (session?.status === 'waiting') throw new Error('Répondez d’abord à la question de la session.');
      const prior = session ? workspaceFor(this.db, session.id) : null;
      const elsewhere =
        workspace &&
        ((prior && canonicalWorktreePath(prior.path) !== canonicalWorktreePath(workspace.path)) ||
          (command &&
            canonicalWorktreePath(command.cwd) !==
              canonicalWorktreePath(resolve(workspace.path, command.command.cwd))));
      if (elsewhere && ((session && session.status !== 'exited') || command?.status === 'running'))
        throw new Error('Arrêtez l’étape en cours dans l’ancien dossier avant de poursuivre.');
      if (
        elsewhere ||
        (task?.status !== 'done' &&
          (!session || session.status === 'exited') &&
          command?.status !== 'running' &&
          command?.status !== 'succeeded')
      ) {
        if (!workspace && session) run.contextRoot = workspaceFor(this.db, session.id)?.path ?? run.contextRoot;
        if (task?.status !== 'done' && task) this.changeTask(task.id, { status: 'todo', sessionId: null });
        run.currentTaskId = null;
        run.sessionId = null;
        run.commandRunId = null;
        run.waitingSince = null;
        run.validationReason = null;
      }
    }
    if (replan) {
      const epic = this.db.getEpic(run.epicId);
      if (!epic) throw new Error('Epic supprimé.');
      const all = this.db.listTasks().filter((t) => t.projectId === run.projectId);
      const members = all.filter((t) => t.epicId === run.epicId);
      if (run.currentTaskId && !members.some((t) => t.id === run.currentTaskId))
        throw new Error('L’étape active a quitté l’epic : arrêtez son exécution avant de recalculer.');
      const order = taskOrder(
        members.filter((t) => t.status !== 'done'),
        all,
      );
      run.order = order.map((t) => t.id);
      run.members = members.map((t) => t.id);
      run.versions = Object.fromEntries(order.map((t) => [t.id, version(t)]));
    }
    run.status = 'running';
    run.error = null;
    run.blockReason = null;
    this.save(run);
    this.poke();
    return run;
  }
  poke(): void {
    if (this.closed) return;
    for (const run of this.list())
      if (!this.busy.has(run.id)) {
        if (run.status === 'blocked' && run.blockReason === 'session-waiting' && this.waitOver(run)) {
          run.status = 'running';
          run.error = null;
          run.blockReason = null;
          run.waitingSince = null;
          this.save(run);
        }
        if (!['running', 'waiting-validation'].includes(run.status)) continue;
        this.busy.add(run.id);
        const promise = this.tick(run)
          .catch((cause) => {
            if (this.list().find((r) => r.id === run.id)?.status === 'stopped') return;
            run.status = 'blocked';
            run.error = String(cause);
            run.blockReason = null;
            this.save(run);
          })
          .finally(() => {
            this.busy.delete(run.id);
            this.inFlight.delete(promise);
          });
        this.inFlight.add(promise);
      }
  }
  // The step's session no longer holds the run: it stopped waiting, or its task is done and it is not asking an explicit question.
  private waitOver(run: EpicRun): boolean {
    const session = run.sessionId ? this.db.getSession(run.sessionId) : null;
    if (!session || session.status !== 'waiting') return true;
    return this.db.getTask(run.currentTaskId ?? '')?.status === 'done' && !askedQuestion(session);
  }
  private async tick(run: EpicRun): Promise<void> {
    const stop = (status: EpicRun['status'], error: string, blockReason: EpicRun['blockReason'] = null): void => {
      run.status = status;
      run.error = error;
      run.blockReason = blockReason;
      this.save(run);
    };
    const epic = this.db.getEpic(run.epicId);
    if (!epic) {
      stop('blocked', 'Epic supprimé.');
      return;
    }
    const members = this.db.listTasks().filter((t) => t.epicId === run.epicId);
    if (
      members
        .map((t) => t.id)
        .sort()
        .join(',') !== run.members.slice().sort().join(',')
    ) {
      stop('blocked', 'Composition de l’epic modifiée : reprise avec recalcul nécessaire.');
      return;
    }
    for (const id of run.order) {
      const task = this.db.getTask(id);
      if (!task || version(task) !== run.versions[id]) {
        stop('blocked', 'Tâche ou dépendances modifiées : reprise avec recalcul nécessaire.');
        return;
      }
    }
    if (run.currentTaskId) {
      const task = this.db.getTask(run.currentTaskId)!;
      if (task.dependsOn.some((id) => this.db.getTask(id)?.status !== 'done')) {
        stop('blocked', 'Un prérequis de l’étape courante a été rouvert.');
        return;
      }
      if (task.execution.type === 'command') {
        const command = this.commands
          .listRuns(task.id)
          .find((r) => r.id === run.commandRunId || (!run.commandRunId && r.startedAt >= run.stepStartedAt));
        if (!command) {
          stop('blocked', 'Lancement de commande interrompu : vérifiez puis reprenez explicitement.');
          return;
        }
        run.commandRunId = command.id;
        if (command.status === 'running') {
          this.save(run);
          return;
        }
        if (command.status !== 'succeeded') {
          run.results[task.id] = command.status;
          stop('failed', command.error ?? `Échec de commande : ${command.status}, code ${command.exitCode}`);
          return;
        }
        const autoValidated = task.status !== 'done' && task.execution.completion !== 'exit-zero' && run.autoValidate;
        if (task.status !== 'done' && (task.execution.completion === 'exit-zero' || autoValidated))
          this.changeTask(task.id, { status: 'done' });
        else if (task.status !== 'done') {
          run.results[task.id] = 'execution-succeeded';
          stop('waiting-validation', 'Commande réussie ; validation explicite du travail attendue.');
          return;
        }
        run.results[task.id] =
          task.execution.completion === 'exit-zero'
            ? 'criterion-exit-zero'
            : autoValidated
              ? 'auto-validated'
              : 'validated';
      } else {
        const marker = `[CEREBRO_EPIC_STEP ${run.id} ${task.id}]`;
        const session = run.sessionId
          ? this.db.getSession(run.sessionId)
          : this.db.listSessions().find((s) => s.prompt.startsWith(marker));
        if (!session) {
          stop('blocked', 'Lancement de session interrompu : vérifiez puis reprenez explicitement.');
          return;
        }
        run.sessionId = session.id;
        if (task.sessionId !== session.id) this.changeTask(task.id, { sessionId: session.id, status: 'started' });
        if (session.status === 'running' || session.status === 'starting') {
          run.waitingSince = null;
          this.save(run);
          return;
        }
        // An explicit question (cerebro-notify --ask) blocks at once; any other wait must last beyond the grace delay.
        if (session.status === 'waiting' && !askedQuestion(session)) {
          run.waitingSince ??= session.updatedAt;
          if (Date.now() - run.waitingSince < this.waitingGraceMs) {
            this.save(run);
            return;
          }
        } else run.waitingSince = null;
        const autoValidated =
          task.status !== 'done' &&
          run.autoValidate &&
          (session.status === 'idle' || (session.status === 'exited' && session.exitCode === 0));
        if (autoValidated) this.changeTask(task.id, { status: 'done' });
        if (task.status !== 'done' && !autoValidated) {
          if (session.status === 'exited' && session.exitCode !== null && session.exitCode !== 0) {
            run.results[task.id] = 'failed';
            stop('failed', `Session sortie avec code ${session.exitCode}.`);
            return;
          }
          // Keep the agent's validation requirements instead of replacing them with the generic end-of-turn notice.
          const reason =
            (session.status !== 'waiting' ? run.validationReason : null) ??
            session.attentionReason ??
            'Tour terminé sans clôture explicite de la tâche.';
          run.results[task.id] = session.status === 'waiting' ? 'blocked' : 'waiting-validation';
          stop(
            session.status === 'waiting' ? 'blocked' : 'waiting-validation',
            reason,
            session.status === 'waiting' ? 'session-waiting' : null,
          );
          return;
        }
        // Once the step is declared done, only an explicit question holds it: a lasting screen-detected wait no longer matters.
        if (askedQuestion(session)) {
          stop('blocked', 'Une question de la session reste en attente.', 'session-waiting');
          return;
        }
        run.contextRoot = workspaceFor(this.db, session.id)?.path ?? run.contextRoot;
        run.results[task.id] = autoValidated ? 'auto-validated' : 'declared-done';
        // The step is closed and its turn is over: free the terminal so finished steps do not pile up. The workspace stays for the next step.
        if (session.status !== 'exited') this.sessions.kill(session.id);
      }
      run.currentTaskId = null;
      run.sessionId = null;
      run.commandRunId = null;
      run.waitingSince = null;
      run.validationReason = null;
      run.status = 'running';
      run.error = null;
      this.save(run);
    }
    const pending = run.order.map((id) => this.db.getTask(id)!).filter((t) => t.status !== 'done');
    if (!pending.length) {
      run.status = 'succeeded';
      run.error = null;
      this.save(run);
      return;
    }
    const next = pending.find((t) => t.dependsOn.every((id) => this.db.getTask(id)?.status === 'done'));
    if (!next) {
      stop('blocked', 'Aucune tâche éligible : dépendance non satisfaite.');
      return;
    }
    if (this.commands.active(next.id) || (next.sessionId && this.db.getSession(next.sessionId)?.status !== 'exited')) {
      stop('blocked', 'La tâche suivante possède déjà une exécution active.');
      return;
    }
    run.currentTaskId = next.id;
    run.stepStartedAt = Date.now();
    this.save(run);
    if (next.execution.type === 'command') {
      const operation = await this.workspaces.withPreparation(run.epicId, async () => {
        const workspace = this.workspaces.current(run.epicId) ?? { path: run.contextRoot, mode: 'shared' as const };
        this.workspaces.assert(workspace);
        const operation = await this.commands.start(next.id, workspace.path);
        run.workspace = this.workspaces.remember(run.epicId, workspace);
        run.contextRoot = workspace.path;
        return operation;
      });
      run.commandRunId = operation.id;
    } else {
      const project = this.db.getProject(run.projectId)!;
      const title =
        `Epic « ${epic.title} » · étape ${run.order.indexOf(next.id) + 1}/${run.order.length} : ${next.text.split('\n')[0]}`.slice(
          0,
          120,
        );
      // The review step is told what the previous steps changed; a scope that cannot be prepared leaves the agent to find it.
      const review = isReviewTask(next)
        ? `\n\n${epicReviewInstructions(epic.title, await epicReviewScope(this.db, run).catch(() => null))}`
        : '';
      const prompt = `[CEREBRO_EPIC_STEP ${run.id} ${next.id}]\nTraite uniquement cette étape de l’epic « ${epic.title} ».\n${epic.description}\n\n${next.text}${review}\n\nIdentifiant : ${next.id}\nRéalise et vérifie cette tâche, puis exécute cerebro-backlog --done ${next.id} uniquement si elle est terminée. En cas d’échec utilise cerebro-backlog --fail <id> "raison" ; en cas de blocage utilise --block ; pour une validation nécessaire utilise --await-validation. Explique le résultat et termine ton tour. Le serveur pilote l’enchaînement : ne traite aucune autre tâche.\n\nInstructions supplémentaires : ${run.options.prompt}`;
      this.changeTask(next.id, { status: 'started', sessionId: null });
      const session = await this.sessions.create(
        project,
        { ...run.options, prompt },
        async () => {
          if (this.closed || this.list().find((r) => r.id === run.id)?.status === 'stopped')
            throw new Error('Epic arrêté avant le lancement du terminal.');
          const pending = this.db.listSessions().find((s) => s.prompt === prompt);
          if (pending) {
            run.sessionId = pending.id;
            this.changeTask(next.id, { sessionId: pending.id });
            const workspace = workspaceFor(this.db, pending.id);
            if (workspace) {
              run.workspace = this.workspaces.remember(run.epicId, {
                path: workspace.path,
                mode: workspace.mode,
              });
              run.contextRoot = workspace.path;
            }
            this.save(run);
          }
        },
        run.contextRoot,
        title,
        { rememberDefaults: false, epicId: epic.id },
      );
      run.sessionId = session.id;
      this.changeTask(next.id, { sessionId: session.id });
    }
    // A stop can arrive while the holder is starting. Preserve it and stop the new operation too.
    const latest = this.list().find((r) => r.id === run.id);
    if (this.closed || latest?.status === 'stopped') {
      if (run.commandRunId) this.commands.stop(run.commandRunId);
      if (run.sessionId) this.sessions.kill(run.sessionId);
      run.status = 'stopped';
    }
    this.save(run);
  }
}
