import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-open-subtasks-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;

const { CerebroDatabase, SessionProtectionError } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { insertSessionTask } = await import('../server/session-tasks.ts');

after(() => rmSync(root, { recursive: true, force: true }));

function createSession(db, project, { status = 'exited', epicId = null, dormant = false } = {}) {
  const session = db.createSession(
    {
      id: randomUUID(),
      projectId: project.id,
      agent: 'codex',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: 'Conversation',
      status,
      agentSessionId: null,
    },
    'test-token',
    epicId,
  );
  if (dormant) {
    db.connection
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(Date.now() - 2 * 60 * 60_000, session.id);
  }
  return session;
}

function setup(t) {
  const db = new CerebroDatabase(':memory:');
  t.after(() => db.close());
  const project = db.createProject('Projet', root);
  const manager = new SessionManager(db, createServices(db));
  const stop = t.mock.method(manager, 'stopProcesses', async () => {});
  return { db, project, manager, stop };
}

for (const status of ['todo', 'in_progress', 'blocked']) {
  test(`a session with a ${status} subtask cannot be deleted, before anything is stopped`, async (t) => {
    const { db, project, manager, stop } = setup(t);
    const session = createSession(db, project, { status: 'running' });
    insertSessionTask(db, session.id, { title: 'Done', status: 'done' });
    const open = insertSessionTask(db, session.id, { title: 'Open', status });
    assert.equal(db.getSession(session.id).openSubtasks, 1, 'the count drives the greyed delete button');

    assert.throws(() => db.deleteSession(session.id), SessionProtectionError);
    await assert.rejects(manager.delete(session.id), (error) => {
      assert.ok(error instanceof SessionProtectionError);
      assert.match(error.message, /1 sous-tâche non terminée/);
      return true;
    });
    await assert.rejects(manager.deleteProject(project.id), SessionProtectionError);
    assert.throws(() => db.deleteProject(project.id), SessionProtectionError);
    assert.equal(stop.mock.callCount(), 0);
    assert.equal(db.getSession(session.id).status, 'running');
    assert.notEqual(db.getProject(project.id), null);

    db.connection.prepare('UPDATE session_tasks SET status = ? WHERE id = ?').run('cancelled', open.id);
    assert.equal(await manager.delete(session.id), true);
    assert.equal(db.getSession(session.id), null);
  });
}

test('done and cancelled subtasks do not block deletion', async (t) => {
  const { db, project, manager } = setup(t);
  const session = createSession(db, project);
  insertSessionTask(db, session.id, { title: 'Done', status: 'done' });
  insertSessionTask(db, session.id, { title: 'Dropped', status: 'cancelled' });
  assert.equal(await manager.delete(session.id), true);
  createSession(db, project);
  assert.equal(await manager.deleteProject(project.id), true);
});

test('purge and epic deletion keep sessions with open subtasks', async (t) => {
  const { db, project, manager } = setup(t);
  const blocked = createSession(db, project, { dormant: true });
  insertSessionTask(db, blocked.id, { title: 'Open' });
  const free = createSession(db, project, { dormant: true });
  assert.equal(await manager.purgeProject(project.id), 1);
  assert.notEqual(db.getSession(blocked.id), null);
  assert.equal(db.getSession(free.id), null);

  const epic = db.createEpic(project.id, 'Epic', '', null);
  const epicBlocked = createSession(db, project, { epicId: epic.id });
  insertSessionTask(db, epicBlocked.id, { title: 'Open', status: 'in_progress' });
  const epicFree = createSession(db, project, { epicId: epic.id });
  assert.deepEqual(await manager.deleteEpicSessions(epic.id), { deleted: 1, kept: 1 });
  assert.notEqual(db.getSession(epicBlocked.id), null);
  assert.equal(db.getSession(epicFree.id), null);
});
