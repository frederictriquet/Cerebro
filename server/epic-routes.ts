import { epicReviewInstructions, epicReviewScope, reviewTaskText } from './epic-review.ts';
import { isReviewTask } from '../shared/epic-review.ts';
import { isActiveRun } from '../shared/backlog.ts';
import type { Epic } from '../shared/types.ts';
import { asRecord } from './util.ts';
import { error } from './routes-util.ts';
import { conflict, parseSessionDefaults, type RouteContext } from './route-context.ts';
import { MAX_TASK_LENGTH } from './task-routes.ts';

const MAX_EPIC_TITLE_LENGTH = 200;

export function epicTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title === '' || title.length > MAX_EPIC_TITLE_LENGTH ? null : title;
}

export function epicDescription(value: unknown): string | null {
  if (value === undefined) return '';
  if (typeof value !== 'string') return null;
  const description = value.trim();
  return description.length > MAX_TASK_LENGTH ? null : description;
}

export const EPIC_TITLE_ERROR = `Le titre de l'epic doit contenir entre 1 et ${MAX_EPIC_TITLE_LENGTH} caractères`;
export const EPIC_DESCRIPTION_ERROR = `La description de l'epic doit contenir au plus ${MAX_TASK_LENGTH} caractères`;

// Valide { title, description?, taskIds? } puis crée l'epic et y range les tâches désignées.
export function createEpic(
  ctx: RouteContext,
  projectId: string,
  body: Record<string, unknown> | null,
  sourceSessionId: string | null,
): { ok: true; epic: Epic; taskIds: string[] } | { ok: false; message: string } {
  const title = epicTitle(body?.title);
  if (title === null) return { ok: false, message: EPIC_TITLE_ERROR };
  const description = epicDescription(body?.description);
  if (description === null) return { ok: false, message: EPIC_DESCRIPTION_ERROR };
  const rawIds = body?.taskIds ?? [];
  const own = new Set(ctx.projectTasks(projectId).map((t) => t.id));
  if (!Array.isArray(rawIds) || !rawIds.every((id) => typeof id === 'string' && own.has(id))) {
    return { ok: false, message: 'taskIds doit lister des tâches de ce projet' };
  }
  const taskIds = [...new Set(rawIds as string[])];
  // Rien n'est diffusé avant que l'epic et le rangement des tâches soient validés ensemble.
  const epic = ctx.db.transaction(() => {
    const epic = ctx.db.createEpic(projectId, title, description, sourceSessionId);
    for (const id of taskIds) ctx.db.updateTask(id, { epicId: epic.id });
    return epic;
  });
  ctx.broadcast({ type: 'epic', epic });
  ctx.broadcastTasks(taskIds);
  return { ok: true, epic, taskIds };
}

export function updateEpic(
  ctx: RouteContext,
  id: string,
  body: Record<string, unknown>,
): { ok: true; epic: Epic } | { ok: false; status: number; message: string } {
  if (ctx.db.getEpic(id) === null) return { ok: false, status: 404, message: 'Epic introuvable' };
  const changes: { title?: string; description?: string } = {};
  if (body.title !== undefined) {
    const title = epicTitle(body.title);
    if (title === null) return { ok: false, status: 400, message: EPIC_TITLE_ERROR };
    changes.title = title;
  }
  if (body.description !== undefined) {
    const description = epicDescription(body.description);
    if (description === null) return { ok: false, status: 400, message: EPIC_DESCRIPTION_ERROR };
    changes.description = description;
  }
  const epic = ctx.db.updateEpic(id, changes);
  if (epic === null) return { ok: false, status: 404, message: 'Epic introuvable' };
  ctx.broadcast({ type: 'epic', epic });
  // Les sessions conservent le titre de leur epic d'origine : diffuser le titre renommé.
  for (const session of ctx.db.listSessions()) {
    if (session.epic?.id === id) ctx.broadcast({ type: 'session', session });
  }
  return { ok: true, epic };
}

export function deleteEpic(ctx: RouteContext, id: string): boolean {
  const members = ctx.db
    .listTasks()
    .filter((t) => t.epicId === id)
    .map((t) => t.id);
  if (!ctx.db.deleteEpic(id)) return false;
  ctx.broadcast({ type: 'epic-deleted', id });
  ctx.broadcastTasks(members);
  return true;
}

export function registerEpicRoutes(ctx: RouteContext): void {
  const { app, db, sessions, epicRunner, catalog, epicWorkspaces, broadcast, requireProject, requireEpic } = ctx;

  app.get('/api/epics', async () => db.listEpics());

  // Crée un epic ; `taskIds` y range des tâches existantes du projet.
  app.post<{ Params: { id: string } }>('/api/projects/:id/epics', async (request, reply) => {
    if (requireProject(request, reply) === null) return reply;
    const body = asRecord(request.body);
    const result = createEpic(ctx, request.params.id, body, null);
    if (!result.ok) return error(reply, 400, result.message);
    return reply.code(201).send(result.epic);
  });

  app.patch<{ Params: { id: string } }>('/api/epics/:id', async (request, reply) => {
    const body = asRecord(request.body);
    if (body === null) return error(reply, 400, 'Corps invalide');
    const result = updateEpic(ctx, request.params.id, body);
    if (!result.ok) return error(reply, result.status, result.message);
    return reply.send(result.epic);
  });

  // Supprime l'epic ; ses tâches restent dans le backlog, sans epic.
  app.delete<{ Params: { id: string } }>('/api/epics/:id', async (request, reply) => {
    if (!deleteEpic(ctx, request.params.id)) return error(reply, 404, 'Epic introuvable');
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/epics/:id/runs', async (request) => epicRunner.list(request.params.id));
  app.get<{ Params: { id: string } }>('/api/epics/:id/workspace', async (request, reply) => {
    if (requireEpic(request, reply) === null) return reply;
    return conflict.attempt(reply, () => epicWorkspaces.current(request.params.id));
  });
  app.get<{ Params: { id: string } }>('/api/epics/:id/workspace-options', async (request, reply) => {
    if (requireEpic(request, reply) === null) return reply;
    return conflict.attempt(reply, () => epicWorkspaces.options(request.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/epics/:id/workspace', async (request, reply) => {
    if (requireEpic(request, reply) === null) return reply;
    const path = asRecord(request.body)?.path;
    if (typeof path !== 'string' || !path.trim() || path.length > 4096)
      return error(reply, 400, 'Le chemin du dossier est requis.');
    return conflict.attempt(reply, () =>
      epicWorkspaces.withPreparation(request.params.id, async () =>
        epicRunner.selectWorkspace(request.params.id, path),
      ),
    );
  });
  app.post<{ Params: { id: string } }>('/api/epics/:id/start', async (request, reply) => {
    await catalog.ready();
    const epic = requireEpic(request, reply);
    if (epic === null) return reply;
    const body = asRecord(request.body) ?? {};
    const options = parseSessionDefaults(catalog, db.getProject(epic.projectId)!.sessionDefaults, {
      ...body,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
    });
    if (!options) return error(reply, 400, 'Réglages de session invalides');
    return conflict.attempt(reply, () => epicRunner.start(epic.id, options), 202);
  });
  // Code review du travail d'une epic terminée, arrêtée ou échouée : une session rejoint le worktree des étapes.
  app.post<{ Params: { id: string } }>('/api/epics/:id/review', async (request, reply) => {
    await catalog.ready();
    const epic = requireEpic(request, reply);
    if (epic === null) return reply;
    const run = epicRunner.list(epic.id)[0];
    if (!run) return error(reply, 409, 'Cet epic n’a pas encore été traité : aucun travail à relire.');
    if (isActiveRun(run))
      return error(reply, 409, 'Epic en cours : attendez la fin de l’exécution ou arrêtez-la avant la review.');
    const project = db.getProject(epic.projectId)!;
    const body = asRecord(request.body) ?? {};
    const defaults = parseSessionDefaults(catalog, project.sessionDefaults, {
      ...body,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
    });
    if (!defaults) return error(reply, 400, 'Réglages de session invalides');
    const reviewScope = await conflict.orError(reply, () => {
      const workspace = epicWorkspaces.current(epic.id);
      if (workspace) epicWorkspaces.assert(workspace);
      return epicReviewScope(db, { ...run, workspace, contextRoot: workspace?.path ?? run.contextRoot });
    });
    if (!reviewScope.ok) return reviewScope.reply;
    const scope = reviewScope.value;
    const prompt = `${defaults.prompt}\n\n${epicReviewInstructions(epic.title, scope)}`.trim();
    try {
      const session = await sessions.create(
        project,
        { ...defaults, prompt },
        {
          contextPath: scope.path,
          title: `Review de l’epic « ${epic.title} »`.slice(0, 120),
          rememberDefaults: false,
          epicId: epic.id,
        },
      );
      return reply.code(201).send(session);
    } catch (caught) {
      return error(reply, 500, caught instanceof Error ? caught.message : 'Impossible de lancer la session');
    }
  });
  // Ajoute à l'epic une dernière étape de review, prérequis : toutes ses tâches actuelles.
  app.post<{ Params: { id: string } }>('/api/epics/:id/review-task', async (request, reply) => {
    const epic = requireEpic(request, reply);
    if (epic === null) return reply;
    const members = db.listTasks().filter((t) => t.epicId === epic.id);
    if (members.length === 0) return error(reply, 409, 'Epic vide : ajoutez d’abord ses tâches.');
    if (members.some((t) => t.status !== 'done' && isReviewTask(t)))
      return error(reply, 409, 'Une étape de review est déjà prévue dans cet epic.');
    const created = db.createTask(epic.projectId, reviewTaskText(epic.title), null, epic.id, { type: 'llm' });
    const task = db.updateTask(created.id, { dependsOn: members.map((t) => t.id) }) ?? created;
    broadcast({ type: 'task', task });
    return reply.code(201).send(task);
  });
  app.post<{ Params: { id: string } }>('/api/epic-runs/:id/stop', async (request, reply) => {
    return conflict.attempt(reply, () => epicRunner.stop(request.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/epic-runs/:id/resume', async (request, reply) => {
    return conflict.attempt(reply, () => epicRunner.resume(request.params.id, asRecord(request.body)?.replan === true));
  });
  app.patch<{ Params: { id: string } }>('/api/epic-runs/:id/auto-validation', async (request, reply) => {
    const enabled = asRecord(request.body)?.enabled;
    if (typeof enabled !== 'boolean') return error(reply, 400, 'enabled doit être un booléen.');
    return conflict.attempt(reply, () => epicRunner.setAutoValidate(request.params.id, enabled));
  });
}
