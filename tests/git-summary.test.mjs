import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { gitSummary } from '../server/git-summary.ts';
import { parseGitInfo } from '../web/src/types.ts';

const root = mkdtempSync(join(tmpdir(), 'cerebro-git-summary-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});
const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture() {
  const repo = mkdtempSync(join(root, 'repo-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Développeur <équipe>');
  git(repo, 'config', 'user.email', 'test@example.com');
  return repo;
}
function base(repo) {
  writeFileSync(join(repo, 'file'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Départ');
  return git(repo, 'rev-parse', 'HEAD');
}
function upstream(repo) {
  const remote = mkdtempSync(join(root, 'remote-'));
  git(remote, 'init', '--bare');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', 'main');
}
function commit(repo, message) {
  writeFileSync(join(repo, 'file'), `${message}\n`);
  git(repo, 'commit', '-am', message);
  return git(repo, 'rev-parse', 'HEAD');
}

test('unpushed preview uses the upstream range, shows newest first, and preserves staged and unstaged changes', async () => {
  const repo = fixture();
  const first = base(repo);
  upstream(repo);
  const hashes = [
    commit(repo, 'Corriger les accents'),
    commit(repo, '<script> & message\n\nCorps détaillé'),
    commit(repo, 'Dernier changement'),
  ];
  // A divergent upstream must not appear among the local commits.
  const remoteTip = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', first, '-m', 'Changement distant');
  git(repo, 'update-ref', 'refs/remotes/origin/main', remoteTip);
  writeFileSync(join(repo, 'file'), 'staged\n');
  git(repo, 'add', 'file');
  writeFileSync(join(repo, 'file'), 'unstaged\n');
  writeFileSync(join(repo, 'new'), 'untracked\n');
  const index = readFileSync(join(repo, '.git/index'));
  const refs = git(repo, 'show-ref');
  const summary = parseGitInfo(await gitSummary(repo, true));
  assert.equal(summary.ahead, 3);
  assert.equal(summary.dirty, 2);
  assert.equal(summary.pendingCommits.upstream, 'origin/main');
  assert.deepEqual(
    summary.pendingCommits.commits.map((c) => c.hash),
    hashes.reverse(),
  );
  assert.deepEqual(
    summary.pendingCommits.commits.map((c) => c.subject),
    ['Dernier changement', '<script> & message', 'Corriger les accents'],
  );
  assert.ok(summary.pendingCommits.commits.every((c) => c.author === 'Développeur équipe'));
  assert.equal(summary.pendingCommits.truncated, false);
  assert.deepEqual(readFileSync(join(repo, '.git/index')), index);
  assert.equal(git(repo, 'show-ref'), refs);
  assert.equal(readFileSync(join(repo, 'file'), 'utf8'), 'unstaged\n');
  assert.equal(readFileSync(join(repo, 'new'), 'utf8'), 'untracked\n');
  assert.equal((await gitSummary(repo)).pendingCommits, undefined);
  git(repo, 'push', 'origin', 'main:preview'); // Does not move the upstream reference.
  assert.equal((await gitSummary(repo, true)).ahead, 3);
  git(repo, 'update-ref', 'refs/remotes/origin/main', hashes[0]);
  const pushed = await gitSummary(repo, true);
  assert.equal(pushed.ahead, 0);
  assert.deepEqual(pushed.pendingCommits.commits, []);
});

test('preview is bounded while the full count remains available', async () => {
  const repo = fixture();
  let tip = base(repo);
  upstream(repo);
  for (let i = 1; i <= 53; i++) tip = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', tip, '-m', `Change ${i}`);
  git(repo, 'update-ref', 'refs/heads/main', tip);
  const summary = await gitSummary(repo, true);
  assert.equal(summary.ahead, 53);
  assert.equal(summary.pendingCommits.commits.length, 50);
  assert.equal(summary.pendingCommits.truncated, true);
  assert.equal(summary.pendingCommits.commits[0].subject, 'Change 53');
  assert.equal(summary.pendingCommits.commits.at(-1).subject, 'Change 4');
});

test('missing repository, unborn branch and missing upstream never invent commits to push', async () => {
  const directory = mkdtempSync(join(root, 'plain-'));
  assert.equal((await gitSummary(directory, true)).hasCommits, false);
  const repo = fixture();
  assert.deepEqual(await gitSummary(repo, true), {
    branch: 'main',
    dirty: 0,
    ahead: 0,
    hasCommits: false,
    hasUpstream: false,
  });
  base(repo);
  const summary = await gitSummary(repo, true);
  assert.equal(summary.ahead, null);
  assert.equal(summary.hasCommits, true);
  assert.equal(summary.hasUpstream, false);
  assert.equal(summary.pendingCommits, undefined);
  assert.deepEqual(parseGitInfo({ branch: 'main', dirty: 0, ahead: 3 }), {
    branch: 'main',
    dirty: 0,
    ahead: 3,
    hasCommits: true,
    hasUpstream: true,
  });
});

test('project API exposes previews on request without launching an agent', async () => {
  const { SessionManager } = await import('../server/sessions.ts');
  const { UpdateManager } = await import('../server/updates.ts');
  const { PeerSync } = await import('../server/peers.ts');
  const { buildServer } = await import('../server/index.ts');
  mock.method(UpdateManager.prototype, 'start', () => {});
  mock.method(PeerSync.prototype, 'sync', async function () {
    this.markReady();
    this.markSynced();
  });
  const launch = mock.method(SessionManager.prototype, 'launch', async () => {
    throw new Error('Unexpected agent');
  });
  const repo = fixture();
  base(repo);
  upstream(repo);
  commit(repo, 'API preview');
  const app = await buildServer();
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Preview', path: repo },
    });
    assert.equal(created.statusCode, 201);
    const url = `/api/projects/${created.json().id}/git`;
    assert.equal((await app.inject({ method: 'GET', url })).json().pendingCommits, undefined);
    const response = await app.inject({ method: 'GET', url: `${url}?commits=true` });
    assert.equal(response.statusCode, 200);
    assert.equal(parseGitInfo(response.json()).pendingCommits.commits[0].subject, 'API preview');
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/missing/git?commits=true' })).statusCode, 404);
    assert.equal(launch.mock.callCount(), 0);
  } finally {
    await app.close();
  }
});
