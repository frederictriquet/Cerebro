import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-protection-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;

const { CerebroDatabase, SessionProtectionError } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { ATTACHMENTS_DIR } = await import('../server/config.ts');
const { parseSession } = await import('../web/src/types.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');

mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () { this.markReady(); this.markSynced(); });
after(() => { mock.restoreAll(); rmSync(root, { recursive: true, force: true }); });

function createSession(db, project, status = 'exited') {
  return db.createSession({
    id: randomUUID(), projectId: project.id, agent: 'codex', mode: 'auto', model: null, effort: null,
    prompt: '', title: 'Conversation', status, agentSessionId: null,
  }, 'test-token');
}

test('migration defaults existing sessions to unprotected; protection persists without changing activity', () => {
  const path = join(root, 'migration.db');
  let db = new CerebroDatabase(path);
  const project = db.createProject('Projet', root);
  const session = createSession(db, project);
  assert.equal(session.protected, false);
  db.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('ALTER TABLE sessions DROP COLUMN protected');
  legacy.close();

  db = new CerebroDatabase(path);
  assert.equal(db.getSession(session.id).protected, false);
  const protectedSession = db.setSessionProtected(session.id, true);
  assert.equal(protectedSession.updatedAt, session.updatedAt);
  assert.equal(parseSession(protectedSession).protected, true);
  const { protected: ignored, ...oldPayload } = protectedSession;
  assert.equal(parseSession(oldPayload).protected, false);
  db.close();

  db = new CerebroDatabase(path);
  try {
    assert.equal(db.getSession(session.id).protected, true);
    db.updateSession(session.id, { title: 'Renommée', status: 'idle' });
    assert.equal(db.getSession(session.id).protected, true);
    assert.throws(() => db.deleteSession(session.id), SessionProtectionError);
    assert.throws(() => db.deleteProject(project.id), SessionProtectionError);
    db.setSessionProtected(session.id, false);
    assert.equal(db.deleteSession(session.id), true);
    assert.equal(db.deleteProject(project.id), true);
  } finally { db.close(); }
});

test('protected sessions reject deletion before stopping processes or removing artifacts; changes are broadcast', async (t) => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Projet', root);
    const session = createSession(db, project, 'running');
    createSession(db, project);
    const manager = new SessionManager(db);
    const stop = t.mock.method(manager, 'stopProcesses', async () => {});
    const released = t.mock.fn();
    manager.onSessionReleased = released;
    const events = [];
    manager.onEvent((event) => events.push(event));
    const attachments = join(ATTACHMENTS_DIR, session.id);
    mkdirSync(attachments, { recursive: true });
    writeFileSync(join(attachments, 'image.png'), 'attachment');

    manager.setProtected(session.id, true);
    assert.equal(events.at(-1).session.protected, true);
    await assert.rejects(manager.delete(session.id), SessionProtectionError);
    await assert.rejects(manager.deleteProject(project.id), SessionProtectionError);
    assert.equal(stop.mock.callCount(), 0);
    assert.equal(released.mock.callCount(), 0);
    assert.equal(db.getSession(session.id).status, 'running');
    assert.equal(db.listProjectSessions(project.id).length, 2);
    assert.ok(existsSync(join(attachments, 'image.png')));
    assert.ok(!events.some((event) => event.type === 'session-deleted'));
    manager.setProtected(session.id, false);
    assert.equal(events.at(-1).session.protected, false);
    assert.equal(await manager.delete(session.id), true);
    assert.equal(stop.mock.callCount(), 1);
    assert.equal(existsSync(attachments), false);
  } finally { db.close(); }
});

test('purge skips protected idle/exited sessions, active sessions and recent sessions', async (t) => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Projet', root);
    const manager = new SessionManager(db);
    const stop = t.mock.method(manager, 'stopProcesses', async () => {});
    const kept = [];
    const removed = [];
    for (const status of ['idle', 'exited', 'running', 'waiting', 'starting']) {
      for (const protectedValue of [false, true]) {
        const session = createSession(db, project, status);
        db.connection.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now() - 2 * 60 * 60_000, session.id);
        manager.setProtected(session.id, protectedValue);
        (protectedValue || !['idle', 'exited'].includes(status) ? kept : removed).push(session.id);
      }
    }
    kept.push(createSession(db, project, 'idle').id);
    kept.push(createSession(db, project, 'exited').id);
    const otherProject = db.createProject('Autre', root);
    const other = createSession(db, otherProject);
    db.connection.prepare('UPDATE sessions SET updated_at = 0 WHERE id = ?').run(other.id);
    kept.push(other.id);
    assert.equal(await manager.purgeProject(project.id), 2);
    assert.deepEqual(stop.mock.calls.map((call) => call.arguments[0]).sort(), removed.sort());
    assert.deepEqual(db.listSessions().map((session) => session.id).sort(), kept.sort());
    assert.equal(await manager.purgeProject(project.id), 0);
  } finally { db.close(); }
});

for (const deletion of ['session', 'project']) {
  test(`protection cannot be acknowledged during ${deletion} deletion and becomes available after failure`, async (t) => {
    const db = new CerebroDatabase(':memory:');
    try {
      const project = db.createProject('Projet', root);
      const session = createSession(db, project);
      const manager = new SessionManager(db);
      let rejectStop;
      t.mock.method(manager, 'stopProcesses', () => new Promise((resolve, reject) => { rejectStop = reject; }));
      const pending = deletion === 'session' ? manager.delete(session.id) : manager.deleteProject(project.id);
      assert.throws(() => manager.setProtected(session.id, true), /Suppression déjà en cours/);
      rejectStop(new Error('Arrêt impossible'));
      await assert.rejects(pending, /Arrêt impossible/);
      assert.equal(manager.setProtected(session.id, true).protected, true);
    } finally { db.close(); }
  });
}

test('API validates the checkbox, preserves it after restart, rejects deletion and excludes protected sessions from purge', async () => {
  const db = new CerebroDatabase();
  const project = db.createProject('API', root);
  const protectedSession = createSession(db, project);
  const ordinarySession = createSession(db, project);
  db.connection.prepare('UPDATE sessions SET updated_at = 0 WHERE project_id = ?').run(project.id);
  db.close();
  let app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  const protectionUrl = `/api/sessions/${protectedSession.id}/protection`;
  try {
    for (const payload of [{}, { protected: 'true' }, { protected: 1 }, { protected: null }]) {
      assert.equal((await send('PATCH', protectionUrl, payload)).statusCode, 400);
    }
    assert.equal((await send('PATCH', '/api/sessions/missing/protection', { protected: true })).statusCode, 404);
    const response = await send('PATCH', protectionUrl, { protected: true });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().protected, true);
    assert.equal(response.json().updatedAt, 0);
    await app.close();
    app = await buildServer();
    assert.equal((await send('GET', '/api/sessions')).json().find((session) => session.id === protectedSession.id).protected, true);
    assert.equal((await send('DELETE', `/api/sessions/${protectedSession.id}`)).statusCode, 409);
    assert.equal((await send('DELETE', `/api/projects/${project.id}`)).statusCode, 409);
    const purge = await send('POST', `/api/projects/${project.id}/purge`);
    assert.equal(purge.statusCode, 200);
    assert.deepEqual(purge.json(), { deleted: 1 });
    const remaining = (await send('GET', '/api/sessions')).json();
    assert.ok(remaining.some((session) => session.id === protectedSession.id));
    assert.ok(!remaining.some((session) => session.id === ordinarySession.id));
    assert.deepEqual((await send('POST', `/api/projects/${project.id}/purge`)).json(), { deleted: 0 });
    assert.equal((await send('PATCH', protectionUrl, { protected: false })).json().protected, false);
    assert.equal((await send('DELETE', `/api/sessions/${protectedSession.id}`)).statusCode, 204);
    assert.equal((await send('DELETE', `/api/projects/${project.id}`)).statusCode, 204);
  } finally { await app.close(); }
});
