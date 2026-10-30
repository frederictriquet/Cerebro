import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AutoPush } from '../server/auto-push.ts';
import { CerebroDatabase } from '../server/db.ts';
import { GitPushes } from '../server/git-push.ts';
import { WorktreeGate } from '../server/worktree-gate.ts';

const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'cerebro-auto-push-'));
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  mkdirSync(repo);
  mkdirSync(origin);
  git(origin, 'init', '--bare');
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'remote', 'add', 'origin', origin);
  let n = 0;
  const commit = () => {
    writeFileSync(join(repo, 'file'), `${++n}\n`);
    git(repo, 'add', 'file');
    git(repo, 'commit', '-m', `commit ${n}`);
    return git(repo, 'rev-parse', 'HEAD');
  };
  commit();
  git(repo, 'push', '-u', 'origin', 'main');
  const db = new CerebroDatabase(':memory:');
  const project = db.createProject('repo', repo);
  const pushes = new GitPushes(new WorktreeGate());
  let busy = false;
  const auto = new AutoPush(db, pushes, () => busy);
  const settle = async () => {
    await auto.tick();
    for (let op = await pushes.current(repo); op?.status === 'running'; op = await pushes.current(repo))
      await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const remoteHead = () => git(origin, 'rev-parse', 'main');
  try {
    await run({
      db,
      project,
      repo,
      commit,
      settle,
      remoteHead,
      setBusy: (value) => (busy = value),
      current: () => pushes.current(repo),
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('pushes a new commit only when the project enables it', async () =>
  fixture(async ({ db, project, commit, settle, remoteHead }) => {
    const pushed = remoteHead();
    await settle();
    commit();
    await settle();
    assert.equal(remoteHead(), pushed, 'disabled by default');

    assert.equal(db.updateProject(project.id, { autoPush: true }).autoPush, true);
    assert.equal(db.getProject(project.id).autoPush, true);
    await settle();
    assert.equal(remoteHead(), pushed, 'commits made before enabling wait for the next commit');

    const head = commit();
    await settle();
    assert.equal(remoteHead(), head);
  }));

test('waits while a Cerebro operation commits, and skips a HEAD already pushed', async () =>
  fixture(async ({ db, project, commit, settle, remoteHead, setBusy, current, repo }) => {
    db.updateProject(project.id, { autoPush: true });
    await settle();
    setBusy(true);
    const head = commit();
    await settle();
    assert.notEqual(remoteHead(), head);
    setBusy(false);
    await settle();
    assert.equal(remoteHead(), head);

    const before = (await current())?.id;
    const next = commit();
    git(repo, 'push');
    await settle();
    assert.equal(remoteHead(), next);
    assert.equal((await current())?.id, before, 'no push for commits already on the upstream');
  }));

test('a branch switch is not a commit', async () =>
  fixture(async ({ db, project, repo, commit, settle, current }) => {
    db.updateProject(project.id, { autoPush: true });
    await settle();
    git(repo, 'checkout', '-b', 'feature');
    commit();
    git(repo, 'checkout', 'main');
    await settle();
    git(repo, 'checkout', 'feature');
    await settle();
    assert.equal(await current(), null);
  }));
