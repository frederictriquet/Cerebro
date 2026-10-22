import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-session-epics-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
const { CerebroDatabase } = await import('../server/db.ts');
const { parseSession } = await import('../web/src/types.ts');
const { groupSessions, groupedSessionTitle, sessionEpic } = await import('../web/src/session-groups.ts');
after(() => rmSync(root, { recursive: true, force: true }));

function createSession(db, project, epicId = null, overrides = {}) {
  return db.createSession({
    id: randomUUID(), projectId: project.id, agent: 'codex', mode: 'auto', model: null, effort: null,
    prompt: 'Une demande', title: 'Une session', status: 'exited', agentSessionId: 'agent', ...overrides,
  }, 'token', epicId);
}

test('session epic survives retries, task moves, renames, backlog cleanup and restart', () => {
  const path = join(root, 'persist.db');
  let db = new CerebroDatabase(path);
  const project = db.createProject('Projet', root);
  const epic = db.createEpic(project.id, 'Livraison', '', null);
  const other = db.createEpic(project.id, 'Autre', '', null);
  const task = db.createTask(project.id, 'Étape', null, epic.id);
  const first = createSession(db, project, epic.id);
  const retry = createSession(db, project, epic.id);
  const loose = createSession(db, project);
  db.updateTask(task.id, { sessionId: first.id });
  db.updateTask(task.id, { sessionId: retry.id, epicId: other.id });
  db.updateSession(first.id, { title: 'Titre personnel' });
  const before = db.getSession(first.id).updatedAt;
  db.updateEpic(epic.id, { title: 'Livraison renommée' });
  const expected = { id: epic.id, title: 'Livraison renommée' };
  assert.deepEqual(db.getSession(first.id).epic, expected);
  assert.equal(db.getSession(first.id).updatedAt, before);
  db.updateTask(task.id, { epicId: epic.id, status: 'done' });
  db.deleteCompletedBacklog(project.id);
  assert.equal(db.getEpic(epic.id), null);
  assert.deepEqual(db.getSession(retry.id).epic, expected);
  db.close();
  db = new CerebroDatabase(path);
  try {
    assert.deepEqual(db.getSession(first.id).epic, expected);
    assert.equal(db.getSession(loose.id).epic, null);
    assert.deepEqual(db.listProjectSessions(project.id).find((s) => s.id === retry.id).epic, expected);
    assert.deepEqual(parseSession(db.getSession(first.id)).epic, expected);
  } finally { db.close(); }
});

test('migration links old steps and replaced attempts by run ID, assigned sessions by tasks, never by title or source', () => {
  const path = join(root, 'migration.db');
  let db = new CerebroDatabase(path);
  const project = db.createProject('Projet', root);
  const otherProject = db.createProject('Autre projet', root);
  const source = createSession(db, project, null, { title: 'Epic « Livraison » · étape 1/2 : nom trompeur' });
  const epic = db.createEpic(project.id, 'Livraison', '', source.id);
  const sameName = db.createEpic(project.id, 'Livraison', '', null);
  const task = db.createTask(project.id, 'Étape', source.id, epic.id);
  const runId = randomUUID();
  db.connection.prepare('INSERT INTO epic_runs VALUES (?, ?, ?)').run(runId, epic.id, '{}');
  const first = createSession(db, project, null, { prompt: `[CEREBRO_EPIC_STEP ${runId} ${task.id}]\nÉtape` });
  const retry = createSession(db, project, null, { prompt: first.prompt });
  db.updateTask(task.id, { sessionId: retry.id });
  const assigned = createSession(db, project);
  db.updateTask(db.createTask(project.id, 'Affectée', null, epic.id).id, { sessionId: assigned.id });
  const ambiguous = createSession(db, project);
  db.updateTask(db.createTask(project.id, 'A', null, epic.id).id, { sessionId: ambiguous.id });
  db.updateTask(db.createTask(project.id, 'B', null, sameName.id).id, { sessionId: ambiguous.id });
  const crossProject = createSession(db, otherProject, null, { prompt: first.prompt });
  db.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('ALTER TABLE sessions DROP COLUMN epic_id; ALTER TABLE sessions DROP COLUMN epic_title');
  legacy.close();
  db = new CerebroDatabase(path);
  try {
    for (const session of [first, retry, assigned]) {
      assert.deepEqual(db.getSession(session.id).epic, { id: epic.id, title: epic.title });
      assert.equal(db.getSession(session.id).updatedAt, session.updatedAt);
    }
    for (const session of [source, ambiguous, crossProject]) assert.equal(db.getSession(session.id).epic, null);
    assert.equal(db.listSessions().length, 6);
  } finally { db.close(); }
});

test('an epic from another project or an unknown epic cannot be assigned when launching', () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Projet', root);
    const other = db.createProject('Autre', root);
    const epic = db.createEpic(other.id, 'Epic', '', null);
    assert.throws(() => createSession(db, project, epic.id), /Epic introuvable/);
    assert.throws(() => createSession(db, project, 'missing'), /Epic introuvable/);
    assert.deepEqual(db.listSessions(), []);
  } finally { db.close(); }
});

test('grouping preserves creation order, separates IDs and projects, and survives removed epics', () => {
  const epic = { id: 'e1', title: 'Même titre', projectId: 'p1' };
  const sameName = { id: 'e2', title: 'Même titre', projectId: 'p1' };
  const sessions = [
    { id: 'new', projectId: 'p1', epic, status: 'running', createdAt: 5 },
    { id: 'loose', projectId: 'p1', epic: null, status: 'waiting', createdAt: 4 },
    { id: 'other', projectId: 'p1', epic: sameName, status: 'idle', createdAt: 3 },
    { id: 'old', projectId: 'p1', epic, status: 'exited', createdAt: 2 },
    { id: 'remote', projectId: 'p2', epic, status: 'exited', createdAt: 1 },
  ];
  const groups = groupSessions(sessions, [], []);
  assert.deepEqual(groups.map((group) => group.kind === 'session' ? group.session.id : group.sessions.map((s) => s.id)),
    [['new', 'old'], 'loose', ['other'], ['remote']]);
  assert.deepEqual(groupSessions(sessions.map((s) => ({ ...s, status: 'waiting', updatedAt: Date.now() })), [], [])
    .map((group) => group.kind === 'session' ? group.session.id : group.sessions.map((s) => s.id)),
    [['new', 'old'], 'loose', ['other'], ['remote']]);
  assert.equal(groupSessions(sessions, [], [{ ...epic, title: 'Nouveau nom' }])[0].epic.title, 'Nouveau nom');
});

test('legacy payloads use only unambiguous assigned tasks; stored origin takes precedence', () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Projet', root);
    const first = db.createEpic(project.id, 'Premier', '', null);
    const second = db.createEpic(project.id, 'Second', '', null);
    const session = createSession(db, project, first.id);
    const task = db.createTask(project.id, 'Étape', null, second.id);
    db.updateTask(task.id, { sessionId: session.id });
    const epics = db.listEpics();
    assert.equal(sessionEpic(session, db.listTasks(), epics).id, first.id);
    const { epic, ...oldPayload } = session;
    const parsed = parseSession(oldPayload);
    assert.equal(parsed.epic, null);
    assert.equal(sessionEpic(parsed, db.listTasks(), epics).id, second.id);
    db.updateTask(db.createTask(project.id, 'Ambiguë', null, first.id).id, { sessionId: session.id });
    assert.equal(sessionEpic(parsed, db.listTasks(), epics), null);
    assert.equal(sessionEpic(parsed, [{ ...task, sourceSessionId: session.id, sessionId: null }], epics), null);
  } finally { db.close(); }
});

test('grouped titles remove only generated epic prefixes and preserve personal titles', () => {
  const session = { prompt: '[CEREBRO_EPIC_STEP run task]\nÉtape', title: 'Epic « Livraison » · étape 2/3 : Vérifier' };
  assert.equal(groupedSessionTitle(session), 'étape 2/3 : Vérifier');
  assert.equal(groupedSessionTitle({ ...session, title: 'Mon titre' }), 'Mon titre');
  assert.equal(groupedSessionTitle({ ...session, prompt: 'Demande libre' }), session.title);
});
