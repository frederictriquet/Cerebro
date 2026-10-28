import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-pin-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
mkdirSync(process.env.CEREBRO_DATA_DIR, { recursive: true });
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;

const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { parseSession } = await import('../shared/types.ts');
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
  rmSync(root, { recursive: true, force: true });
});

function createSession(db, project) {
  return db.createSession(
    {
      id: randomUUID(),
      projectId: project.id,
      agent: 'codex',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: 'Conversation',
      status: 'exited',
      agentSessionId: null,
    },
    'test-token',
  );
}

const pinnedIds = (db) =>
  db
    .listSessions()
    .filter((session) => session.pinned)
    .map((session) => session.id)
    .sort();

test('migration defaults existing sessions to unpinned; one pinned session per project, without changing activity', () => {
  const path = join(root, 'migration.db');
  let db = new CerebroDatabase(path);
  const project = db.createProject('Projet', root);
  const first = createSession(db, project);
  assert.equal(first.pinned, false);
  db.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('DROP INDEX sessions_pinned_project');
  legacy.exec('ALTER TABLE sessions DROP COLUMN pinned');
  legacy.close();

  db = new CerebroDatabase(path);
  try {
    assert.equal(db.getSession(first.id).pinned, false);
    const second = createSession(db, project);
    const other = createSession(db, db.createProject('Autre', root));

    const pinned = db.setSessionPinned(first.id, true);
    assert.deepEqual(
      pinned.map((session) => [session.id, session.pinned]),
      [[first.id, true]],
    );
    assert.equal(pinned[0].updatedAt, first.updatedAt);
    db.setSessionPinned(other.id, true);
    assert.deepEqual(pinnedIds(db), [first.id, other.id].sort());

    // Épingler une autre session du projet retire l'épingle de la première, pas celle des autres projets.
    const changed = db.setSessionPinned(second.id, true);
    assert.deepEqual(
      changed.map((session) => [session.id, session.pinned]),
      [
        [first.id, false],
        [second.id, true],
      ],
    );
    assert.deepEqual(pinnedIds(db), [second.id, other.id].sort());
    assert.throws(() => db.connection.prepare('UPDATE sessions SET pinned = 1 WHERE id = ?').run(first.id));

    assert.deepEqual(
      db.setSessionPinned(second.id, false).map((session) => session.pinned),
      [false],
    );
    assert.deepEqual(pinnedIds(db), [other.id]);
    assert.equal(db.setSessionPinned('missing', true), null);

    const { pinned: ignored, ...oldPayload } = db.getSession(other.id);
    assert.equal(parseSession(oldPayload).pinned, false);
    assert.equal(parseSession(db.getSession(other.id)).pinned, true);
  } finally {
    db.close();
  }
});

test('pinning broadcasts the session that lost its pin, then the pinned one', (t) => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Projet', root);
    const first = createSession(db, project);
    const second = createSession(db, project);
    const manager = new SessionManager(db, createServices(db));
    t.mock.method(manager, 'stopProcesses', async () => {});
    const events = [];
    manager.onEvent((event) => events.push(event));

    assert.equal(manager.setPinned(first.id, true).pinned, true);
    assert.equal(manager.setPinned(second.id, true).id, second.id);
    assert.deepEqual(
      events.map((event) => [event.type, event.session.id, event.session.pinned]),
      [
        ['session', first.id, true],
        ['session', first.id, false],
        ['session', second.id, true],
      ],
    );
    assert.equal(manager.setPinned('missing', true), null);
  } finally {
    db.close();
  }
});

test('API validates the pin, keeps a single pin per project after restart and frees it on deletion', async () => {
  const db = new CerebroDatabase();
  const project = db.createProject('API', root);
  const first = createSession(db, project);
  const second = createSession(db, project);
  db.close();
  let app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  const pinUrl = (id) => `/api/sessions/${id}/pin`;
  const pinned = async () =>
    (await send('GET', '/api/sessions'))
      .json()
      .filter((session) => session.projectId === project.id && session.pinned)
      .map((session) => session.id);
  try {
    for (const payload of [{}, { pinned: 'true' }, { pinned: 1 }, { pinned: null }]) {
      assert.equal((await send('PATCH', pinUrl(first.id), payload)).statusCode, 400);
    }
    assert.equal((await send('PATCH', pinUrl('missing'), { pinned: true })).statusCode, 404);
    const response = await send('PATCH', pinUrl(first.id), { pinned: true });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().pinned, true);
    assert.equal((await send('PATCH', pinUrl(second.id), { pinned: true })).json().pinned, true);
    await app.close();
    app = await buildServer();
    assert.deepEqual(await pinned(), [second.id]);
    assert.equal((await send('DELETE', `/api/sessions/${second.id}`)).statusCode, 204);
    assert.deepEqual(await pinned(), []);
    assert.equal((await send('PATCH', pinUrl(first.id), { pinned: true })).statusCode, 200);
    assert.equal((await send('PATCH', pinUrl(first.id), { pinned: false })).json().pinned, false);
    assert.deepEqual(await pinned(), []);
  } finally {
    await app.close();
  }
});
