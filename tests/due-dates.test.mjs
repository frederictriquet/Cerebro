import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-due-dates-'));
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

test('une tâche reçoit une échéance à la création, la change, l’efface et refuse une date invalide', () =>
  withServer(async ({ app, db, a }) => {
    const send = (method, url, payload) => app.inject({ method, url, payload });
    const created = await send('POST', `/api/projects/${a.id}/tasks`, { text: 'Plus tard', dueDate: '2026-12-01' });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().dueDate, '2026-12-01');
    const none = (await send('POST', `/api/projects/${a.id}/tasks`, { text: 'Sans date' })).json();
    assert.equal(none.dueDate, null);

    for (const dueDate of ['2026-02-30', '2026-13-01', 'demain', '2026-1-1', 20261201, '']) {
      const res = await send('PATCH', `/api/tasks/${none.id}`, { dueDate });
      assert.equal(res.statusCode, 400, String(dueDate));
      assert.match(res.json().error, /AAAA-MM-JJ/);
    }
    assert.equal((await send('POST', `/api/projects/${a.id}/tasks`, { text: 'x', dueDate: 'hier' })).statusCode, 400);
    assert.equal(db.getTask(none.id).dueDate, null);

    assert.equal(
      (await send('PATCH', `/api/tasks/${none.id}`, { dueDate: '2026-11-20' })).json().dueDate,
      '2026-11-20',
    );
    // Une autre modification ne touche pas l'échéance.
    assert.equal((await send('PATCH', `/api/tasks/${none.id}`, { text: 'Reformulée' })).json().dueDate, '2026-11-20');
    assert.equal((await send('PATCH', `/api/tasks/${none.id}`, { dueDate: null })).json().dueDate, null);
    assert.equal(db.getTask(none.id).dueDate, null);
  }));

test('un epic reçoit une échéance, et la délégation la copie avec ses tâches', () =>
  withServer(async ({ app, db, a, b, post }) => {
    const res = await post(`/api/projects/${a.id}/epics`, { title: 'Chantier', dueDate: '2026-12-24' });
    assert.equal(res.statusCode, 201);
    const epic = res.json();
    assert.equal(epic.dueDate, '2026-12-24');
    assert.equal((await post(`/api/projects/${a.id}/epics`, { title: 'Faux', dueDate: '2026-02-30' })).statusCode, 400);

    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/epics/${epic.id}`,
      payload: { dueDate: '2027-01-05' },
    });
    assert.equal(moved.json().dueDate, '2027-01-05');
    assert.equal(
      (await app.inject({ method: 'PATCH', url: `/api/epics/${epic.id}`, payload: { dueDate: 'x' } })).statusCode,
      400,
    );
    assert.equal(db.getEpic(epic.id).dueDate, '2027-01-05');

    const dated = db.createTask(a.id, 'Datée', null, epic.id, { type: 'llm' }, null, '2026-12-30');
    db.createTask(a.id, 'Sans date', null, epic.id);
    const copy = (await post(`/api/epics/${epic.id}/delegate`, { projectId: b.id })).json();
    assert.equal(copy.epic.dueDate, '2027-01-05');
    assert.deepEqual(
      copy.tasks.map((t) => [t.text, t.dueDate]),
      [
        ['Datée', '2026-12-30'],
        ['Sans date', null],
      ],
    );
    const single = db.createTask(a.id, 'Seule', null, null, { type: 'llm' }, null, '2026-11-30');
    assert.equal((await post(`/api/tasks/${single.id}/delegate`, { projectId: b.id })).json().dueDate, '2026-11-30');
    assert.ok(dated);
  }));

test('le backlog global porte des échéances, refuse les dates invalides et les transmet au dispatch', () =>
  withServer(async ({ app, db, a, b }) => {
    const send = (method, url, payload) => app.inject({ method, url, payload });
    const epic = (
      await send('POST', '/api/global-backlog/epics', { title: 'Plus tard', dueDate: '2027-01-10' })
    ).json();
    assert.equal(epic.dueDate, '2027-01-10');
    const dated = (
      await send('POST', '/api/global-backlog/tasks', { text: 'Datée', epicId: epic.id, dueDate: '2027-01-02' })
    ).json();
    const loose = (await send('POST', '/api/global-backlog/tasks', { text: 'Libre' })).json();
    assert.equal(dated.dueDate, '2027-01-02');
    assert.equal(loose.dueDate, null);

    for (const [url, method] of [
      ['/api/global-backlog/tasks', 'POST'],
      ['/api/global-backlog/epics', 'POST'],
      [`/api/global-backlog/tasks/${loose.id}`, 'PATCH'],
      [`/api/global-backlog/epics/${epic.id}`, 'PATCH'],
    ]) {
      const res = await send(method, url, { text: 'x', title: 'x', dueDate: '2027-02-30' });
      assert.equal(res.statusCode, 400, `${method} ${url}`);
      assert.match(res.json().error, /AAAA-MM-JJ/);
    }
    assert.equal(db.getGlobalTask(loose.id).dueDate, null);

    assert.equal(
      (await send('PATCH', `/api/global-backlog/tasks/${loose.id}`, { dueDate: '2026-12-01' })).json().dueDate,
      '2026-12-01',
    );
    assert.equal(
      (await send('PATCH', `/api/global-backlog/tasks/${loose.id}`, { text: 'Libre bis' })).json().dueDate,
      '2026-12-01',
    );
    assert.equal(
      (await send('PATCH', `/api/global-backlog/epics/${epic.id}`, { dueDate: '2027-01-12' })).json().dueDate,
      '2027-01-12',
    );
    assert.deepEqual(
      (await send('GET', '/api/global-backlog')).json().tasks.map((t) => [t.text, t.dueDate]),
      [
        ['Datée', '2027-01-02'],
        ['Libre bis', '2026-12-01'],
      ],
    );

    const task = (await send('POST', `/api/global-backlog/tasks/${loose.id}/dispatch`, { projectId: a.id })).json();
    assert.equal(task.dueDate, '2026-12-01');
    const moved = (await send('POST', `/api/global-backlog/epics/${epic.id}/dispatch`, { projectId: b.id })).json();
    assert.equal(moved.epic.dueDate, '2027-01-12');
    assert.deepEqual(
      moved.tasks.map((t) => t.dueDate),
      ['2027-01-02'],
    );
    assert.ok(dated);
  }));

test('une base dont les tables globales n’ont pas de colonne d’échéance est migrée sans perte', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const first = new CerebroDatabase();
  const epic = first.createGlobalEpic('Ancien epic', 'Contexte');
  first.createGlobalTask('Ancienne tâche', epic.id);
  first.close();
  // État d'avant les échéances : tables globales sans due_date, peuplées.
  const raw = new DatabaseSync(join(process.env.CEREBRO_DATA_DIR, 'cerebro.db'));
  raw.exec('ALTER TABLE global_tasks DROP COLUMN due_date; ALTER TABLE global_epics DROP COLUMN due_date;');
  raw.close();

  const migrated = new CerebroDatabase();
  try {
    const { tasks, epics } = migrated.listGlobalBacklog();
    assert.deepEqual(
      tasks.map((t) => [t.text, t.epicId, t.dueDate]),
      [['Ancienne tâche', epic.id, null]],
    );
    assert.deepEqual(
      epics.map((e) => [e.title, e.description, e.dueDate]),
      [['Ancien epic', 'Contexte', null]],
    );
    assert.equal(migrated.updateGlobalTask(tasks[0].id, { dueDate: '2027-03-01' }).dueDate, '2027-03-01');
    assert.equal(migrated.getGlobalTask(tasks[0].id).dueDate, '2027-03-01');
  } finally {
    migrated.close();
  }
});
