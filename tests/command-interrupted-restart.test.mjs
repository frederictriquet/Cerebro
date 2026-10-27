import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-command-restart-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;

// config.ts n'écrit rien à l'import : les dossiers de données sont créés explicitement.
(await import('../server/config.ts')).ensureDataDirs();
const { CerebroDatabase } = await import('../server/db.ts');
const { CommandExecutor } = await import('../server/commands.ts');
const { WorktreeGate } = await import('../server/worktree-gate.ts');
const { PeerSync } = await import('../server/peers.ts');
const { UpdateManager } = await import('../server/updates.ts');
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

test('a command left running by the previous server is recorded as an interrupted operation on restart', async () => {
  const db = new CerebroDatabase();
  const project = db.createProject('Demo', root);
  const command = new CommandExecutor(db, new WorktreeGate()).configure(project.id, {
    name: 'Build',
    executable: process.execPath,
    args: ['-e', ''],
    cwd: '.',
    timeoutSeconds: 10,
  });
  const task = db.createTask(project.id, 'build', null, null, {
    type: 'command',
    commandId: command.id,
    completion: 'manual',
  });
  const run = {
    id: 'left-running',
    taskId: task.id,
    pid: null,
    command,
    cwd: root,
    status: 'running',
    output: '',
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    error: null,
  };
  db.connection.prepare('INSERT INTO command_runs VALUES (?,?,?)').run(run.id, task.id, JSON.stringify(run));
  db.close();

  const app = await buildServer();
  try {
    const operation = (await app.inject({ method: 'GET', url: `/api/operations?projectId=${project.id}` }))
      .json()
      .find((entry) => entry.id === run.id);
    assert.ok(operation, 'the interrupted run must reach operations (and thus Slack notifications)');
    assert.equal(operation.kind, 'command');
    assert.equal(operation.ok, false);
    assert.match(operation.summary, /interrupted/);
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/runs` })).json()[0].status,
      'interrupted',
    );
  } finally {
    await app.close();
  }
});
