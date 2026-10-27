import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitPlanner } from '../server/git-plan.ts';
import { GitPushes } from '../server/git-push.ts';
import { Reviews, reviewInstructions } from '../server/review.ts';
import { WorktreeGate } from '../server/worktree-gate.ts';

const gate = new WorktreeGate();
const reviews = new Reviews(new GitPlanner(gate, new GitPushes(gate)));
const git = (p, ...a) =>
  execFileSync('git', ['-C', p, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(run, initial = true) {
  const repo = mkdtempSync(join(tmpdir(), 'cerebro-review-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  if (initial) {
    writeFileSync(join(repo, 'file'), 'initial\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'base');
  }
  try {
    await run(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
test('staged, unstaged and untracked changes are all collected without an agent', async () =>
  fixture(async (repo) => {
    writeFileSync(join(repo, 'file'), 'staged\n');
    git(repo, 'add', 'file');
    writeFileSync(join(repo, 'file'), 'unstaged\n');
    writeFileSync(join(repo, 'new'), 'untracked\n');
    const r = await reviews.prepare(repo);
    assert.equal(r.scope, 'working');
    for (const s of ['+staged', '+unstaged', '+untracked']) assert.ok(r.context.includes(s));
    writeFileSync(join(repo, 'file'), 'initial\n');
    const reverted = await reviews.prepare(repo);
    assert.ok(reverted.context.includes('+staged'));
  }));
test('untracked-only and unborn repositories produce explicit contexts', async () =>
  fixture(async (repo) => {
    let r = await reviews.prepare(repo);
    assert.equal(r.scope, 'empty');
    await assert.rejects(reviews.verify(repo, r.id), /Aucun/);
    writeFileSync(join(repo, 'new'), 'new\n');
    r = await reviews.prepare(repo);
    assert.equal(r.head, null);
    assert.equal(r.scope, 'working');
    assert.deepEqual(r.files, ['new']);
  }, false));
test('without upstream review last commit; with upstream review only unpushed commits', async () =>
  fixture(async (repo) => {
    let r = await reviews.prepare(repo);
    assert.equal(r.scope, 'last-commit');
    assert.equal(r.commits.length, 1);
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'config', 'remote.origin.url', repo);
    git(repo, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    git(repo, 'config', 'branch.main.remote', 'origin');
    git(repo, 'config', 'branch.main.merge', 'refs/heads/main');
    r = await reviews.prepare(repo);
    assert.equal(r.scope, 'empty');
    writeFileSync(join(repo, 'file'), 'next\n');
    git(repo, 'commit', '-am', 'next');
    r = await reviews.prepare(repo);
    assert.equal(r.scope, 'unpushed');
    assert.equal(r.commits.length, 1);
    assert.ok(r.context.includes('+next'));
    await reviews.verify(repo, r.id);
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await assert.rejects(reviews.verify(repo, r.id), /upstream/);
  }));
test('stale worktree preparation is refused and all agent/custom-command prompts share the immutable scope', async () =>
  fixture(async (repo) => {
    const r = await reviews.prepare(repo);
    const prompt = reviewInstructions(r.root, r, r.context);
    assert.ok(prompt.includes('commande de review personnalisée'));
    assert.ok(prompt.includes(r.head));
    writeFileSync(join(repo, 'file'), 'concurrent\n');
    await assert.rejects(reviews.verify(repo, r.id), /obsolète/);
  }));
