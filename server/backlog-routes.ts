import type { FastifyReply } from 'fastify';
import type { Epic, Project, Session, Task } from '../shared/types.ts';
import { asRecord } from './util.ts';
import { error, type Outcome } from './routes-util.ts';
import { badRequest, conflict, type RouteContext } from './route-context.ts';
import { checkDependencies, checkEpic, MAX_TASK_LENGTH, taskText } from './task-routes.ts';
import {
  createEpic,
  deleteEpic,
  EPIC_DESCRIPTION_ERROR,
  EPIC_TITLE_ERROR,
  epicDescription,
  epicTitle,
  updateEpic,
} from './epic-routes.ts';

const MAX_BACKLOG_TASKS = 100;
// Worst case: 3 UTF-8 bytes per UTF-16 code unit (non-ASCII text), plus JSON escaping and envelope.
const BACKLOG_BODY_LIMIT = MAX_BACKLOG_TASKS * MAX_TASK_LENGTH * 3 + 1024 * 1024;

type BacklogRequest = { params: { id: string }; query: unknown };

// Routes de bin/cerebro-backlog, authentifiées par le jeton de session : elles agissent sur le backlog du
// projet de la session. Le paramètre `project` (nom ou identifiant) vise le backlog d'un autre projet,
// pour la consultation et l'ajout seulement ; une session ne supprime ailleurs que ce qu'elle y a créé.
export function registerBacklogRoutes(ctx: RouteContext): void {
  const { app, db, epicRunner, broadcast, broadcastTasks, tokenSession, projectTasks, publishFindings } = ctx;

  // Projet visé : celui de la session sauf `?project=` (identifiant, ou nom sans tenir compte de la casse).
  const targetProject = (session: Session, request: BacklogRequest, reply: FastifyReply): Outcome<string> => {
    const wanted = asRecord(request.query)?.project;
    if (wanted === undefined || wanted === '') return { ok: true, value: session.projectId };
    if (typeof wanted !== 'string') return { ok: false, reply: error(reply, 400, 'project doit être un texte') };
    const projects = db.listProjects();
    const byId = projects.find((p) => p.id === wanted);
    if (byId !== undefined) return { ok: true, value: byId.id };
    const named = projects.filter((p) => p.name.toLowerCase() === wanted.trim().toLowerCase());
    if (named.length === 1) return { ok: true, value: (named[0] as Project).id };
    const names = (named.length > 1 ? named : projects).map((p) => `${p.name} (${p.id})`).join(', ');
    return named.length > 1
      ? { ok: false, reply: error(reply, 400, `Plusieurs projets s'appellent ainsi, précisez l'identifiant : ${names}`) }
      : { ok: false, reply: error(reply, 404, `Projet introuvable : ${wanted}. Projets : ${names}`) };
  };

  app.get<{ Params: { id: string } }>('/api/backlog/:id/projects', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const session = checked.value;
    return db
      .listProjects()
      .map(({ id, name }) => ({ id, name, current: id === session.projectId }));
  });

  app.post<{ Params: { id: string } }>(
    '/api/backlog/:id/findings',
    { bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      const checked = tokenSession(request, reply);
      if (!checked.ok) return checked.reply;
      const session = checked.value;
      return badRequest.attempt(reply, () => publishFindings(session.id, request.body));
    },
  );
  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/backlog/:id/tasks/:taskId/result',
    async (request, reply) => {
      const checked = tokenSession(request, reply);
      if (!checked.ok) return checked.reply;
      const session = checked.value;
      const body = asRecord(request.body);
      if (
        !['failed', 'blocked', 'waiting-validation'].includes(String(body?.status)) ||
        typeof body?.message !== 'string' ||
        body.message.length > 2000
      )
        return error(reply, 400, 'Résultat invalide.');
      const status = body.status as 'failed' | 'blocked' | 'waiting-validation',
        message = body.message;
      return conflict.attempt(reply, () => epicRunner.report(session.id, request.params.taskId, status, message));
    },
  );
  app.get<{ Params: { id: string } }>('/api/backlog/:id', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const session = checked.value;
    const target = targetProject(session, request, reply);
    if (!target.ok) return target.reply;
    return projectTasks(target.value).map(
      ({ id, status, text, dependsOn, epicId, sourceSessionId, sessionId }) => ({
        id,
        status,
        text,
        dependsOn,
        epicId,
        mine: sourceSessionId === session.id,
        assigned: sessionId === session.id,
      }),
    );
  });

  const projectEpic = (session: Session, epicId: string, reply: FastifyReply): Outcome<Epic> => {
    const epic = db.getEpic(epicId);
    if (epic === null || epic.projectId !== session.projectId)
      return { ok: false, reply: error(reply, 404, 'Epic introuvable dans ce projet') };
    return { ok: true, value: epic };
  };

  app.get<{ Params: { id: string } }>('/api/backlog/:id/epics', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const session = checked.value;
    const target = targetProject(session, request, reply);
    if (!target.ok) return target.reply;
    const tasks = projectTasks(target.value);
    return db
      .listEpics()
      .filter((e) => e.projectId === target.value)
      .map(({ id, title, description, sourceSessionId }) => ({
        id,
        title,
        description,
        mine: sourceSessionId === session.id,
        tasks: tasks.filter((t) => t.epicId === id).map((t) => t.id),
      }));
  });

  // Crée un epic, vide ou avec des tâches existantes ({ title, description?, taskIds? }).
  app.post<{ Params: { id: string } }>('/api/backlog/:id/epics', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const session = checked.value;
    const target = targetProject(session, request, reply);
    if (!target.ok) return target.reply;
    const body = asRecord(request.body);
    // Dans un autre projet, la session ajoute sans réorganiser : pas de tâches existantes rangées dans l'epic.
    if (target.value !== session.projectId && Array.isArray(body?.taskIds) && body.taskIds.length > 0)
      return error(reply, 400, "Dans un autre projet, un epic se crée vide ou avec ses nouvelles tâches (--new-epic)");
    const result = createEpic(ctx, target.value, body, session.id);
    if (!result.ok) return error(reply, 400, result.message);
    const { id, title, description } = result.epic;
    return reply.code(201).send({ id, title, description, tasks: result.taskIds });
  });

  app.patch<{ Params: { id: string; epicId: string } }>('/api/backlog/:id/epics/:epicId', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const session = checked.value;
    const found = projectEpic(session, request.params.epicId, reply);
    if (!found.ok) return found.reply;
    const body = asRecord(request.body);
    if (body === null) return error(reply, 400, 'Corps invalide');
    const result = updateEpic(ctx, request.params.epicId, body);
    if (!result.ok) return error(reply, result.status, result.message);
    const { id, title, description } = result.epic;
    return reply.send({ id, title, description });
  });

  // Supprime un epic créé par cette session ; ses tâches restent dans le backlog.
  app.delete<{ Params: { id: string; epicId: string } }>('/api/backlog/:id/epics/:epicId', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const session = checked.value;
    const own = db.getEpic(request.params.epicId);
    const found =
      own !== null && own.sourceSessionId === session.id
        ? { ok: true as const, value: own }
        : projectEpic(session, request.params.epicId, reply);
    if (!found.ok) return found.reply;
    const epic = found.value;
    if (epic.sourceSessionId !== session.id)
      return error(reply, 403, 'Seuls les epics créés par cette session peuvent être supprimés ici');
    deleteEpic(ctx, epic.id);
    return reply.code(204).send();
  });

  // Clôt une tâche confiée à cette session (traitement d'un epic, tâche par tâche).
  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/backlog/:id/tasks/:taskId/done',
    async (request, reply) => {
      const checked = tokenSession(request, reply);
      if (!checked.ok) return checked.reply;
      const session = checked.value;
      const current = db.getTask(request.params.taskId);
      if (current === null || current.projectId !== session.projectId)
        return error(reply, 404, 'Tâche introuvable dans ce projet');
      if (current.sessionId !== session.id) return error(reply, 403, "Cette tâche n'est pas confiée à cette session");
      const task = db.updateTask(current.id, { status: 'done' });
      if (task === null) return error(reply, 404, 'Tâche introuvable');
      broadcast({ type: 'task', task });
      return reply.send({ id: task.id, status: task.status });
    },
  );

  // Ajoute des tâches. Chacune est un texte ou { text, dependsOn } ; une dépendance est l'identifiant
  // d'une tâche du projet ou le numéro (à partir de 1) d'une tâche précédente du même envoi.
  app.post<{ Params: { id: string } }>(
    '/api/backlog/:id',
    { bodyLimit: BACKLOG_BODY_LIMIT },
    async (request, reply) => {
      const checked = tokenSession(request, reply);
      if (!checked.ok) return checked.reply;
      const session = checked.value;
      const target = targetProject(session, request, reply);
      if (!target.ok) return target.reply;
      const projectId = target.value;
      const body = asRecord(request.body);
      if (
        body === null ||
        !Array.isArray(body.tasks) ||
        body.tasks.length === 0 ||
        body.tasks.length > MAX_BACKLOG_TASKS
      ) {
        return error(reply, 400, `tasks doit contenir entre 1 et ${MAX_BACKLOG_TASKS} tâches`);
      }
      const existing = new Set(projectTasks(projectId).map((t) => t.id));
      const epics = db.listEpics();
      // `epic` : epic de toutes les tâches de l'envoi, existant (identifiant) ou à créer ({ title, description? }).
      let defaultEpic: string | null = null;
      let newEpic: { title: string; description: string } | null = null;
      if (typeof body.epic === 'string') {
        const checked = checkEpic(body.epic, projectId, epics);
        if (!checked.ok) return error(reply, 400, checked.message);
        defaultEpic = checked.id;
      } else if (body.epic !== undefined && body.epic !== null) {
        const raw = asRecord(body.epic);
        const title = epicTitle(raw?.title);
        if (title === null) return error(reply, 400, EPIC_TITLE_ERROR);
        const description = epicDescription(raw?.description);
        if (description === null) return error(reply, 400, EPIC_DESCRIPTION_ERROR);
        newEpic = { title, description };
      }
      const items: { text: string; deps: (string | number)[]; epicId: string | null | undefined }[] = [];
      for (const [index, raw] of (body.tasks as unknown[]).entries()) {
        const item = typeof raw === 'string' ? { text: raw } : asRecord(raw);
        const text = taskText(item?.text);
        if (text === null)
          return error(
            reply,
            400,
            `Tâche ${index + 1} : le texte doit contenir entre 1 et ${MAX_TASK_LENGTH} caractères`,
          );
        const deps = item?.dependsOn ?? [];
        if (!Array.isArray(deps)) return error(reply, 400, `Tâche ${index + 1} : dependsOn doit être une liste`);
        for (const dep of deps) {
          const valid =
            typeof dep === 'number'
              ? Number.isInteger(dep) && dep >= 1 && dep <= index
              : typeof dep === 'string' && existing.has(dep);
          if (!valid) {
            return error(
              reply,
              400,
              `Tâche ${index + 1} : dépendance invalide ${JSON.stringify(dep)} (identifiant d'une tâche du projet ou numéro d'une tâche précédente de l'envoi)`,
            );
          }
        }
        let epicId: string | null | undefined;
        if (item?.epicId !== undefined) {
          const checked = checkEpic(item.epicId, projectId, epics);
          if (!checked.ok) return error(reply, 400, `Tâche ${index + 1} : ${checked.message}`);
          epicId = checked.id;
        }
        items.push({ text, deps: deps as (string | number)[], epicId });
      }
      // L'envoi est enregistré d'un bloc et diffusé une fois validé : un échec en cours de route ne laisse rien.
      let createdEpic: Epic | null;
      let created: Task[];
      try {
        ({ createdEpic, created } = db.transaction(() => {
          const createdEpic =
            newEpic === null ? null : db.createEpic(projectId, newEpic.title, newEpic.description, session.id);
          const fallbackEpic = createdEpic?.id ?? defaultEpic;
          // Les nouvelles tâches ne dépendent que de tâches existantes ou antérieures : pas de cycle possible.
          const tasks: Task[] = [];
          for (const { text, deps, epicId } of items) {
            const task = db.createTask(
              projectId,
              text,
              session.id,
              epicId === undefined ? fallbackEpic : epicId,
            );
            const dependsOn = deps.map((dep) => (typeof dep === 'number' ? (tasks[dep - 1] as Task).id : dep));
            tasks.push(dependsOn.length === 0 ? task : (db.updateTask(task.id, { dependsOn }) ?? task));
          }
          return { createdEpic, created: tasks };
        }));
      } catch (caught) {
        return error(reply, 500, caught instanceof Error ? caught.message : 'Impossible d’enregistrer les tâches');
      }
      if (createdEpic !== null) broadcast({ type: 'epic', epic: createdEpic });
      for (const task of created) broadcast({ type: 'task', task });
      return reply.code(201).send({
        count: created.length,
        epic: createdEpic === null ? null : { id: createdEpic.id, title: createdEpic.title },
        tasks: created.map(({ id, text, dependsOn, epicId }) => ({ id, text, dependsOn, epicId })),
      });
    },
  );

  // Remplace les dépendances d'une tâche du projet.
  app.patch<{ Params: { id: string; taskId: string } }>('/api/backlog/:id/tasks/:taskId', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const session = checked.value;
    const current = db.getTask(request.params.taskId);
    if (current === null || current.projectId !== session.projectId)
      return error(reply, 404, 'Tâche introuvable dans ce projet');
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
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const session = checked.value;
    const task = db.getTask(request.params.taskId);
    if (task === null || (task.projectId !== session.projectId && task.sourceSessionId !== session.id))
      return error(reply, 404, 'Tâche introuvable dans ce projet');
    if (task.sourceSessionId !== session.id)
      return error(reply, 403, 'Seules les tâches créées par cette session peuvent être supprimées ici');
    if (task.status !== 'todo') return error(reply, 409, "Tâche déjà démarrée : à supprimer depuis l'interface");
    const dependents = db.listDependents(task.id);
    db.deleteTask(task.id);
    broadcast({ type: 'task-deleted', id: task.id });
    broadcastTasks(dependents);
    return reply.code(204).send();
  });
}
