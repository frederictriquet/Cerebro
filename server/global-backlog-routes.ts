import { asRecord } from './util.ts';
import { error } from './routes-util.ts';
import type { RouteContext } from './route-context.ts';
import {
  checkGlobalEpic,
  EPIC_DESCRIPTION_ERROR,
  EPIC_TITLE_ERROR,
  epicDescription,
  epicTitle,
} from './epic-routes.ts';
import { MAX_TASK_LENGTH, taskText } from './task-routes.ts';

// Backlog global : idées sans projet. Une tâche ou un epic y reste tel quel jusqu'à son dispatch, qui le
// déplace d'un bloc dans le backlog du projet choisi. Aucune dépendance, aucune exécution : ces notions
// n'existent qu'une fois la tâche dans un projet.
export function registerGlobalBacklogRoutes(ctx: RouteContext): void {
  const { app, db, broadcast } = ctx;
  const textError = `Le texte doit contenir entre 1 et ${MAX_TASK_LENGTH} caractères`;

  app.get('/api/global-backlog', async () => db.listGlobalBacklog());

  app.post('/api/global-backlog/tasks', async (request, reply) => {
    const body = asRecord(request.body);
    const text = taskText(body?.text);
    if (text === null) return error(reply, 400, textError);
    const epic = checkGlobalEpic(db, body?.epicId ?? null);
    if (!epic.ok) return error(reply, 400, epic.message);
    return reply.code(201).send(db.createGlobalTask(text, epic.id));
  });

  app.patch<{ Params: { id: string } }>('/api/global-backlog/tasks/:id', async (request, reply) => {
    if (db.getGlobalTask(request.params.id) === null) return error(reply, 404, 'Tâche introuvable');
    const body = asRecord(request.body);
    if (body === null) return error(reply, 400, 'Corps invalide');
    const changes: { text?: string; epicId?: string | null } = {};
    if (body.text !== undefined) {
      const text = taskText(body.text);
      if (text === null) return error(reply, 400, textError);
      changes.text = text;
    }
    if (body.epicId !== undefined) {
      const epic = checkGlobalEpic(db, body.epicId);
      if (!epic.ok) return error(reply, 400, epic.message);
      changes.epicId = epic.id;
    }
    const task = db.updateGlobalTask(request.params.id, changes);
    return task === null ? error(reply, 404, 'Tâche introuvable') : reply.send(task);
  });

  app.delete<{ Params: { id: string } }>('/api/global-backlog/tasks/:id', async (request, reply) =>
    db.deleteGlobalTask(request.params.id) ? reply.code(204).send() : error(reply, 404, 'Tâche introuvable'),
  );

  app.post('/api/global-backlog/epics', async (request, reply) => {
    const body = asRecord(request.body);
    const title = epicTitle(body?.title);
    if (title === null) return error(reply, 400, EPIC_TITLE_ERROR);
    const description = epicDescription(body?.description);
    if (description === null) return error(reply, 400, EPIC_DESCRIPTION_ERROR);
    return reply.code(201).send(db.createGlobalEpic(title, description));
  });

  app.patch<{ Params: { id: string } }>('/api/global-backlog/epics/:id', async (request, reply) => {
    if (db.getGlobalEpic(request.params.id) === null) return error(reply, 404, 'Epic introuvable');
    const body = asRecord(request.body);
    if (body === null) return error(reply, 400, 'Corps invalide');
    const changes: { title?: string; description?: string } = {};
    if (body.title !== undefined) {
      const title = epicTitle(body.title);
      if (title === null) return error(reply, 400, EPIC_TITLE_ERROR);
      changes.title = title;
    }
    if (body.description !== undefined) {
      const description = epicDescription(body.description);
      if (description === null) return error(reply, 400, EPIC_DESCRIPTION_ERROR);
      changes.description = description;
    }
    const epic = db.updateGlobalEpic(request.params.id, changes);
    return epic === null ? error(reply, 404, 'Epic introuvable') : reply.send(epic);
  });

  // Supprime l'epic ; ses tâches restent dans le backlog global, sans epic.
  app.delete<{ Params: { id: string } }>('/api/global-backlog/epics/:id', async (request, reply) =>
    db.deleteGlobalEpic(request.params.id) ? reply.code(204).send() : error(reply, 404, 'Epic introuvable'),
  );

  // Déplace la tâche dans le backlog du projet `projectId` ({ projectId }) ; renvoie la tâche créée.
  app.post<{ Params: { id: string } }>('/api/global-backlog/tasks/:id/dispatch', async (request, reply) => {
    if (db.getGlobalTask(request.params.id) === null) return error(reply, 404, 'Tâche introuvable');
    const project = dispatchTarget(request.body);
    if (project === null) return error(reply, 400, 'projectId attendu');
    if (db.getProject(project) === null) return error(reply, 404, 'Projet introuvable');
    const task = db.dispatchGlobalTask(request.params.id, project);
    broadcast({ type: 'task', task });
    return reply.code(201).send(task);
  });

  // Déplace l'epic et ses tâches dans le backlog du projet `projectId` ; renvoie l'epic et les tâches créés.
  app.post<{ Params: { id: string } }>('/api/global-backlog/epics/:id/dispatch', async (request, reply) => {
    if (db.getGlobalEpic(request.params.id) === null) return error(reply, 404, 'Epic introuvable');
    const project = dispatchTarget(request.body);
    if (project === null) return error(reply, 400, 'projectId attendu');
    if (db.getProject(project) === null) return error(reply, 404, 'Projet introuvable');
    const { epic, tasks } = db.dispatchGlobalEpic(request.params.id, project);
    broadcast({ type: 'epic', epic });
    for (const task of tasks) broadcast({ type: 'task', task });
    return reply.code(201).send({ epic, tasks });
  });
}

function dispatchTarget(body: unknown): string | null {
  const projectId = asRecord(body)?.projectId;
  return typeof projectId === 'string' && projectId !== '' ? projectId : null;
}
