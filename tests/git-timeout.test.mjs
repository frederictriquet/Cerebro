import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-git-timeout-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CEREBRO_GIT_TIMEOUT_READ = '10';
process.env.CEREBRO_GIT_TIMEOUT_WRITE = '1';
process.env.CEREBRO_GIT_TIMEOUT_NETWORK = '1';
const { gitKind, runGit, GitTimeoutError } = await import('../server/git-process.ts');
const { GitPlanner } = await import('../server/git-plan.ts');
const { GitPushes } = await import('../server/git-push.ts');
const { WorktreeGate } = await import('../server/worktree-gate.ts');
const { CerebroDatabase } = await import('../server/db.ts');
const { AutomaticCommits } = await import('../server/automatic-commits.ts');
const { createWorkspace } = await import('../server/provenance.ts');
const { WorktreeManager } = await import('../server/worktrees.ts');
const { createServices } = await import('../server/services.ts');
const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
after(() => rmSync(root, { recursive: true, force: true }));
function repository() {
  const repo = join(mkdtempSync(join(root, 'case-')), 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  return repo;
}
/** A hook that records its pid and outlives every timeout of this file. */
function hangingHook(repo, name) {
  const marker = join(repo, `${name}.pid`);
  const hook = join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'hooks', name);
  writeFileSync(hook, `#!/bin/sh\necho $$ > '${marker}'\nexec sleep 60\n`);
  chmodSync(hook, 0o755);
  return marker;
}
async function assertKilled(marker) {
  assert.ok(existsSync(marker), 'the hook should have started');
  const pid = Number(readFileSync(marker, 'utf8'));
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch (cause) {
      if (cause.code === 'ESRCH') return;
      throw cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`hook ${pid} still alive`);
}
const elapsed = async (run) => {
  const start = Date.now();
  const value = await run();
  return { value, seconds: (Date.now() - start) / 1000 };
};

test('the timeout depends on the subcommand, past global options', () => {
  assert.equal(gitKind(['-C', '/x', '-c', 'core.quotePath=false', 'status']), 'read');
  assert.equal(gitKind(['-C', '/x', 'commit', '--file=-']), 'write');
  assert.equal(gitKind(['-C', '/x', 'merge', '--no-edit']), 'write');
  assert.equal(gitKind(['-C', '/x', 'push', '--porcelain']), 'network');
  assert.equal(gitKind(['-C', 'commit', 'log']), 'read');
});

test('a hanging pre-commit hook is killed with its process group and reported', async () => {
  const repo = repository();
  writeFileSync(join(repo, 'file'), 'changed\n');
  const marker = hangingHook(repo, 'pre-commit');
  const gate = new WorktreeGate();
  const planner = new GitPlanner(gate, new GitPushes(gate));
  const snapshot = await planner.prepareCommit(repo);
  const { value, seconds } = await elapsed(() =>
    planner.executeCommitPlan(repo, {
      snapshotId: snapshot.id,
      push: false,
      acknowledged: [],
      commits: [{ message: 'change', selection: [{ path: 'file', all: true }] }],
    }),
  );
  assert.match(value.error, /Opération Git interrompue après 1 s \(git commit\)/);
  assert.ok(seconds < 8, `${seconds} s`);
  await assertKilled(marker);
  assert.equal(git(repo, 'log', '--format=%s'), 'base');
  assert.equal(existsSync(join(repo, '.git', 'index.lock')), false);
});

test('a hanging pre-push hook fails the remote instead of keeping the push running', async () => {
  const repo = repository();
  const remote = join(repo, '..', 'remote');
  mkdirSync(remote);
  git(remote, 'init', '--bare');
  git(repo, 'remote', 'add', 'origin', remote);
  const marker = hangingHook(repo, 'pre-push');
  const { value: operation, seconds } = await elapsed(async () => {
    const op = await new GitPushes(new WorktreeGate()).start(repo);
    while (op.status === 'running') await new Promise((resolve) => setTimeout(resolve, 20));
    return op;
  });
  assert.equal(operation.status, 'failed');
  assert.match(operation.remotes[0].output, /Opération Git interrompue après 1 s \(git push\)/);
  assert.ok(seconds < 8, `${seconds} s`);
  await assertKilled(marker);
});

test('an output-holding descendant cannot keep the timeout from settling', async () => {
  const repo = repository();
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  // setsid leaves the group: only git's own exit can settle the run.
  const escaped = join(repo, 'escaped.pid');
  writeFileSync(hook, `#!/bin/sh\nsetsid sleep 60 &\necho $! > '${escaped}'\nexec sleep 60\n`);
  chmodSync(hook, 0o755);
  try {
    const { value: failure, seconds } = await elapsed(() =>
      runGit(['-C', repo, 'commit', '--allow-empty', '-m', 'x']).then(
        () => null,
        (cause) => cause,
      ),
    );
    assert.ok(failure instanceof GitTimeoutError, String(failure));
    assert.ok(seconds < 8, `${seconds} s`);
  } finally {
    try {
      process.kill(Number(readFileSync(escaped, 'utf8')), 'SIGKILL');
    } catch {}
  }
});

test('an automatic commit blocked by a hook fails and lets shutdown finish', async () => {
  const repo = repository();
  writeFileSync(join(repo, 'file'), 'changed\n');
  const marker = hangingHook(repo, 'pre-commit');
  const db = new CerebroDatabase(join(repo, '..', 'db.sqlite'));
  const project = db.createProject('Project', repo);
  const manager = new AutomaticCommits(db, createServices(db));
  manager.proposeCommits = async (input) => ({
    commits: [{ message: 'feat: change', paths: input.files.map((file) => file.path) }],
  });
  try {
    const settings = { agent: 'codex', model: 'test-model', effort: 'low', strategy: 'single' };
    const operation = await manager.start(
      { scope: `projects/${project.id}`, path: repo, projectId: project.id, sessionId: null, settings },
      randomUUID(),
      false,
    );
    let current = operation;
    for (let i = 0; i < 400 && current.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      current = manager.get(operation.id);
    }
    assert.equal(current.status, 'failed');
    assert.match(current.error, /Opération Git interrompue après 1 s/);
    await assertKilled(marker);
    const { seconds } = await elapsed(() => manager.shutdown());
    assert.ok(seconds < 2, `${seconds} s`);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('a hanging hook during a worktree merge releases the worktree lease', async () => {
  const repo = repository();
  const db = new CerebroDatabase(join(repo, '..', 'db.sqlite'));
  const project = db.createProject('Project', repo);
  const id = randomUUID();
  db.createSession(
    {
      id,
      projectId: project.id,
      agent: 'codex',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: 'Conversation',
      status: 'exited',
      agentSessionId: 'fake',
    },
    'token',
  );
  const workspace = await createWorkspace(db, id, project);
  const services = createServices(db);
  const manager = new WorktreeManager(db, services);
  try {
    writeFileSync(join(workspace.path, 'file'), 'session work\n');
    git(workspace.path, 'commit', '-am', 'session work');
    const view = (await manager.list(project.id)).worktrees.find((w) => w.sessionId === id);
    const plan = await manager.prepareAction(view.id, 'merge');
    // Every ref update of the merge goes through this hook, fast-forward included.
    const marker = hangingHook(repo, 'reference-transaction');
    const { value: operation, seconds } = await elapsed(async () => {
      const started = await manager.start(view.id, 'merge', plan.token);
      for (let i = 0; i < 400; i++) {
        const current = await manager.get(started.worktreeId);
        if (current.operation?.id === started.id && current.operation.status !== 'running') return current.operation;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('merge still running');
    });
    assert.equal(operation.status, 'failed');
    assert.match(operation.error, /Opération Git interrompue après 1 s/);
    assert.ok(seconds < 8, `${seconds} s`);
    await assertKilled(marker);
    assert.doesNotThrow(() => services.gate.assertAvailable(view.path));
    assert.doesNotThrow(() => services.gate.assertAvailable(repo));
    const { seconds: stopping } = await elapsed(() => manager.shutdown());
    assert.ok(stopping < 2, `${stopping} s`);
  } finally {
    await manager.shutdown();
    db.close();
  }
});
