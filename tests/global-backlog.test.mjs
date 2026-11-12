import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-global-backlog-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
mock.method(os, 'homedir', () => root);
syncBuiltinESMExports();

const { CerebroDatabase } = await import('../server/db.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');
mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
});

test('le backlog global se gère sans projet, puis se dispatche dans le projet choisi', async () => {
  const app = await buildServer();
  const db = new CerebroDatabase();
  try {
    const cerebro = db.createProject('Cerebro', root);
    const edop = db.createProject('EDOP', root);
    const send = (method, path, payload) =>
      app.inject({ method, url: `/api/global-backlog${path}`, ...(payload === undefined ? {} : { payload }) });

    assert.deepEqual((await send('GET', '')).json(), { tasks: [], epics: [] });

    const epic = (await send('POST', '/epics', { title: 'Refonte', description: 'Contexte commun' })).json();
    const inEpic = (await send('POST', '/tasks', { text: 'Étape 1', epicId: epic.id })).json();
    const inEpic2 = (await send('POST', '/tasks', { text: 'Étape 2', epicId: epic.id })).json();
    const loose = (await send('POST', '/tasks', { text: 'Idée isolée' })).json();
    assert.equal(inEpic.epicId, epic.id);
    assert.equal(loose.epicId, null);

    assert.equal((await send('POST', '/tasks', { text: '   ' })).statusCode, 400);
    assert.equal((await send('POST', '/tasks', { text: 'x', epicId: 'inconnu' })).statusCode, 400);
    assert.equal(
      (await send('PATCH', `/tasks/${loose.id}`, { text: 'Idée reformulée' })).json().text,
      'Idée reformulée',
    );
    assert.equal((await send('PATCH', `/epics/${epic.id}`, { title: 'Refonte v2' })).json().title, 'Refonte v2');

    // Un projet inconnu ne consomme rien.
    assert.equal((await send('POST', `/tasks/${loose.id}/dispatch`, { projectId: 'nope' })).statusCode, 404);
    assert.equal((await send('POST', `/tasks/${loose.id}/dispatch`, {})).statusCode, 400);
    assert.equal(db.listGlobalBacklog().tasks.length, 3);

    const task = (await send('POST', `/tasks/${loose.id}/dispatch`, { projectId: cerebro.id })).json();
    assert.equal(task.projectId, cerebro.id);
    assert.equal(task.text, 'Idée reformulée');
    assert.equal(task.status, 'todo');
    assert.equal(db.getGlobalTask(loose.id), null);
    assert.equal((await send('POST', `/tasks/${loose.id}/dispatch`, { projectId: cerebro.id })).statusCode, 404);

    const moved = (await send('POST', `/epics/${epic.id}/dispatch`, { projectId: edop.id })).json();
    assert.equal(moved.epic.projectId, edop.id);
    assert.equal(moved.epic.title, 'Refonte v2');
    assert.equal(moved.epic.description, 'Contexte commun');
    assert.deepEqual(
      moved.tasks.map((t) => [t.text, t.epicId, t.projectId]),
      [
        ['Étape 1', moved.epic.id, edop.id],
        ['Étape 2', moved.epic.id, edop.id],
      ],
    );
    assert.deepEqual(db.listGlobalBacklog(), { tasks: [], epics: [] });
    assert.equal(db.listTasks().filter((t) => t.projectId === edop.id).length, 2);
    assert.equal(db.listTasks().filter((t) => t.projectId === cerebro.id).length, 1);
    assert.ok(inEpic.id && inEpic2.id);
  } finally {
    db.close();
    await app.close();
  }
});

test('supprimer un epic global garde ses tâches, sans epic', async () => {
  const app = await buildServer();
  const db = new CerebroDatabase();
  try {
    const epic = db.createGlobalEpic('À jeter', '');
    const task = db.createGlobalTask('Reste', epic.id);
    const res = await app.inject({ method: 'DELETE', url: `/api/global-backlog/epics/${epic.id}` });
    assert.equal(res.statusCode, 204);
    assert.equal(db.getGlobalTask(task.id).epicId, null);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/global-backlog/epics/${epic.id}` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/global-backlog/tasks/${task.id}` })).statusCode, 204);
  } finally {
    db.close();
    await app.close();
  }
});

test('un dispatch d’epic qui échoue ne laisse rien dans le projet ni ne vide le backlog global', () => {
  const db = new CerebroDatabase();
  try {
    const project = db.createProject('P', root);
    const epic = db.createGlobalEpic('Epic', '');
    db.createGlobalTask('Une', epic.id);
    db.createTask = () => {
      throw new Error('échec simulé');
    };
    assert.throws(() => db.dispatchGlobalEpic(epic.id, project.id), /échec simulé/);
    assert.equal(db.listGlobalBacklog().tasks.length, 1);
    assert.equal(db.listEpics().filter((e) => e.projectId === project.id).length, 0);
  } finally {
    db.close();
  }
});
