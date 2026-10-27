import type { FastifyReply } from 'fastify';
import type { Epic, Session, Task } from '../shared/types.ts';
import { asRecord } from './util.ts';
import { error } from './routes-util.ts';
import { badRequest, conflict, type RouteContext } from './route-context.ts';
import { checkDependencies, checkEpic, MAX_TASK_LENGTH, taskText } from './task-routes.ts';
import { createEpic, deleteEpic, EPIC_DESCRIPTION_ERROR, EPIC_TITLE_ERROR, epicDescription, epicTitle, updateEpic } from './epic-routes.ts';

const MAX_BACKLOG_TASKS = 100;
// Worst case: 3 UTF-8 bytes per UTF-16 code unit (non-ASCII text), plus JSON escaping and envelope.
const BACKLOG_BODY_LIMIT = MAX_BACKLOG_TASKS * MAX_TASK_LENGTH * 3 + 1024 * 1024;

// Routes de bin/cerebro-backlog, authentifiées par le jeton de session : elles n'agissent que sur le
// backlog du projet de la session.
export function registerBacklogRoutes(ctx: RouteContext): void {
  const { app, db, epicRunner, broadcast, broadcastTasks, tokenSession, projectTasks, publishFindings } = ctx;

  app.post<{ Params: { id: string } }>('/api/backlog/:id/findings', {bodyLimit: 1024 * 1024}, async (request, reply) => {
    const session = tokenSession(request, reply);
    if (!session) return reply;
    return badRequest.attempt(reply, () => publishFindings(session.id, request.body));
  });
  app.post<{ Params: { id: string; taskId:string } }>('/api/backlog/:id/tasks/:taskId/result', async (request,reply)=>{
    const session=tokenSession(request,reply);if(!session)return reply;
    const body=asRecord(request.body);
    if(!['failed','blocked','waiting-validation'].includes(String(body?.status))||typeof body?.message!=='string'||body.message.length>2000)return error(reply,400,'Résultat invalide.');
    const status=body.status as 'failed'|'blocked'|'waiting-validation',message=body.message;
    return conflict.attempt(reply,()=>epicRunner.report(session.id,request.params.taskId,status,message));
  });
  app.get<{ Params: { id: string } }>('/api/backlog/:id', async (request, reply) => {
    const session = tokenSession(request, reply);
    if (session === null) return reply;
    return projectTasks(session.projectId).map(({ id, status, text, dependsOn, epicId, sourceSessionId, sessionId }) =>
      ({ id, status, text, dependsOn, epicId, mine: sourceSessionId === session.id, assigned: sessionId === session.id }));
  });

  const projectEpic = (session: Session, epicId: string, reply: FastifyReply): Epic | null => {
    const epic = db.getEpic(epicId);
    if (epic === null || epic.projectId !== session.projectId) {
      error(reply, 404, 'Epic introuvable dans ce projet');
      return null;
    }
    return epic;
  };

  app.get<{ Params: { id: string } }>('/api/backlog/:id/epics', async (request, reply) => {
    const session = tokenSession(request, reply);
    if (session === null) return reply;
    const tasks = projectTasks(session.projectId);
    return db.listEpics().filter((e) => e.projectId === session.projectId).map(({ id, title, description, sourceSessionId }) =>
      ({ id, title, description, mine: sourceSessionId === session.id, tasks: tasks.filter((t) => t.epicId === id).map((t) => t.id) }));
  });

  // Crée un epic, vide ou avec des tâches existantes ({ title, description?, taskIds? }).
  app.post<{ Params: { id: string } }>('/api/backlog/:id/epics', async (request, reply) => {
    const session = tokenSession(request, reply);
    if (session === null) return reply;
    const result = createEpic(ctx, session.projectId, asRecord(request.body), session.id);
    if (!result.ok) return error(reply, 400, result.message);
    const { id, title, description } = result.epic;
    return reply.code(201).send({ id, title, description, tasks: result.taskIds });
  });

  app.patch<{ Params: { id: string; epicId: string } }>('/api/backlog/:id/epics/:epicId', async (request, reply) => {
    const session = tokenSession(request, reply);
    if (session === null) return reply;
    if (projectEpic(session, request.params.epicId, reply) === null) return reply;
    const body = asRecord(request.body);
    if (body === null) return error(reply, 400, 'Corps invalide');
    const result = updateEpic(ctx, request.params.epicId, body);
    if (!result.ok) return error(reply, result.status, result.message);
    const { id, title, description } = result.epic;
    return reply.send({ id, title, description });
  });

  // Supprime un epic créé par cette session ; ses tâches restent dans le backlog.
  app.delete<{ Params: { id: string; epicId: string } }>('/api/backlog/:id/epics/:epicId', async (request, reply) => {
    const session = tokenSession(request, reply);
    if (session === null) return reply;
    const epic = projectEpic(session, request.params.epicId, reply);
    if (epic === null) return reply;
    if (epic.sourceSessionId !== session.id) return error(reply, 403, 'Seuls les epics créés par cette session peuvent être supprimés ici');
    deleteEpic(ctx, epic.id);
    return reply.code(204).send();
  });

  // Clôt une tâche confiée à cette session (traitement d'un epic, tâche par tâche).
  app.post<{ Params: { id: string; taskId: string } }>('/api/backlog/:id/tasks/:taskId/done', async (request, reply) => {
    const session = tokenSession(request, reply);
    if (session === null) return reply;
    const current = db.getTask(request.params.taskId);
    if (current === null || current.projectId !== session.projectId) return error(reply, 404, 'Tâche introuvable dans ce projet');
    if (current.sessionId !== session.id) return error(reply, 403, "Cette tâche n'est pas confiée à cette session");
    const task = db.updateTask(current.id, { status: 'done' });
    if (task === null) return error(reply, 404, 'Tâche introuvable');
    broadcast({ type: 'task', task });
    return reply.send({ id: task.id, status: task.status });
  });

  // Ajoute des tâches. Chacune est un texte ou { text, dependsOn } ; une dépendance est l'identifiant
  // d'une tâche du projet ou le numéro (à partir de 1) d'une tâche précédente du même envoi.
  app.post<{ Params: { id: string } }>('/api/backlog/:id', { bodyLimit: BACKLOG_BODY_LIMIT }, async (request, reply) => {
    const session = tokenSession(request, reply);
    if (session === null) return reply;
    const body = asRecord(request.body);
    if (body === null || !Array.isArray(body.tasks) || body.tasks.length === 0 || body.tasks.length > MAX_BACKLOG_TASKS) {
      return error(reply, 400, `tasks doit contenir entre 1 et ${MAX_BACKLOG_TASKS} tâches`);
    }
    const existing = new Set(projectTasks(session.projectId).map((t) => t.id));
    const epics = db.listEpics();
    // `epic` : epic de toutes les tâches de l'envoi, existant (identifiant) ou à créer ({ title, description? }).
    let defaultEpic: string | null = null;
    let newEpic: Record<string, unknown> | null = null;
    if (typeof body.epic === 'string') {
      const checked = checkEpic(body.epic, session.projectId, epics);
      if (!checked.ok) return error(reply, 400, checked.message);
      defaultEpic = checked.id;
    } else if (body.epic !== undefined && body.epic !== null) {
      newEpic = asRecord(body.epic);
      if (epicTitle(newEpic?.title) === null) return error(reply, 400, EPIC_TITLE_ERROR);
      if (epicDescription(newEpic?.description) === null) return error(reply, 400, EPIC_DESCRIPTION_ERROR);
    }
    const items: { text: string; deps: (string | number)[]; epicId: string | null | undefined }[] = [];
    for (const [index, raw] of (body.tasks as unknown[]).entries()) {
      const item = typeof raw === 'string' ? { text: raw } : asRecord(raw);
      const text = taskText(item?.text);
      if (text === null) return error(reply, 400, `Tâche ${index + 1} : le texte doit contenir entre 1 et ${MAX_TASK_LENGTH} caractères`);
      const deps = item?.dependsOn ?? [];
      if (!Array.isArray(deps)) return error(reply, 400, `Tâche ${index + 1} : dependsOn doit être une liste`);
      for (const dep of deps) {
        const valid = typeof dep === 'number'
          ? Number.isInteger(dep) && dep >= 1 && dep <= index
          : typeof dep === 'string' && existing.has(dep);
        if (!valid) {
          return error(reply, 400, `Tâche ${index + 1} : dépendance invalide ${JSON.stringify(dep)} (identifiant d'une tâche du projet ou numéro d'une tâche précédente de l'envoi)`);
        }
      }
      let epicId: string | null | undefined;
      if (item?.epicId !== undefined) {
        const checked = checkEpic(item.epicId, session.projectId, epics);
        if (!checked.ok) return error(reply, 400, `Tâche ${index + 1} : ${checked.message}`);
        epicId = checked.id;
      }
      items.push({ text, deps: deps as (string | number)[], epicId });
    }
    let createdEpic: Epic | null = null;
    if (newEpic !== null) {
      const result = createEpic(ctx, session.projectId, { title: newEpic.title, description: newEpic.description }, session.id);
      if (!result.ok) return error(reply, 400, result.message);
      createdEpic = result.epic;
      defaultEpic = result.epic.id;
    }
    // Les nouvelles tâches ne dépendent que de tâches existantes ou antérieures : pas de cycle possible.
    const created: Task[] = [];
    for (const { text, deps, epicId } of items) {
      const task = db.createTask(session.projectId, text, session.id, epicId === undefined ? defaultEpic : epicId);
      const dependsOn = deps.map((dep) => typeof dep === 'number' ? (created[dep - 1] as Task).id : dep);
      created.push(dependsOn.length === 0 ? task : db.updateTask(task.id, { dependsOn }) ?? task);
    }
    for (const task of created) broadcast({ type: 'task', task });
    return reply.code(201).send({
      count: created.length,
      epic: createdEpic === null ? null : { id: createdEpic.id, title: createdEpic.title },
      tasks: created.map(({ id, text, dependsOn, epicId }) => ({ id, text, dependsOn, epicId })),
    });
  });

  // Remplace les dépendances d'une tâche du projet.
  app.patch<{ Params: { id: string; taskId: string } }>('/api/backlog/:id/tasks/:taskId', async (request, reply) => {
    const session = tokenSession(request, reply);
    if (session === null) return reply;
    const current = db.getTask(request.params.taskId);
    if (current === null || current.projectId !== session.projectId) return error(reply, 404, 'Tâche introuvable dans ce projet');
    const body = asRecord(request.body);
    if (body === null || (body.dependsOn === undefined && body.epicId === undefined)) {
      return error(reply, 400, 'dependsOn ou epicId attendu');
    }
    const changes: { dependsOn?: string[]; epicId?: string | null } = {};
    if (body.dependsOn !== undefined) {
      const checked = checkDependencies(current, body.dependsOn, projectTasks(session.projectId));
      if (!checked.ok) return error(reply, 400, checked.message);
      changes.dependsOn = checked.ids;
    }
    if (body.epicId !== undefined) {
      const checked = checkEpic(body.epicId, session.projectId, db.listEpics());
      if (!checked.ok) return error(reply, 400, checked.message);
      changes.epicId = checked.id;
    }
    const task = db.updateTask(current.id, changes);
    if (task === null) return error(reply, 404, 'Tâche introuvable');
    broadcast({ type: 'task', task });
    return reply.send({ id: task.id, text: task.text, dependsOn: task.dependsOn, epicId: task.epicId });
  });

  // Supprime une tâche, uniquement si elle a été créée par cette session et n'a pas été démarrée.
  app.delete<{ Params: { id: string; taskId: string } }>('/api/backlog/:id/tasks/:taskId', async (request, reply) => {
    const session = tokenSession(request, reply);
    if (session === null) return reply;
    const task = db.getTask(request.params.taskId);
    if (task === null || task.projectId !== session.projectId) return error(reply, 404, 'Tâche introuvable dans ce projet');
    if (task.sourceSessionId !== session.id) return error(reply, 403, "Seules les tâches créées par cette session peuvent être supprimées ici");
    if (task.status !== 'todo') return error(reply, 409, 'Tâche déjà démarrée : à supprimer depuis l\'interface');
    const dependents = db.listDependents(task.id);
    db.deleteTask(task.id);
    broadcast({ type: 'task-deleted', id: task.id });
    broadcastTasks(dependents);
    return reply.code(204).send();
  });
}
