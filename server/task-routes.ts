import { assertEpicWorkspace, epicWorkspace, rememberEpicWorkspace, withEpicWorkspace } from './epic-workspace.ts';
import { isActiveRun } from '../shared/backlog.ts';
import type { Epic, Task, TaskExecution, TaskStatus } from '../shared/types.ts';
import { asRecord } from './util.ts';
import { error } from './routes-util.ts';
import { badRequest, conflict, type RouteContext } from './route-context.ts';

export const MAX_TASK_LENGTH = 20_000;
const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'started', 'done'];

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export function taskText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' || text.length > MAX_TASK_LENGTH ? null : text;
}

// Valide l'epic proposé pour une tâche du projet : null (aucun) ou un epic du même projet.
export function checkEpic(value: unknown, projectId: string, epics: Epic[]): { ok: true; id: string | null } | { ok: false; message: string } {
  if (value === null) return { ok: true, id: null };
  if (typeof value !== 'string' || !epics.some((e) => e.id === value && e.projectId === projectId)) {
    return { ok: false, message: 'Epic introuvable dans ce projet' };
  }
  return { ok: true, id: value };
}

// Valide la liste de dépendances proposée pour `task` : tâches existantes du même projet, sans cycle.
export function checkDependencies(task: Task, value: unknown, projectTasks: Task[]): { ok: true; ids: string[] } | { ok: false; message: string } {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) {
    return { ok: false, message: 'dependsOn doit être une liste d\'identifiants' };
  }
  const ids = [...new Set(value as string[])];
  const byId = new Map(projectTasks.map((t) => [t.id, t]));
  if (ids.some((id) => !byId.has(id))) return { ok: false, message: 'Dépendance introuvable dans ce projet' };
  if (ids.includes(task.id)) return { ok: false, message: 'Une tâche ne peut pas dépendre d\'elle-même' };
  // Cycle si `task` est atteignable depuis l'une des nouvelles dépendances.
  const seen = new Set<string>();
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === task.id) return { ok: false, message: 'Cette dépendance créerait un cycle' };
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return { ok: true, ids };
}

export function registerTaskRoutes(ctx: RouteContext): void {
  const { app, db, commands, epicRunner, broadcast, broadcastTasks, found, requireProject, launchSession } = ctx;

  app.get<{ Params: { id: string } }>('/api/projects/:id/commands', async request => commands.commands(request.params.id));
  app.post<{ Params: { id: string } }>('/api/projects/:id/commands', async (request, reply) => {
    return badRequest.attempt(reply, () => commands.configure(request.params.id, request.body), 201);
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id/runs', async request => commands.listRuns(request.params.id));
  app.post<{ Params: { id: string } }>('/api/command-runs/:id/stop', async (request, reply) => commands.stop(request.params.id) ? reply.send({ok:true}) : error(reply, 409, 'Commande non active'));

  app.get('/api/tasks', async () => db.listTasks());

  app.delete<{ Params: { id: string } }>('/api/projects/:id/backlog/completed', async (request, reply) => {
    if (requireProject(request, reply) === null) return reply;
    const projectId = request.params.id;
    if (db.listTasks().some((task) => task.projectId === projectId && task.status === 'done' && commands.active(task.id))) {
      return error(reply, 409, 'Arrêtez les commandes avant de supprimer leurs tâches.');
    }
    const { taskIds, epicIds, dependentIds } = db.deleteCompletedBacklog(projectId);
    for (const id of taskIds) broadcast({ type: 'task-deleted', id });
    for (const id of epicIds) broadcast({ type: 'epic-deleted', id });
    broadcastTasks(dependentIds);
    return { taskIds, epicIds };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/tasks', async (request, reply) => {
    if (requireProject(request, reply) === null) return reply;
    const body = asRecord(request.body);
    const text = taskText(body?.text);
    if (text === null) return error(reply, 400, `Le texte doit contenir entre 1 et ${MAX_TASK_LENGTH} caractères`);
    const source = typeof body?.sourceSessionId === 'string' && db.getSession(body.sourceSessionId) !== null
      ? body.sourceSessionId
      : null;
    const epic = checkEpic(body?.epicId ?? null, request.params.id, db.listEpics());
    if (!epic.ok) return error(reply, 400, epic.message);
    const execution = await badRequest.orError(reply, () => commands.execution(request.params.id, body?.execution));
    if (!execution.ok) return execution.reply;
    const task = db.createTask(request.params.id, text, source, epic.id, execution.value);
    broadcast({ type: 'task', task });
    return reply.code(201).send(task);
  });

  app.patch<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    if (db.getTask(request.params.id) === null) return error(reply, 404, 'Tâche introuvable');
    if (commands.active(request.params.id)) return error(reply, 409, 'Arrêtez la commande avant de modifier cette tâche.');
    const body = asRecord(request.body);
    if (body === null) return error(reply, 400, 'Corps invalide');
    const changes: { text?: string; status?: TaskStatus; execution?:TaskExecution; dependsOn?: string[]; epicId?: string | null } = {};
    if (body.execution !== undefined) {
      const execution = await badRequest.orError(reply, () => commands.execution(db.getTask(request.params.id)!.projectId, body.execution));
      if (!execution.ok) return execution.reply;
      changes.execution = execution.value;
    }
    if (body.text !== undefined) {
      const text = taskText(body.text);
      if (text === null) return error(reply, 400, `Le texte doit contenir entre 1 et ${MAX_TASK_LENGTH} caractères`);
      changes.text = text;
    }
    if (body.status !== undefined) {
      if (!isTaskStatus(body.status)) return error(reply, 400, 'Statut invalide');
      changes.status = body.status;
    }
    if (body.dependsOn !== undefined) {
      const current = db.getTask(request.params.id) as Task;
      const checked = checkDependencies(current, body.dependsOn, db.listTasks().filter((t) => t.projectId === current.projectId));
      if (!checked.ok) return error(reply, 400, checked.message);
      changes.dependsOn = checked.ids;
    }
    if (body.epicId !== undefined) {
      const epic = checkEpic(body.epicId, (db.getTask(request.params.id) as Task).projectId, db.listEpics());
      if (!epic.ok) return error(reply, 400, epic.message);
      changes.epicId = epic.id;
    }
    const task = db.updateTask(request.params.id, changes);
    if (task === null) return error(reply, 404, 'Tâche introuvable');
    broadcast({ type: 'task', task });
    return reply.send(task);
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    if (commands.active(request.params.id)) return error(reply, 409, 'Arrêtez la commande avant de supprimer cette tâche.');
    const dependents = db.listDependents(request.params.id);
    if (!db.deleteTask(request.params.id)) return error(reply, 404, 'Tâche introuvable');
    broadcast({ type: 'task-deleted', id: request.params.id });
    broadcastTasks(dependents);
    return reply.code(204).send();
  });

  // Confie la tâche à une nouvelle session ; le prompt peut différer du texte (édité avant lancement).
  app.post<{ Params: { id: string } }>('/api/tasks/:id/start', async (request, reply) => {
    const task = db.getTask(request.params.id);
    if (task === null) return error(reply, 404, 'Tâche introuvable');
    if (epicRunner.reserved(task.id)) return error(reply, 409, 'Tâche réservée par un ordonnanceur d’epic.');
    if (task.epicId && epicRunner.list(task.epicId).some(isActiveRun)) return error(reply,409,'Cet epic est en cours : utilisez reprendre et recalculer pour ajouter ses tâches.');
    const project = found(db.getProject(task.projectId), reply, 'Projet introuvable');
    if (project === null) return reply;
    if (task.dependsOn.some((id) => db.getTask(id)?.status !== 'done')) {
      return error(reply, 409, 'Tâche bloquée : ses dépendances ne sont pas toutes terminées');
    }
    if (task.execution.type === 'command') {
      return conflict.attempt(reply, async () => {
        const start = async () => {
          const context = task.epicId ? epicWorkspace(db,task.epicId)??{path:project.path,mode:'shared' as const} : null;
          if (context) assertEpicWorkspace(db,context);
          const run = await commands.start(task.id,context?.path);
          if (task.epicId && context) rememberEpicWorkspace(db,task.epicId,context);
          return run;
        };
        const run = await (task.epicId ? withEpicWorkspace(db,task.epicId,start) : start());
        return {task:db.getTask(task.id),run};
      }, 202);
    }
    const checked = await conflict.orError(reply, () => { const context=task.epicId?epicWorkspace(db,task.epicId):null;if(context)assertEpicWorkspace(db,context); });
    if (!checked.ok) return checked.reply;
    return launchSession(reply, project, request.body, (session) => {
      const updated = db.updateTask(task.id, { status: 'started', sessionId: session.id });
      if (updated !== null) broadcast({ type: 'task', task: updated });
      return { task: updated, session };
    }, undefined, task.epicId);
  });
}
