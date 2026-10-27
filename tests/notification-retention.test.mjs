import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-notification-retention-'));
process.env.CEREBRO_DATA_DIR = root;
const { CerebroDatabase } = await import('../server/db.ts');
const { OperationResults } = await import('../server/operation-results.ts');
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function session(db, projectId) {
  const id = `session-${++counter}`;
  db.createSession({ id, projectId, agent: 'claude', mode: 'default', model: null, effort: null, prompt: '', title: id, status: 'running', agentSessionId: null }, 'token');
  return id;
}
const turns = db => db.connection.prepare('SELECT session_id FROM notification_turns ORDER BY session_id').all().map(row => row.session_id);
const turn = (db, id) => db.connection.prepare('INSERT INTO notification_turns (session_id, started_at) VALUES (?, ?)').run(id, Date.now());
function result(results, projectId, finishedAt) {
  const id = `push:${++counter}`;
  results.record({ id, projectId, sessionId: null, kind: 'push', ok: true, summary: 'origin : ok', startedAt: finishedAt - 1000, finishedAt });
  return id;
}

test('deleting a session or its project removes its notification turn', () => {
  const db = new CerebroDatabase(join(root, 'cascade.db'));
  try {
    const project = db.createProject('p', root);
    const kept = session(db, project.id), deleted = session(db, project.id);
    turn(db, kept); turn(db, deleted);
    assert.equal(db.deleteSession(deleted), true);
    assert.deepEqual(turns(db), [kept]);
    assert.equal(db.deleteProject(project.id), true);
    assert.deepEqual(turns(db), []);
  } finally { db.close(); }
});

test('legacy notification_turns gains the foreign key and loses its orphan rows', () => {
  const path = join(root, 'legacy.db');
  const first = new CerebroDatabase(path);
  const project = first.createProject('p', root);
  const live = session(first, project.id);
  first.close();
  // Schéma d'avant la migration : aucune clé étrangère, une ligne pour une session déjà supprimée.
  const raw = new DatabaseSync(path);
  raw.exec(`DROP TABLE notification_turns;
    CREATE TABLE notification_turns (session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, custom_at INTEGER, relayed_at INTEGER, automatic_at INTEGER, automatic_status TEXT);
    INSERT INTO notification_turns VALUES ('${live}', 1, 2, 3, 4, 5, 'waiting'), ('gone', 1, NULL, NULL, NULL, NULL, NULL);`);
  raw.close();

  const db = new CerebroDatabase(path);
  try {
    assert.deepEqual(db.connection.prepare('SELECT * FROM notification_turns').all().map(row => ({ ...row })),
      [{ session_id: live, started_at: 1, ended_at: 2, custom_at: 3, relayed_at: 4, automatic_at: 5, automatic_status: 'waiting' }]);
    const [fk] = db.connection.prepare('PRAGMA foreign_key_list(notification_turns)').all();
    assert.equal(fk.table, 'sessions');
    assert.equal(fk.on_delete, 'CASCADE');
    assert.throws(() => turn(db, 'unknown'), /FOREIGN KEY/);
    db.deleteSession(live);
    assert.deepEqual(turns(db), []);
  } finally { db.close(); }
  // Migration idempotente : la réouverture ne reconstruit rien et ne perd rien.
  const again = new CerebroDatabase(path);
  try { assert.equal(again.connection.prepare('PRAGMA foreign_key_list(notification_turns)').all().length, 1); } finally { again.close(); }
});

test('operation results expire after the retention period and with their project', () => {
  const db = new CerebroDatabase(join(root, 'operations.db'));
  try {
    const results = new OperationResults(db);
    const project = db.createProject('p', root), other = db.createProject('q', root);
    const old = result(results, other.id, Date.now() - 31 * 86_400_000);
    const recent = result(results, other.id, Date.now() - 29 * 86_400_000);
    const owned = result(results, project.id, Date.now());
    const global = result(results, null, Date.now());
    // Chaque enregistrement purge l'historique échu, y compris le résultat déjà trop ancien à l'arrivée.
    assert.equal(results.get(old), null);
    results.restore();
    assert.deepEqual(results.list().map(r => r.id).sort(), [global, owned, recent].sort());
    results.purge(Date.now() + 2 * 86_400_000);
    assert.deepEqual(results.list().map(r => r.id).sort(), [global, owned].sort());
    db.deleteProject(project.id);
    assert.deepEqual(results.list().map(r => r.id), [global]);
    results.close();
  } finally { db.close(); }
});
