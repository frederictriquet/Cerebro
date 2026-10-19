import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startPush } from '../server/git-push.ts';

const git = (path, ...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'cerebro-push-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file'), 'original\n');
  git(repo, 'add', 'file'); git(repo, 'commit', '-m', 'initial');
  const remote = (name) => {
    const path = join(root, name); mkdirSync(path); git(path, 'init', '--bare');
    git(repo, 'remote', 'add', name, path); return path;
  };
  try { await run({ repo, remote }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
async function wait(op) {
  while (op.finishedAt === null) await new Promise((resolve) => setTimeout(resolve, 10));
  return op;
}
const integrity = (repo) => ({ head: git(repo, 'rev-parse', 'HEAD'), index: readFileSync(join(repo, '.git/index')).toString('hex'), file: readFileSync(join(repo, 'file'), 'utf8') });

test('push sets origin upstream, publishes each remote, preserves HEAD, index and worktree', async () => fixture(async ({repo, remote}) => {
  const origin = remote('origin'); const backup = remote('backup');
  const before = integrity(repo);
  const op = await wait(await startPush(repo));
  assert.equal(op.status, 'succeeded', JSON.stringify(op));
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main');
  for (const path of [origin, backup]) assert.equal(git(path, 'rev-parse', 'main'), before.head);
  assert.deepEqual(integrity(repo), before);
  git(repo, 'config', 'push.default', 'nothing');
  assert.equal((await wait(await startPush(repo))).status, 'succeeded');
}));

test('sole remote becomes upstream; ambiguous remotes and missing remotes are explicit failures', async () => fixture(async ({repo, remote}) => {
  assert.match((await wait(await startPush(repo))).error, /Aucun remote/);
  const one = remote('one');
  assert.equal((await wait(await startPush(repo))).status, 'succeeded');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'one/main');
  git(repo, 'branch', '--unset-upstream'); remote('two');
  const op = await wait(await startPush(repo));
  assert.match(op.error, /Plusieurs remotes/);
  assert.deepEqual(op.remotes, []);
  assert.equal(git(one, 'rev-parse', 'main'), git(repo, 'rev-parse', 'HEAD'));
}));

test('rejected remote does not prevent the next remote; hooks remain enabled', async () => fixture(async ({repo, remote}) => {
  const rejected = remote('aaa'); const origin = remote('origin');
  writeFileSync(join(rejected, 'hooks/pre-receive'), '#!/bin/sh\necho rejected >&2\nexit 1\n', { mode: 0o755 });
  const before = integrity(repo);
  let op = await wait(await startPush(repo));
  assert.deepEqual(op.remotes.map(r => [r.remote,r.status]), [['aaa','failed'],['origin','succeeded']]);
  assert.equal(git(origin, 'rev-parse', 'main'), before.head);
  writeFileSync(join(repo, '.git/hooks/pre-push'), '#!/bin/sh\necho hook-failed >&2\nexit 1\n', { mode: 0o755 });
  op = await wait(await startPush(repo));
  assert.ok(op.remotes.every(r => r.status === 'failed' && r.output.includes('hook-failed')));
  assert.deepEqual(integrity(repo), before);
}));

test('concurrent starts share operation; real dirty state is rejected without index mutations', async () => fixture(async ({repo, remote}) => {
  remote('origin');
  const [a,b] = await Promise.all([startPush(repo), startPush(repo)]);
  assert.equal(a.id,b.id); await wait(a);
  writeFileSync(join(repo, 'file'), 'changed\n'); git(repo, 'add', 'file');
  const before = integrity(repo);
  const op = await wait(await startPush(repo));
  assert.match(op.error, /changements/);
  assert.deepEqual(integrity(repo), before);
}));
