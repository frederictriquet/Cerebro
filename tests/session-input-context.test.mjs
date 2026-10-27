import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-input-context-'));
process.env.CEREBRO_DATA_DIR = root;
const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { importFindings, saveReport } = await import('../server/findings.ts');
const { createServices } = await import('../server/services.ts');
after(() => rmSync(root, { recursive: true, force: true }));

const finding = (id) => ({
  id,
  title: `Bug ${id}`,
  severity: 'high',
  file: 'file.ts',
  line: 1,
  problem: 'Valeur incorrecte',
  scenario: 'Entrée vide',
  expectedFix: 'Valider la valeur',
});
const createSession = (db, project, status) =>
  db.createSession(
    {
      id: randomUUID(),
      projectId: project.id,
      agent: 'codex',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: 'Saisie',
      status,
      agentSessionId: 'fake',
    },
    'token',
  );

/** Counts the statements the database prepares while `run` executes. */
function countQueries(db, run) {
  const prepare = db.connection.prepare;
  let count = 0;
  db.connection.prepare = function (...args) {
    count += 1;
    return prepare.apply(this, args);
  };
  try {
    run();
  } finally {
    db.connection.prepare = prepare;
  }
  return count;
}

function attachRuntime(manager, id) {
  const written = [];
  const runtime = manager.newRuntime('codex');
  runtime.socket = {
    destroyed: false,
    writable: true,
    write: (line) => {
      written.push(JSON.parse(line));
      return true;
    },
    destroy() {},
  };
  manager.runtimes.set(id, runtime);
  return { runtime, written, detach: () => manager.detachRuntime(id, runtime) };
}

test('keystrokes reach the holder without reading the database, Enter still resumes the session', () => {
  const db = new CerebroDatabase(':memory:');
  const project = db.createProject('Demo', root);
  const session = createSession(db, project, 'waiting');
  const manager = new SessionManager(db, createServices(db));
  const { written, detach } = attachRuntime(manager, session.id);
  try {
    assert.equal(manager.writeInput(session.id, 'a'), true);
    assert.equal(
      countQueries(db, () => {
        for (const key of 'bonjour') assert.equal(manager.writeInput(session.id, key), true);
      }),
      0,
    );
    assert.deepEqual(written.map((message) => message.data).join(''), 'abonjour');
    assert.equal(db.getSession(session.id).status, 'waiting');
    assert.equal(manager.writeInput(session.id, '\r'), true);
    assert.equal(db.getSession(session.id).status, 'running');
  } finally {
    detach();
    db.close();
  }
});

test('input stays deferred while the workspace is locked, including after the cached context is invalidated', () => {
  const db = new CerebroDatabase(':memory:');
  const first = join(root, 'first');
  const moved = join(root, 'moved');
  mkdirSync(first);
  mkdirSync(moved);
  const project = db.createProject('Partagé', first);
  const session = createSession(db, project, 'running');
  const services = createServices(db);
  const manager = new SessionManager(db, services);
  const { written, detach } = attachRuntime(manager, session.id);
  try {
    manager.writeInput(session.id, 'x');
    let release = services.gate.lock([first]);
    assert.equal(manager.writeInput(session.id, 'y'), true);
    assert.equal(written.length, 1, 'input is held while the project directory is locked');
    release();
    assert.deepEqual(
      written.map((message) => message.data),
      ['x', 'y'],
    );

    // The project moves: the next keystroke must be gated on the new directory.
    db.updateProject(project.id, { path: moved });
    manager.forgetInputContexts();
    release = services.gate.lock([moved]);
    manager.writeInput(session.id, 'z');
    assert.equal(written.length, 2);
    release();
    assert.deepEqual(
      written.map((message) => message.data),
      ['x', 'y', 'z'],
    );

    // A session event also drops the cached context.
    manager.rename(session.id, 'Renommée');
    assert.equal(countQueries(db, () => manager.writeInput(session.id, 'w')) > 0, true);
  } finally {
    detach();
    db.close();
  }
});

test('pending findings are counted from the stored report size, including reports saved before the column existed', () => {
  const path = join(root, 'legacy.db');
  let db = new CerebroDatabase(path);
  const project = db.createProject('Demo', root);
  const session = createSession(db, project, 'exited');
  const report = saveReport(db, session.id, { title: 'Review', findings: [finding('a'), finding('b')] });
  // A report written by a version without the column: the next start backfills it.
  db.connection.exec('ALTER TABLE review_reports DROP COLUMN finding_count');
  db.connection
    .prepare('INSERT INTO review_reports (id,session_id,digest,data,created_at) VALUES (?,?,?,?,?)')
    .run(
      randomUUID(),
      session.id,
      'legacy',
      JSON.stringify({ title: 'Ancien', findings: [finding('c'), finding('d'), finding('e')] }),
      Date.now(),
    );
  db.close();
  db = new CerebroDatabase(path);
  try {
    assert.equal(db.getSession(session.id).pendingFindings, 5);
    importFindings(db, session.id, report.id, ['a']);
    assert.equal(db.getSession(session.id).pendingFindings, 4);
    assert.equal(db.listSessions().find((item) => item.id === session.id).pendingFindings, 4);
    assert.equal(
      countQueries(db, () => db.getSession(session.id)),
      1,
    );
  } finally {
    db.close();
  }
});
