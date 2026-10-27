import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-backlog-completed-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
mock.method(os, 'homedir', () => root);
syncBuiltinESMExports();

const { CerebroDatabase } = await import('../server/db.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { CommandExecutor } = await import('../server/commands.ts');
const { buildServer } = await import('../server/index.ts');
mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () { this.markReady(); this.markSynced(); });

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
});

test('la purge supprime les epics terminés et leurs tâches, conserve les autres et diffuse les changements', async () => {
  const app = await buildServer();
  const db = new CerebroDatabase();
  let socket;
  try {
    const project = db.createProject('Backlog', root);
    const other = db.createProject('Autre projet', root);
    const completed = db.createEpic(project.id, 'Terminé', '', null);
    const mixed = db.createEpic(project.id, 'En cours', '', null);
    const empty = db.createEpic(project.id, 'Vide', '', null);
    const foreign = db.createEpic(other.id, 'Terminé ailleurs', '', null);
    const task = (projectId, epicId, status) => {
      const created = db.createTask(projectId, status, null, epicId);
      return db.updateTask(created.id, { status });
    };
    const removed = [
      task(project.id, completed.id, 'done'),
      task(project.id, completed.id, 'done'),
      task(project.id, mixed.id, 'done'),
      task(project.id, null, 'done'),
    ];
    const kept = [
      task(project.id, mixed.id, 'todo'),
      task(project.id, mixed.id, 'started'),
      task(project.id, null, 'todo'),
      task(other.id, foreign.id, 'done'),
    ];
    db.updateTask(kept[0].id, { dependsOn: [removed[0].id, kept[2].id] });
    const url = `/api/projects/${project.id}/backlog/completed`;
    const active = mock.method(CommandExecutor.prototype, 'activeTaskIds', () => new Set([removed[0].id]));
    try {
      assert.equal((await app.inject({ method: 'DELETE', url })).statusCode, 409);
      assert.ok(db.getEpic(completed.id));
      assert.ok(removed.every((item) => db.getTask(item.id) !== null));
    } finally {
      active.mock.restore();
    }
    await app.ready();
    const messages = [];
    socket = await app.injectWS('/ws/events', {}, {
      onInit: (ws) => ws.on('message', (data) => messages.push(JSON.parse(data.toString()))),
    });
    const updated = new Promise((resolve) => socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'task' && message.task.id === kept[0].id) resolve(message.task);
    }));
    const response = await app.inject({ method: 'DELETE', url });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(new Set(response.json().taskIds), new Set(removed.map((item) => item.id)));
    assert.deepEqual(response.json().epicIds, [completed.id]);
    assert.deepEqual((await updated).dependsOn, [kept[2].id]);
    assert.deepEqual(new Set(db.listTasks().map((item) => item.id)), new Set(kept.map((item) => item.id)));
    assert.deepEqual(new Set(db.listEpics().map((item) => item.id)), new Set([mixed.id, empty.id, foreign.id]));
    assert.equal(db.getTask(kept[0].id).epicId, mixed.id);
    assert.deepEqual(messages.filter((item) => item.type === 'epic-deleted'), [{ type: 'epic-deleted', id: completed.id }]);
    assert.equal(messages.filter((item) => item.type === 'task-deleted').length, removed.length);
    assert.deepEqual((await app.inject({ method: 'DELETE', url })).json(), { taskIds: [], epicIds: [] });
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/projects/missing/backlog/completed' })).statusCode, 404);
  } finally {
    socket?.terminate();
    db.close();
    await app.close();
  }
});

test('un échec de suppression de l’epic restaure ses tâches et leurs dépendances', () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Transaction', root);
    const epic = db.createEpic(project.id, 'Terminé', '', null);
    const done = db.createTask(project.id, 'Terminée', null, epic.id);
    db.updateTask(done.id, { status: 'done' });
    const dependent = db.createTask(project.id, 'À faire', null);
    db.updateTask(dependent.id, { dependsOn: [done.id] });
    db.connection.exec("CREATE TRIGGER fail_epic_delete BEFORE DELETE ON epics BEGIN SELECT RAISE(ABORT, 'échec simulé'); END");
    assert.throws(() => db.deleteCompletedBacklog(project.id), /échec simulé/);
    assert.equal(db.getTask(done.id).epicId, epic.id);
    assert.ok(db.getEpic(epic.id));
    assert.deepEqual(db.getTask(dependent.id).dependsOn, [done.id]);
    db.connection.exec('DROP TRIGGER fail_epic_delete');
    db.deleteCompletedBacklog(project.id);
    assert.equal(db.getTask(done.id), null);
    assert.equal(db.getEpic(epic.id), null);
  } finally {
    db.close();
  }
});
