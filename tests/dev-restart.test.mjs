import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attachDevRestartChannel } from '../server/dev-restart.ts';
import { GitPulls } from '../server/git-pull.ts';
import { GitPushes } from '../server/git-push.ts';
import { WorktreeGate } from '../server/worktree-gate.ts';

function fakeEndpoint() {
  const bus = new EventEmitter();
  const sent = [];
  bus.send = (payload) => {
    sent.push(payload);
    return true;
  };
  return { bus, sent };
}

test('attachDevRestartChannel acknowledges immediately when idle and defers until Git operations finish when busy', async () => {
  const gate = new WorktreeGate();
  const { bus, sent } = fakeEndpoint();
  const detach = attachDevRestartChannel(
    bus,
    {
      isBusy: () => gate.busy,
      waitForIdle: () => gate.waitForIdle(),
    },
    20,
  );

  try {
    bus.emit('message', { type: 'prepare-restart' });
    assert.deepEqual(sent, [{ type: 'restart-ack', busy: false }]);
    sent.length = 0;

    const release = gate.lock(['/tmp/cerebro-dev-restart-test']);
    bus.emit('message', { type: 'prepare-restart' });
    bus.emit('message', { type: 'prepare-restart' });
    assert.deepEqual(sent, [
      { type: 'restart-ack', busy: true },
      { type: 'restart-ack', busy: true },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(
      sent.some((msg) => msg.type === 'restart-ready'),
      false,
      'must not signal restart-ready while lease is still held',
    );

    release();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(sent, [
      { type: 'restart-ack', busy: true },
      { type: 'restart-ack', busy: true },
      { type: 'restart-ready' },
    ]);
  } finally {
    detach();
  }
});

test('GitPushes.shutdown and GitPulls.shutdown wait for in-flight operations to finish', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cerebro-git-shutdown-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  g(repo, 'init', '-b', 'main');
  g(repo, 'config', 'user.email', 'test@example.com');
  g(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'a.txt'), 'v1\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-m', 'init');
  g(repo, 'remote', 'add', 'origin', origin);

  const gate = new WorktreeGate();
  const pushes = new GitPushes(gate);
  const pulls = new GitPulls(gate, pushes);

  const pushOp = await pushes.start(repo);
  assert.equal(pushes.busy, true);
  await pushes.shutdown();
  assert.equal(pushes.busy, false);
  assert.equal(pushOp.status, 'succeeded');

  const pullOp = await pulls.start(repo);
  await pulls.shutdown();
  assert.equal(pulls.busy, false);
  assert.equal(pullOp.status, 'succeeded');
});
