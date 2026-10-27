import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CerebroDatabase } from './db.ts';
import { routeErrors } from './routes-util.ts';
import type { IdRequest } from './route-context.ts';
import { SESSION_TASK_STATUSES, type SessionTask, type SessionTaskStatus } from '../shared/backlog.ts';

type TaskFields = Pick<SessionTask, 'title' | 'status' | 'note'>;
const SELECT = `SELECT id, session_id AS sessionId, title, status, note,
  created_at AS createdAt, updated_at AS updatedAt FROM session_tasks`;

function parseFields(raw: unknown, create: boolean): Partial<TaskFields> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Objet JSON requis.');
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['title', 'status', 'note'].includes(key))) throw new Error('Champ inconnu.');
  const fields: Partial<TaskFields> = {};
  if (create || 'title' in body) {
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 500) {
      throw new Error('Titre requis, de 1 à 500 caractères.');
    }
    fields.title = body.title.trim();
  }
  if ('status' in body) {
    if (!SESSION_TASK_STATUSES.includes(body.status as SessionTaskStatus)) throw new Error('Statut invalide.');
    fields.status = body.status as SessionTaskStatus;
  }
  if ('note' in body) {
    if (typeof body.note !== 'string' || body.note.length > 10_000)
      throw new Error('Note limitée à 10 000 caractères.');
    fields.note = body.note;
  }
  if (!create && !Object.keys(fields).length) throw new Error('Aucun champ à modifier.');
  return fields;
}

export function listSessionTasks(db: CerebroDatabase, sessionId: string): SessionTask[] {
  return db.connection
    .prepare(`${SELECT} WHERE session_id = ? ORDER BY created_at, rowid`)
    .all(sessionId) as unknown as SessionTask[];
}

function getSessionTask(db: CerebroDatabase, sessionId: string, id: string): SessionTask | null {
  return (
    (db.connection.prepare(`${SELECT} WHERE session_id = ? AND id = ?`).get(sessionId, id) as unknown as SessionTask) ??
    null
  );
}

// Browser routes use the application authentication; agent routes require the owning session's token.
const badRequest = routeErrors(400);

export function registerSessionTaskRoutes(
  app: FastifyInstance,
  db: CerebroDatabase,
  sessionTokenValid: (request: IdRequest) => boolean,
): void {
  type Params = { id: string; taskId: string };
  for (const agent of [false, true]) {
    const base = agent ? '/api/session-tasks/:id' : '/api/sessions/:id/tasks';
    const guard = async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply): Promise<void> => {
      if (agent && !sessionTokenValid(request)) {
        await reply.code(403).send({ error: 'Token de session invalide.' });
        return;
      }
      if (!db.getSession(request.params.id)) await reply.code(404).send({ error: 'Session introuvable.' });
    };
    const options = { preHandler: guard };
    app.get<{ Params: Params }>(base, options, async (request) => listSessionTasks(db, request.params.id));
    app.get<{ Params: Params }>(`${base}/:taskId`, options, async (request, reply) => {
      const task = getSessionTask(db, request.params.id, request.params.taskId);
      return task ?? reply.code(404).send({ error: 'Sous-tâche introuvable dans cette session.' });
    });
    app.post<{ Params: Params }>(base, options, async (request, reply) => {
      const parsed = await badRequest.orError(reply, () => parseFields(request.body, true));
      if (!parsed.ok) return parsed.reply;
      const fields = parsed.value;
      const task: SessionTask = {
        id: randomUUID(),
        sessionId: request.params.id,
        title: fields.title!,
        status: fields.status ?? 'todo',
        note: fields.note ?? '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      db.connection
        .prepare(
          `INSERT INTO session_tasks (id, session_id, title, status, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(task.id, task.sessionId, task.title, task.status, task.note, task.createdAt, task.updatedAt);
      return reply.code(201).send(task);
    });
    app.patch<{ Params: Params }>(`${base}/:taskId`, options, async (request, reply) => {
      const current = getSessionTask(db, request.params.id, request.params.taskId);
      if (!current) return reply.code(404).send({ error: 'Sous-tâche introuvable dans cette session.' });
      const parsed = await badRequest.orError(reply, () => parseFields(request.body, false));
      if (!parsed.ok) return parsed.reply;
      const fields = parsed.value;
      const next = { ...current, ...fields, updatedAt: Date.now() };
      db.connection
        .prepare(
          `UPDATE session_tasks SET title = ?, status = ?, note = ?, updated_at = ?
        WHERE session_id = ? AND id = ?`,
        )
        .run(next.title, next.status, next.note, next.updatedAt, next.sessionId, next.id);
      return next;
    });
    app.delete<{ Params: Params }>(`${base}/:taskId`, options, async (request, reply) => {
      const result = db.connection
        .prepare('DELETE FROM session_tasks WHERE session_id = ? AND id = ?')
        .run(request.params.id, request.params.taskId);
      return result.changes
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'Sous-tâche introuvable dans cette session.' });
    });
  }
}
