import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-delegation-'));
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

async function withServer(fn) {
  const app = await buildServer();
  const db = new CerebroDatabase();
  try {
    const a = db.createProject('Source', root);
    const b = db.createProject('Cible', root);
    const post = (url, payload) => app.inject({ method: 'POST', url, payload });
    await fn({ app, db, a, b, post });
  } finally {
    db.close();
    await app.close();
  }
}

test('déléguer une tâche copie dans le projet cible sans toucher la source', () =>
  withServer(async ({ db, a, b, post }) => {
    const source = db.createTask(a.id, 'Corriger le bug', null);
    assert.equal((await post(`/api/tasks/${source.id}/delegate`, {})).statusCode, 400);
    assert.equal((await post(`/api/tasks/${source.id}/delegate`, { projectId: a.id })).statusCode, 400);
    assert.equal((await post(`/api/tasks/${source.id}/delegate`, { projectId: 'inconnu' })).statusCode, 404);
    assert.equal(db.listTasks().length, 1);

    const res = await post(`/api/tasks/${source.id}/delegate`, { projectId: b.id });
    assert.equal(res.statusCode, 201);
    const copy = res.json();
    assert.equal(copy.projectId, b.id);
    assert.equal(copy.originTaskId, source.id);
    assert.equal(copy.text, 'Corriger le bug');
    assert.equal(copy.status, 'todo');
    const kept = db.getTask(source.id);
    assert.equal(kept.projectId, a.id);
    assert.equal(kept.status, 'todo');
    assert.equal(kept.originTaskId, null);

    // Déjà traitée : ni seconde délégation, ni lancement dans le projet source.
    const again = await post(`/api/tasks/${source.id}/delegate`, { projectId: b.id });
    assert.equal(again.statusCode, 409);
    assert.match(again.json().error, /Cible/);
    assert.equal((await post(`/api/tasks/${source.id}/start`, {})).statusCode, 409);

    // Supprimer la copie libère la source.
    assert.equal(db.deleteTask(copy.id), true);
    assert.equal((await post(`/api/tasks/${source.id}/delegate`, { projectId: b.id })).statusCode, 201);
  }));

test('une tâche non déléguable est refusée avec la raison', () =>
  withServer(async ({ db, a, b, post }) => {
    const epic = db.createEpic(a.id, 'E', '', null);
    const inEpic = db.createTask(a.id, 'Dans un epic', null, epic.id);
    const started = db.updateTask(db.createTask(a.id, 'Démarrée', null).id, { status: 'started' });
    const command = db.createTask(a.id, 'Commande', null, null, {
      type: 'command',
      commandId: 'x',
      completion: 'manual',
    });
    const blocker = db.createTask(a.id, 'Bloquante', null);
    const blocked = db.updateTask(db.createTask(a.id, 'Bloquée', null).id, { dependsOn: [blocker.id] });
    for (const [task, reason] of [
      [inEpic, /epic/],
      [started, /à faire/],
      [command, /commande/i],
      [blocked, /dépendances/],
    ]) {
      const res = await post(`/api/tasks/${task.id}/delegate`, { projectId: b.id });
      assert.equal(res.statusCode, 409, task.text);
      assert.match(res.json().error, reason);
    }
    assert.equal(db.listTasks().filter((t) => t.projectId === b.id).length, 0);
  }));

test('déléguer un epic copie l’epic et ses tâches ouvertes, dépendances comprises', () =>
  withServer(async ({ db, a, b, post }) => {
    const epic = db.createEpic(a.id, 'Chantier', 'Contexte', null);
    const finished = db.updateTask(db.createTask(a.id, 'Déjà fait', null, epic.id).id, { status: 'done' });
    const first = db.createTask(a.id, 'Étape 1', null, epic.id);
    const second = db.updateTask(db.createTask(a.id, 'Étape 2', null, epic.id).id, {
      dependsOn: [first.id, finished.id],
    });

    const res = await post(`/api/epics/${epic.id}/delegate`, { projectId: b.id });
    assert.equal(res.statusCode, 201);
    const { epic: copy, tasks } = res.json();
    assert.equal(copy.projectId, b.id);
    assert.equal(copy.originEpicId, epic.id);
    assert.equal(copy.title, 'Chantier');
    assert.equal(copy.description, 'Contexte');
    assert.deepEqual(
      tasks.map((t) => [t.text, t.originTaskId, t.epicId]),
      [
        ['Étape 1', first.id, copy.id],
        ['Étape 2', second.id, copy.id],
      ],
    );
    assert.deepEqual(tasks[1].dependsOn, [tasks[0].id]);

    // La source est intacte et ne se lance plus ici ; chaque tâche est aussi marquée comme traitée.
    assert.equal(db.listTasks().filter((t) => t.projectId === a.id).length, 3);
    assert.equal(db.getEpic(epic.id).projectId, a.id);
    assert.equal((await post(`/api/epics/${epic.id}/start`, {})).statusCode, 409);
    assert.equal((await post(`/api/tasks/${first.id}/start`, {})).statusCode, 409);
    assert.equal((await post(`/api/epics/${epic.id}/delegate`, { projectId: b.id })).statusCode, 409);
  }));

test('un epic dont une tâche dépend d’une tâche ouverte hors de lui n’est pas délégué', () =>
  withServer(async ({ db, a, b, post }) => {
    const epic = db.createEpic(a.id, 'Lié', '', null);
    const outside = db.createTask(a.id, 'Dehors', null);
    db.updateTask(db.createTask(a.id, 'Dedans', null, epic.id).id, { dependsOn: [outside.id] });
    const res = await post(`/api/epics/${epic.id}/delegate`, { projectId: b.id });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /hors de l'epic/);
    assert.equal(db.listEpics().filter((e) => e.projectId === b.id).length, 0);
    assert.equal(db.listTasks().filter((t) => t.projectId === b.id).length, 0);
  }));
