import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-db-transaction-'));
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

test('une transaction imbriquée n’annule que son propre travail, et updateTask s’y inscrit', () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Imbrication', root);
    const first = db.createTask(project.id, 'Première', null);
    const second = db.createTask(project.id, 'Seconde', null);
    db.transaction(() => {
      // Ouvrait auparavant son propre BEGIN, refusé dans une transaction en cours.
      db.updateTask(second.id, { dependsOn: [first.id] });
      assert.throws(
        () =>
          db.transaction(() => {
            db.createTask(project.id, 'Annulée', null);
            throw new Error('échec interne');
          }),
        /échec interne/,
      );
    });
    assert.deepEqual(db.getTask(second.id).dependsOn, [first.id]);
    assert.deepEqual(
      db
        .listTasks()
        .map((task) => task.text)
        .sort(),
      ['Première', 'Seconde'],
    );

    assert.throws(
      () =>
        db.transaction(() => {
          db.updateTask(first.id, { text: 'Modifiée', dependsOn: [] });
          db.transaction(() => db.createTask(project.id, 'Validée puis annulée', null));
          throw new Error('échec externe');
        }),
      /échec externe/,
    );
    assert.equal(db.getTask(first.id).text, 'Première');
    assert.equal(db.listTasks().length, 2);
    assert.equal(db.connection.isTransaction, false);

    assert.throws(() => db.transaction(async () => db.createTask(project.id, 'Asynchrone', null)), /synchrone/);
    assert.equal(db.listTasks().length, 2);
  } finally {
    db.close();
  }
});

test('la suppression d’un projet qui échoue conserve ses rapports de council', () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Suppression', root);
    db.connection
      .prepare('INSERT INTO council_runs (id, project_id, data) VALUES (?, ?, ?)')
      .run('run', project.id, '{}');
    db.connection.exec(
      "CREATE TRIGGER fail_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'échec simulé'); END",
    );
    assert.throws(() => db.deleteProject(project.id), /échec simulé/);
    assert.ok(db.getProject(project.id));
    assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM council_runs').get().n, 1);
  } finally {
    db.close();
  }
});

test('un envoi en lot qui échoue au milieu ne crée ni tâche ni epic et ne diffuse rien', async () => {
  const app = await buildServer();
  const db = new CerebroDatabase();
  let socket;
  try {
    const project = db.createProject('Lot', root);
    const session = db.createSession(
      {
        id: randomUUID(),
        projectId: project.id,
        agent: 'claude',
        mode: 'auto',
        model: null,
        effort: null,
        prompt: '',
        title: 'Source',
        status: 'idle',
        agentSessionId: null,
      },
      'token',
    );
    const existing = db.createTask(project.id, 'Existante', null);
    await app.ready();
    const messages = [];
    socket = await app.injectWS(
      '/ws/events',
      {},
      {
        onInit: (ws) => ws.on('message', (data) => messages.push(JSON.parse(data.toString()))),
      },
    );
    const send = (url, payload) =>
      app.inject({ method: 'POST', url, headers: { 'x-cerebro-token': 'token' }, payload });
    db.connection.exec(
      "CREATE TRIGGER fail_task BEFORE INSERT ON tasks WHEN NEW.text = 'boom' BEGIN SELECT RAISE(ABORT, 'échec simulé'); END",
    );

    const batch = await send(`/api/backlog/${session.id}`, {
      epic: { title: 'Nouvel epic' },
      tasks: ['Avant', { text: 'Dépendante', dependsOn: [1, existing.id] }, 'boom', 'Après'],
    });
    assert.equal(batch.statusCode, 500, batch.body);
    assert.match(batch.json().error, /échec simulé/);
    assert.deepEqual(
      db.listTasks().map((task) => task.id),
      [existing.id],
    );
    assert.deepEqual(db.listEpics(), []);
    assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM task_dependencies').get().n, 0);

    // Échec du rangement d'une tâche : l'epic créé juste avant disparaît aussi.
    db.connection.exec(
      "CREATE TRIGGER fail_assign BEFORE UPDATE OF epic_id ON tasks BEGIN SELECT RAISE(ABORT, 'rangement refusé'); END",
    );
    const epic = await send(`/api/backlog/${session.id}/epics`, { title: 'Epic refusé', taskIds: [existing.id] });
    assert.equal(epic.statusCode, 500);
    assert.deepEqual(db.listEpics(), []);
    assert.equal(db.getTask(existing.id).epicId, null);
    db.connection.exec('DROP TRIGGER fail_assign');

    const ok = await send(`/api/backlog/${session.id}`, {
      epic: { title: 'Nouvel epic' },
      tasks: ['Avant', { text: 'Dépendante', dependsOn: [1] }],
    });
    assert.equal(ok.statusCode, 201, ok.body);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      messages.filter((item) => item.type === 'epic').map((item) => item.epic.id),
      [ok.json().epic.id],
    );
    assert.deepEqual(
      messages.filter((item) => item.type === 'task').map((item) => item.task.text),
      ['Avant', 'Dépendante'],
    );
  } finally {
    socket?.terminate();
    db.close();
    await app.close();
  }
});
