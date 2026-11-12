import type { FastifyInstance } from 'fastify';
import type { CerebroDatabase } from './db.ts';
import { error } from './routes-util.ts';
import { asRecord } from './util.ts';
import { TODO_TEXT_MAX, todoText } from '../shared/todos.ts';

export function registerTodoRoutes(app: FastifyInstance, db: CerebroDatabase): void {
  app.get('/api/todos', async () => db.listTodos());

  app.post('/api/todos', async (request, reply) => {
    const text = todoText(asRecord(request.body)?.text);
    if (text === null) return error(reply, 400, `Texte attendu : 1 à ${TODO_TEXT_MAX} caractères`);
    return reply.code(201).send(db.createTodo(text));
  });

  app.patch<{ Params: { id: string } }>('/api/todos/:id', async (request, reply) => {
    const body = asRecord(request.body);
    if (body === null || (body.text === undefined && body.done === undefined))
      return error(reply, 400, 'Texte ou état attendu');
    const text = body.text === undefined ? undefined : todoText(body.text);
    if (text === null) return error(reply, 400, `Texte attendu : 1 à ${TODO_TEXT_MAX} caractères`);
    if (body.done !== undefined && typeof body.done !== 'boolean') return error(reply, 400, 'done (booléen) attendu');
    const item = db.updateTodo(request.params.id, {
      ...(text === undefined ? {} : { text }),
      ...(typeof body.done === 'boolean' ? { done: body.done } : {}),
    });
    return item === null ? error(reply, 404, 'Tâche introuvable') : reply.send(item);
  });

  app.delete<{ Params: { id: string } }>('/api/todos/:id', async (request, reply) => {
    if (!db.deleteTodo(request.params.id)) return error(reply, 404, 'Tâche introuvable');
    return reply.code(204).send();
  });
}
