import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-project-order-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
// Isoler aussi l’installation du hook Grok, sans modifier HOME ou CODEX_HOME.
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

const ids = (projects) => projects.map((project) => project.id);

test('migration conserve l’ordre initial, puis les déplacements survivent au redémarrage et aux modifications', () => {
  const path = join(root, 'migration.db');
  let db = new CerebroDatabase(path);
  const first = db.createProject('Premier', root);
  const second = db.createProject('Deuxième', root);
  const third = db.createProject('Troisième', root);
  db.connection.prepare('UPDATE projects SET created_at = ? WHERE id = ?').run(10, first.id);
  db.connection.prepare('UPDATE projects SET created_at = ? WHERE id = ?').run(20, second.id);
  db.connection.prepare('UPDATE projects SET created_at = ? WHERE id = ?').run(20, third.id);
  db.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('ALTER TABLE projects DROP COLUMN sort_order');
  legacy.close();

  db = new CerebroDatabase(path);
  try {
    assert.deepEqual(ids(db.listProjects()), [first.id, second.id, third.id]);
    const before = db.listProjects();
    assert.deepEqual(db.reorderProjects([third.id, first.id, second.id]), [before[2], before[0], before[1]]);
    db.close();
    db = new CerebroDatabase(path);
    assert.deepEqual(ids(db.listProjects()), [third.id, first.id, second.id]);
    db.updateProject(first.id, { name: 'Renommé' });
    const added = db.createProject('Nouveau', root);
    assert.deepEqual(ids(db.listProjects()), [third.id, first.id, second.id, added.id]);
    db.deleteProject(first.id);
    assert.deepEqual(ids(db.listProjects()), [third.id, second.id, added.id]);
  } finally {
    db.close();
  }
});

test('une liste incomplète, inconnue ou dupliquée ne modifie jamais l’ordre', () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const first = db.createProject('Premier', root);
    const second = db.createProject('Deuxième', root);
    for (const invalid of [[], [first.id], [second.id, second.id], [second.id, 'inconnu']]) {
      assert.equal(db.reorderProjects(invalid), null);
      assert.deepEqual(ids(db.listProjects()), [first.id, second.id]);
    }
    assert.deepEqual(ids(db.reorderProjects([second.id, first.id])), [second.id, first.id]);
  } finally {
    db.close();
  }
});

test('l’API valide, diffuse et conserve le nouvel ordre après redémarrage', async () => {
  let app = await buildServer();
  let socket;
  const messages = [];
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    const projects = [];
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      const response = await send('POST', '/api/projects', { name, path: root });
      assert.equal(response.statusCode, 201);
      projects.push(response.json());
    }
    await app.ready();
    socket = await app.injectWS('/ws/events', {}, {
      onInit: (ws) => ws.on('message', (data) => messages.push(JSON.parse(data.toString()))),
    });
    const original = ids(projects);
    for (const payload of [{}, { ids: null }, { ids: 'alpha' }, { ids: [null] }, { ids: [original[0], original[0]] }]) {
      assert.equal((await send('PUT', '/api/projects/order', payload)).statusCode, 400);
    }
    for (const invalid of [original.slice(1), [...original.slice(1), 'inconnu']]) {
      assert.equal((await send('PUT', '/api/projects/order', { ids: invalid })).statusCode, 409);
    }
    assert.deepEqual(ids((await send('GET', '/api/projects')).json()), original);

    const order = [original[2], original[0], original[1]];
    const broadcast = new Promise((resolve) => socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'projects') resolve(message);
    }));
    const response = await send('PUT', '/api/projects/order', { ids: order });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(ids(response.json()), order);
    assert.deepEqual(ids((await broadcast).projects), order);
    assert.equal(messages.filter((message) => message.type === 'projects').length, 1);
    socket.terminate();
    socket = null;

    await app.close();
    app = await buildServer();
    assert.deepEqual(ids((await send('GET', '/api/projects')).json()), order);
    const added = (await send('POST', '/api/projects', { name: 'Delta', path: root })).json();
    assert.deepEqual(ids((await send('GET', '/api/projects')).json()), [...order, added.id]);
    assert.equal((await send('PUT', '/api/projects/order', { ids: order })).statusCode, 409);
    assert.deepEqual(ids((await send('GET', '/api/projects')).json()), [...order, added.id]);
  } finally {
    socket?.terminate();
    await app.close();
  }
});
