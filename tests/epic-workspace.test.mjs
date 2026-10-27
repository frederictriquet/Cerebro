import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-epic-workspace-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
mkdirSync(process.env.CEREBRO_DATA_DIR);
const { CerebroDatabase } = await import('../server/db.ts');
const { EpicWorkspaces } = await import('../server/epic-workspace.ts');
const { WorktreeGate } = await import('../server/worktree-gate.ts');
after(() => rmSync(root, { recursive: true, force: true }));

const version = (db) =>
  db.connection.prepare("SELECT version FROM table_versions WHERE name='session_workspaces'").get().version;
const saveWorkspace = (db, sessionId, path) =>
  db.connection
    .prepare(
      'INSERT INTO session_workspaces (session_id,data) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data',
    )
    .run(sessionId, JSON.stringify({ mode: 'isolated', path }));
// A legacy run that only knows its folder: the epic's workspace is found in the provenance inventory.
const legacyRun = (db, project, contextRoot) => {
  const epic = db.createEpic(project.id, 'Epic', '', null);
  const run = { contextRoot, sessionId: null, commandRunId: null, status: 'running', results: {} };
  db.connection.prepare('INSERT INTO epic_runs VALUES (?,?,?)').run(randomUUID(), epic.id, JSON.stringify(run));
  return epic;
};

test('every write to session_workspaces bumps its version', () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const start = version(db);
    saveWorkspace(db, 's1', join(root, 'a'));
    assert.equal(version(db), start + 1);
    saveWorkspace(db, 's1', join(root, 'b'));
    assert.equal(version(db), start + 2);
    db.connection.prepare('DELETE FROM session_workspaces').run();
    assert.equal(version(db), start + 3);
  } finally {
    db.close();
  }
});

test('the provenance inventory sees a row updated in place, although row count and last rowid are unchanged', () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Demo', join(root, 'project'));
    const before = join(root, 'copy-before');
    const after = join(root, 'copy-after');
    saveWorkspace(db, 's1', before);
    const workspaces = new EpicWorkspaces(db, new WorktreeGate());
    // Warm the inventory cache.
    assert.deepEqual(workspaces.current(legacyRun(db, project, before).id), { mode: 'isolated', path: before });
    saveWorkspace(db, 's1', after);
    assert.deepEqual(workspaces.current(legacyRun(db, project, after).id), { mode: 'isolated', path: after });
  } finally {
    db.close();
  }
});

test('preparations are serialized per epic within one instance only', async () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const first = new EpicWorkspaces(db, new WorktreeGate());
    const second = new EpicWorkspaces(db, new WorktreeGate());
    const order = [];
    let release;
    const held = first.withPreparation('epic', () => new Promise((resolve) => (release = resolve)));
    const queued = first.withPreparation('epic', async () => order.push('queued'));
    await second.withPreparation('epic', async () => order.push('other instance'));
    assert.deepEqual(order, ['other instance']);
    release();
    await Promise.all([held, queued]);
    assert.deepEqual(order, ['other instance', 'queued']);
  } finally {
    db.close();
  }
});
