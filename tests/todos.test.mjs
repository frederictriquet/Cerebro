import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { CerebroDatabase } from '../server/db.ts';
import { registerTodoRoutes } from '../server/todo-routes.ts';
import { parseTodoItem, parseTodoList, TODO_TEXT_MAX } from '../shared/todos.ts';

async function fixture(t) {
  const db = new CerebroDatabase(':memory:');
  const app = Fastify();
  registerTodoRoutes(app, db);
  t.after(async () => {
    await app.close();
    db.close();
  });
  return {
    db,
    send: (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }),
  };
}

test('todo API: create, list, edit, complete, reopen and delete without affecting other tasks', async (t) => {
  const { send } = await fixture(t);
  assert.deepEqual((await send('GET', '/api/todos')).json(), []);
  const response = await send('POST', '/api/todos', { text: '  Préparer la démo  ' });
  assert.equal(response.statusCode, 201);
  const first = response.json();
  assert.ok(parseTodoItem(first));
  assert.equal(first.text, 'Préparer la démo');
  assert.equal(first.done, false);
  const second = (await send('POST', '/api/todos', { text: 'Relire le compte rendu' })).json();

  const edited = (await send('PATCH', `/api/todos/${first.id}`, { text: '  Démo jeudi  ' })).json();
  assert.equal(edited.text, 'Démo jeudi');
  assert.equal(edited.done, false);
  assert.equal(edited.createdAt, first.createdAt);
  assert.ok(edited.updatedAt >= first.updatedAt);
  const completed = (await send('PATCH', `/api/todos/${first.id}`, { done: true })).json();
  assert.equal(completed.done, true);
  assert.equal(completed.text, edited.text);
  assert.deepEqual((await send('GET', '/api/todos')).json(), [completed, second]);
  assert.equal((await send('PATCH', `/api/todos/${first.id}`, { done: false })).json().done, false);

  assert.equal((await send('DELETE', `/api/todos/${first.id}`)).statusCode, 204);
  assert.deepEqual((await send('GET', '/api/todos')).json(), [second]);
  assert.equal((await send('PATCH', `/api/todos/${first.id}`, { done: true })).statusCode, 404);
  assert.equal((await send('DELETE', `/api/todos/${first.id}`)).statusCode, 404);
});

test('todo API rejects blank, oversized or malformed changes without changing saved tasks', async (t) => {
  const { db, send } = await fixture(t);
  for (const payload of [{}, { text: '' }, { text: ' \n ' }, { text: 1 }, { text: 'a'.repeat(TODO_TEXT_MAX + 1) }]) {
    assert.equal((await send('POST', '/api/todos', payload)).statusCode, 400);
  }
  const item = (await send('POST', '/api/todos', { text: 'a'.repeat(TODO_TEXT_MAX) })).json();
  for (const patch of [
    {},
    { text: '' },
    { text: null },
    { text: 'a'.repeat(TODO_TEXT_MAX + 1) },
    { done: 'true' },
    { text: 'Autre', done: null },
  ]) {
    assert.equal((await send('PATCH', `/api/todos/${item.id}`, patch)).statusCode, 400);
    assert.deepEqual(db.listTodos(), [item]);
  }
});

test('todos survive database restarts, including completion and deletion', () => {
  const root = mkdtempSync(join(tmpdir(), 'cerebro-todos-'));
  const path = join(root, 'test.db');
  let db = new CerebroDatabase(path);
  try {
    const item = db.createTodo('À conserver');
    const removed = db.createTodo('À supprimer');
    const saved = db.updateTodo(item.id, { text: 'Terminée', done: true });
    db.deleteTodo(removed.id);
    db.close();
    db = new CerebroDatabase(path);
    assert.deepEqual(db.listTodos(), [saved]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('todo response parsers reject malformed records and lists', () => {
  const item = { id: 'todo-1', text: 'Une tâche', done: false, createdAt: 1, updatedAt: 2 };
  assert.deepEqual(parseTodoItem(item), item);
  assert.deepEqual(parseTodoList([item]), [item]);
  for (const invalid of [null, { ...item, done: 0 }, { ...item, text: null }, { ...item, updatedAt: '2' }]) {
    assert.equal(parseTodoItem(invalid), null);
    assert.equal(parseTodoList([item, invalid]), null);
  }
});
