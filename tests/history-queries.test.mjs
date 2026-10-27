import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-history-'));
process.env.CEREBRO_DATA_DIR = root;
const { CerebroDatabase } = await import('../server/db.ts');
const { CommandExecutor } = await import('../server/commands.ts');
const { WorktreeGate } = await import('../server/worktree-gate.ts');
const { OperationResults } = await import('../server/operation-results.ts');
after(() => rmSync(root, { recursive: true, force: true }));
const DAY = 86_400_000;
// Relève les requêtes préparées : aucune lecture ciblée ne doit parcourir toute la table.
function spy(db) {
  const seen = [];
  const prepare = db.connection.prepare.bind(db.connection);
  db.connection.prepare = (sql) => {
    seen.push(sql);
    return prepare(sql);
  };
  return {
    seen,
    restore: () => {
      db.connection.prepare = prepare;
    },
  };
}
const plan = (db, sql, ...args) =>
  db.connection
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((r) => r.detail)
    .join(' ; ');
const insertRun = (db, run) =>
  db.connection.prepare('INSERT INTO command_runs VALUES (?,?,?)').run(run.id, run.taskId, JSON.stringify(run));

test('operation results are read by id and purged after the retention period', async () => {
  const db = new CerebroDatabase(':memory:');
  const results = new OperationResults(db);
  results.wanted = () => true;
  results.delay = () => 60_000;
  const now = Date.now();
  const base = { projectId: 'p', sessionId: null, kind: 'command', ok: true, summary: 'ok', startedAt: now - 1000 };
  for (let i = 0; i < 50; i++) results.record({ ...base, id: `old-${i}`, finishedAt: now - 40 * DAY });
  results.record({ ...base, id: 'recent', finishedAt: now });
  results.record({ ...base, id: 'other', projectId: 'q', finishedAt: now });
  const { seen, restore } = spy(db);
  try {
    results.record({ ...base, id: 'recent', finishedAt: now });
    results.get('recent');
    results.seen('recent');
    await results.deliver('recent');
    assert.ok(seen.length > 0);
    for (const sql of seen.filter((sql) => /operation_results/.test(sql) && /^SELECT/.test(sql)))
      assert.match(sql, /WHERE id=\?/, `requête non ciblée : ${sql}`);
  } finally {
    restore();
    results.close();
  }
  assert.match(
    plan(db, 'SELECT data FROM operation_results WHERE id=?', 'recent'),
    /USING INDEX sqlite_autoindex_operation_results_1/,
  );
  assert.match(
    plan(db, 'SELECT data FROM operation_results WHERE finished_at<?', now),
    /USING INDEX operation_results_finished_at/,
  );
  assert.deepEqual(
    results.list('q').map((r) => r.id),
    ['other'],
  );
  assert.deepEqual(
    results
      .since(now - DAY)
      .map((r) => r.id)
      .sort(),
    ['other', 'recent'],
  );
  assert.equal(results.purge(now - 30 * DAY), 50);
  assert.equal(results.get('old-0'), null);
  assert.ok(results.get('recent'));
  assert.equal(results.list().length, 2);
  db.close();
});

test('command activity uses the indexed status column without reading run output', () => {
  const db = new CerebroDatabase(':memory:');
  const executor = new CommandExecutor(db, new WorktreeGate());
  const now = Date.now();
  const output = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 20; i++)
    insertRun(db, {
      id: `old-${i}`,
      taskId: 'done-task',
      status: 'succeeded',
      output,
      startedAt: now - 40 * DAY,
      finishedAt: now - 40 * DAY,
    });
  insertRun(db, {
    id: 'recent',
    taskId: 'done-task',
    status: 'failed',
    output,
    startedAt: now - DAY,
    finishedAt: now - DAY,
  });
  insertRun(db, {
    id: 'live',
    taskId: 'busy-task',
    status: 'running',
    output,
    startedAt: now - 40 * DAY,
    finishedAt: null,
  });
  const { seen, restore } = spy(db);
  try {
    assert.equal(executor.active('busy-task'), true);
    assert.equal(executor.active('done-task'), false);
    assert.deepEqual([...executor.activeTaskIds()], ['busy-task']);
    assert.deepEqual(
      executor.runningRuns().map((r) => r.id),
      ['live'],
    );
    assert.equal(executor.getRun('recent').status, 'failed');
  } finally {
    restore();
  }
  for (const sql of seen) assert.match(sql, /WHERE (status='running'|id=\?)/, `requête non ciblée : ${sql}`);
  assert.ok(
    seen.filter((sql) => /SELECT 1|DISTINCT task_id/.test(sql)).every((sql) => !/\bdata\b/.test(sql)),
    'active() ne relit pas le JSON des runs',
  );
  assert.match(
    plan(db, "SELECT 1 FROM command_runs WHERE status='running' AND task_id=? LIMIT 1", 'busy-task'),
    /USING INDEX command_runs_(status|task_id)/,
  );
  assert.match(plan(db, "SELECT data FROM command_runs WHERE status='running'"), /USING INDEX command_runs_status/);
  // Un run en cours n’est jamais purgé, quel que soit son âge.
  assert.equal(executor.purge(now - 30 * DAY), 20);
  assert.deepEqual(
    executor
      .listRuns()
      .map((r) => r.id)
      .sort(),
    ['live', 'recent'],
  );
  db.close();
});

test('an existing database gains the indexed columns and keeps its rows', () => {
  const file = join(root, 'legacy.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(
    'CREATE TABLE operation_results (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE command_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);',
  );
  legacy
    .prepare('INSERT INTO operation_results VALUES (?,?)')
    .run('op', JSON.stringify({ id: 'op', projectId: 'p', finishedAt: 1 }));
  legacy
    .prepare('INSERT INTO command_runs VALUES (?,?,?)')
    .run('run', 'task', JSON.stringify({ id: 'run', taskId: 'task', status: 'running', finishedAt: null }));
  legacy.close();
  const db = new CerebroDatabase(file);
  assert.deepEqual(
    { ...db.connection.prepare('SELECT project_id,finished_at FROM operation_results').get() },
    { project_id: 'p', finished_at: 1 },
  );
  assert.equal(new CommandExecutor(db, new WorktreeGate()).active('task'), true);
  db.close();
  // Réouverture : la migration est idempotente.
  new CerebroDatabase(file).close();
});
