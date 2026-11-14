import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitPushes } from '../server/git-push.ts';
import { WorktreeGate } from '../server/worktree-gate.ts';

const pushes = new GitPushes(new WorktreeGate());

const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'cerebro-push-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file'), 'original\n');
  git(repo, 'add', 'file');
  git(repo, 'commit', '-m', 'initial');
  const remote = (name) => {
    const path = join(root, name);
    mkdirSync(path);
    git(path, 'init', '--bare');
    git(repo, 'remote', 'add', name, path);
    return path;
  };
  try {
    await run({ repo, remote });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
async function wait(op) {
  while (op.finishedAt === null) await new Promise((resolve) => setTimeout(resolve, 10));
  return op;
}
const integrity = (repo) => ({
  head: git(repo, 'rev-parse', 'HEAD'),
  index: readFileSync(join(repo, '.git/index')).toString('hex'),
  file: readFileSync(join(repo, 'file'), 'utf8'),
});

test('push sets origin upstream, publishes each remote, preserves HEAD, index and worktree', async () =>
  fixture(async ({ repo, remote }) => {
    const origin = remote('origin');
    const backup = remote('backup');
    const before = integrity(repo);
    const op = await wait(await pushes.start(repo));
    assert.equal(op.status, 'succeeded', JSON.stringify(op));
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main');
    for (const path of [origin, backup]) assert.equal(git(path, 'rev-parse', 'main'), before.head);
    assert.deepEqual(integrity(repo), before);
    git(repo, 'config', 'push.default', 'nothing');
    assert.equal((await wait(await pushes.start(repo))).status, 'succeeded');
  }));

test('sole remote becomes upstream; ambiguous remotes and missing remotes are explicit failures', async () =>
  fixture(async ({ repo, remote }) => {
    assert.match((await wait(await pushes.start(repo))).error, /Aucun remote/);
    const one = remote('one');
    assert.equal((await wait(await pushes.start(repo))).status, 'succeeded');
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'one/main');
    git(repo, 'branch', '--unset-upstream');
    remote('two');
    const op = await wait(await pushes.start(repo));
    assert.match(op.error, /Plusieurs remotes/);
    assert.deepEqual(op.remotes, []);
    assert.equal(git(one, 'rev-parse', 'main'), git(repo, 'rev-parse', 'HEAD'));
  }));

test('rejected remote does not prevent the next remote; hooks remain enabled', async () =>
  fixture(async ({ repo, remote }) => {
    const rejected = remote('aaa');
    const origin = remote('origin');
    writeFileSync(join(rejected, 'hooks/pre-receive'), '#!/bin/sh\necho rejected >&2\nexit 1\n', { mode: 0o755 });
    const before = integrity(repo);
    let op = await wait(await pushes.start(repo));
    assert.deepEqual(
      op.remotes.map((r) => [r.remote, r.status]),
      [
        ['aaa', 'failed'],
        ['origin', 'succeeded'],
      ],
    );
    assert.equal(git(origin, 'rev-parse', 'main'), before.head);
    writeFileSync(join(repo, '.git/hooks/pre-push'), '#!/bin/sh\necho hook-failed >&2\nexit 1\n', { mode: 0o755 });
    op = await wait(await pushes.start(repo));
    assert.ok(op.remotes.every((r) => r.status === 'failed' && r.output.includes('hook-failed')));
    assert.deepEqual(integrity(repo), before);
  }));

test('concurrent starts share operation; real dirty state is rejected without index mutations', async () =>
  fixture(async ({ repo, remote }) => {
    remote('origin');
    const [a, b] = await Promise.all([pushes.start(repo), pushes.start(repo)]);
    assert.equal(a.id, b.id);
    await wait(a);
    writeFileSync(join(repo, 'file'), 'changed\n');
    git(repo, 'add', 'file');
    const before = integrity(repo);
    const op = await wait(await pushes.start(repo));
    assert.match(op.error, /changements/);
    assert.deepEqual(integrity(repo), before);
    // The header « Push » button only sends existing commits and leaves uncommitted files alone.
    const allowed = await wait(await pushes.start(repo, { allowDirty: true }));
    assert.equal(allowed.status, 'succeeded', JSON.stringify(allowed));
    assert.deepEqual(integrity(repo), before);
  }));

test('detached HEAD fails with the explicit message instead of the raw git error', async () =>
  fixture(async ({ repo, remote }) => {
    const origin = remote('origin');
    git(repo, 'checkout', '--detach');
    const op = await wait(await pushes.start(repo));
    assert.equal(op.status, 'failed');
    assert.equal(op.error, 'HEAD détachée : choisissez une branche.');
    assert.deepEqual(op.remotes, []);
    assert.throws(() => git(origin, 'rev-parse', '--verify', 'main'));
  }));

test('dirty check survives a status larger than the former 1 MiB buffer', async () =>
  fixture(async ({ repo, remote }) => {
    remote('origin');
    const dir = join(repo, 'untracked');
    mkdirSync(dir);
    for (let i = 0; i < 6000; i++) writeFileSync(join(dir, `${String(i).padStart(6, '0')}-${'x'.repeat(200)}`), '');
    git(repo, 'config', 'status.showUntrackedFiles', 'all');
    assert.ok(
      execFileSync('git', ['-C', repo, 'status', '--porcelain=v1', '-z'], { maxBuffer: 16 * 1024 * 1024 }).length >
        1024 * 1024,
    );
    const op = await wait(await pushes.start(repo));
    assert.equal(op.status, 'failed');
    assert.match(op.error, /préparez un commit/);
    assert.equal((await wait(await pushes.start(repo, { allowDirty: true }))).status, 'succeeded');
  }));

test('a throwing completion listener is logged and does not stop the next listeners', async () =>
  fixture(async ({ repo, remote }) => {
    remote('origin');
    const unhandled = [];
    const onUnhandled = (cause) => unhandled.push(cause);
    process.on('unhandledRejection', onUnhandled);
    const logged = [];
    const error = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    const calls = [];
    const offFailing = pushes.onComplete(() => {
      throw new Error('listener cassé');
    });
    const offNext = pushes.onComplete((path, op) => calls.push(op.id));
    try {
      const op = await wait(await pushes.start(repo));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(op.status, 'succeeded', JSON.stringify(op));
      assert.deepEqual(calls, [op.id]);
      assert.deepEqual(unhandled, []);
      assert.ok(
        logged.some((line) => /listener cassé/.test(line)),
        logged.join('\n'),
      );
    } finally {
      offFailing();
      offNext();
      console.error = error;
      process.off('unhandledRejection', onUnhandled);
    }
  }));

test('non-fast-forward push automatically rebases onto upstream, resolves conflicts via AI, and preserves uncommitted edits', async () =>
  fixture(async ({ repo, remote }) => {
    const origin = remote('origin');
    const backup = remote('backup');
    const localPushes = new GitPushes(new WorktreeGate());
    assert.equal((await wait(await localPushes.start(repo))).status, 'succeeded');

    // Peer clone pushes a commit to origin while repo creates a local commit + keeps an uncommitted edit.
    const peer = mkdtempSync(join(tmpdir(), 'cerebro-push-peer-'));
    try {
      execFileSync('git', ['clone', '-b', 'main', origin, peer], { stdio: 'ignore' });
      git(peer, 'config', 'user.email', 'peer@example.com');
      git(peer, 'config', 'user.name', 'Peer');
      writeFileSync(join(peer, 'remote-feature.txt'), 'from-peer\n');
      git(peer, 'add', 'remote-feature.txt');
      git(peer, 'commit', '-m', 'peer commit');
      const peerTip = git(peer, 'rev-parse', 'HEAD');
      git(peer, 'push', 'origin', 'main');

      writeFileSync(join(repo, 'local-feature.txt'), 'from-local\n');
      git(repo, 'add', 'local-feature.txt');
      git(repo, 'commit', '-m', 'local commit');
      const beforeHead = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, 'file'), 'brouillon non commité\n');

      // 1. Clean divergence + allowDirty: rebases onto origin/main, keeps dirty `file`, and publishes to both remotes.
      const cleanOp = await wait(await localPushes.start(repo, { allowDirty: true }));
      assert.equal(cleanOp.status, 'succeeded', JSON.stringify(cleanOp));
      assert.equal(cleanOp.rebasedFrom, beforeHead);
      assert.notEqual(cleanOp.head, beforeHead);
      assert.equal(git(repo, 'merge-base', '--is-ancestor', peerTip, 'HEAD'), '');
      assert.equal(readFileSync(join(repo, 'remote-feature.txt'), 'utf8'), 'from-peer\n');
      assert.equal(readFileSync(join(repo, 'local-feature.txt'), 'utf8'), 'from-local\n');
      assert.equal(readFileSync(join(repo, 'file'), 'utf8'), 'brouillon non commité\n');
      for (const target of [origin, backup]) assert.equal(git(target, 'rev-parse', 'main'), cleanOp.head);

      // Restore clean `file` and sync peer.
      git(repo, 'checkout', '--', 'file');
      git(peer, 'pull', '--ff-only');

      // 2. Divergent commits touching the same line: AI resolves conflict during push, then push succeeds.
      writeFileSync(join(peer, 'file'), 'version-peer\n');
      git(peer, 'commit', '-am', 'peer edit file');
      git(peer, 'push', 'origin', 'main');

      writeFileSync(join(repo, 'file'), 'version-locale\n');
      git(repo, 'commit', '-am', 'local edit file');

      localPushes.resolveConflicts = async (context) => {
        assert.equal(context.branch, 'main');
        return {
          resolved: true,
          summary: 'Combiner peer et local',
          reason: '',
          files: [
            {
              path: 'file',
              action: 'write',
              content: 'version-peer\nversion-locale\n',
              replacements: [],
            },
          ],
        };
      };

      const resolvedOp = await wait(await localPushes.start(repo, { allowDirty: true }));
      assert.equal(resolvedOp.status, 'succeeded', JSON.stringify(resolvedOp));
      assert.deepEqual(resolvedOp.resolvedFiles, ['file']);
      assert.equal(readFileSync(join(repo, 'file'), 'utf8'), 'version-peer\nversion-locale\n');
      assert.equal(git(origin, 'rev-parse', 'main'), resolvedOp.head);

      // 3. Insoluble conflict during push: leaves repo untouched and reports AI reason.
      git(peer, 'pull', '--ff-only');
      writeFileSync(join(peer, 'file'), 'peer-contradiction\n');
      git(peer, 'commit', '-am', 'peer contradiction');
      git(peer, 'push', 'origin', 'main');

      writeFileSync(join(repo, 'file'), 'local-contradiction\n');
      git(repo, 'commit', '-am', 'local contradiction');
      const snap = integrity(repo);

      localPushes.resolveConflicts = async () => ({
        resolved: false,
        summary: '',
        reason: 'arbitrage fonctionnel requis.',
        files: [],
      });

      const failedOp = await wait(await localPushes.start(repo, { allowDirty: true }));
      assert.equal(failedOp.status, 'failed');
      assert.match(failedOp.error ?? '', /arbitrage fonctionnel requis/);
      assert.deepEqual(integrity(repo), snap);
    } finally {
      rmSync(peer, { recursive: true, force: true });
    }
  }));
