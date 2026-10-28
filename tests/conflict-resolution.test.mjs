import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-conflict-tests-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.HOME = root;
(await import('../server/config.ts')).ensureDataDirs();
const { CerebroDatabase } = await import('../server/db.ts');
const { createWorkspace } = await import('../server/provenance.ts');
const { WorktreeManager } = await import('../server/worktrees.ts');
const { createServices } = await import('../server/services.ts');
const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
after(() => rmSync(root, { recursive: true, force: true }));
const lines = (count) => Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join('');

/** A project with `file` and `doc`, and a conversation's copy of it; `run` gets the copy and the project. */
async function fixture(run) {
  const directory = mkdtempSync(join(root, 'case-'));
  const repo = join(directory, 'source');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file'), 'base\n');
  writeFileSync(join(repo, 'doc'), lines(10));
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const db = new CerebroDatabase(join(directory, 'db.sqlite'));
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
  const manager = new WorktreeManager(db, createServices(db));
  const view = async () => (await manager.list(project.id)).worktrees.find((w) => w.sessionId === id);
  const commit = (path, file, content, message) => {
    writeFileSync(join(path, file), content);
    git(path, 'add', file);
    git(path, 'commit', '-m', message);
  };
  try {
    await run({ repo, copy: workspace.root, manager, view, commit });
  } finally {
    await manager.shutdown();
    db.close();
  }
}

test('the context of a merge left in conflict describes both sides and each file', async () =>
  fixture(async ({ repo, copy, manager, view, commit }) => {
    commit(copy, 'file', 'session work\n', 'session work');
    commit(repo, 'file', 'project work\n', 'project work');
    commit(repo, 'other', 'project\n', 'project other');
    const base = git(copy, 'rev-parse', 'HEAD~1');
    let own = await view();
    await manager.updateFromTarget(own.id);
    own = await view();
    assert.equal(own.error, null);
    assert.deepEqual(own.conflicts, ['file']);
    assert.deepEqual(own.remainingMarkers, ['file']);
    let context = await manager.conflictResolution(own.id);
    assert.equal(context.mergeHead, git(repo, 'rev-parse', 'HEAD'));
    assert.equal(context.base, base);
    assert.deepEqual(
      context.oursCommits.map((c) => c.subject),
      ['session work'],
    );
    assert.equal(context.oursCommits[0].hash, git(copy, 'rev-parse', '--short', 'HEAD'));
    assert.deepEqual(
      context.theirsCommits.map((c) => c.subject),
      ['project other', 'project work'],
    );
    assert.deepEqual(context.files, [
      {
        path: 'file',
        ours: 'modified',
        theirs: 'modified',
        oursCommits: ['session work'],
        theirsCommits: ['project work'],
      },
    ]);
    assert.deepEqual(context.resolved, []);
    writeFileSync(join(copy, 'file'), 'session and project work\n');
    own = await view();
    assert.deepEqual(own.remainingMarkers, []);
    context = await manager.conflictResolution(own.id);
    assert.deepEqual(context.resolved, ['file']);
    own = await manager.finishTargetUpdate(own.id);
    assert.equal(own.mergeInProgress, false);
    assert.deepEqual(own.remainingMarkers, []);
  }));

test('a file deleted on one side and modified on the other is described as such', async () =>
  fixture(async ({ repo, copy, manager, view, commit }) => {
    git(copy, 'rm', '--quiet', 'file');
    git(copy, 'commit', '-m', 'remove file');
    commit(repo, 'file', 'project work\n', 'project work');
    let own = await view();
    await manager.updateFromTarget(own.id);
    own = await view();
    assert.deepEqual(own.conflicts, ['file']);
    const context = await manager.conflictResolution(own.id);
    assert.deepEqual(context.files, [
      {
        path: 'file',
        ours: 'deleted',
        theirs: 'modified',
        oursCommits: ['remove file'],
        theirsCommits: ['project work'],
      },
    ]);
  }));

test('a file renamed in the copy is followed under its former name in the target', async () =>
  fixture(async ({ repo, copy, manager, view, commit }) => {
    writeFileSync(join(copy, 'doc'), lines(10).replace('line 2\n', 'line 2 from the copy\n'));
    git(copy, 'mv', 'doc', 'renamed');
    git(copy, 'commit', '-am', 'rename and edit');
    commit(repo, 'doc', lines(10).replace('line 2\n', 'line 2 from the project\n'), 'project edit');
    let own = await view();
    await manager.updateFromTarget(own.id);
    own = await view();
    assert.deepEqual(own.conflicts, ['renamed']);
    const context = await manager.conflictResolution(own.id);
    assert.deepEqual(context.files, [
      {
        path: 'renamed',
        ours: 'renamed',
        theirs: 'modified',
        oursCommits: ['rename and edit'],
        theirsCommits: ['project edit'],
      },
    ]);
  }));

test('the conflict context is refused without a merge in progress', async () =>
  fixture(async ({ repo, copy, manager, view, commit }) => {
    let own = await view();
    await assert.rejects(manager.conflictResolution(own.id), (cause) => {
      assert.equal(cause.statusCode, 409);
      assert.match(cause.message, /Aucun conflit/);
      return true;
    });
    commit(copy, 'file', 'session work\n', 'session work');
    commit(repo, 'other', 'project\n', 'project other');
    await manager.updateFromTarget(own.id);
    own = await view();
    assert.equal(own.mergeInProgress, false);
    await assert.rejects(manager.conflictResolution(own.id), (cause) => cause.statusCode === 409);
  }));

test('markers in a file already staged still block the end of the update', async () =>
  fixture(async ({ repo, copy, manager, view, commit }) => {
    commit(copy, 'file', 'session work\n', 'session work');
    commit(repo, 'file', 'project work\n', 'project work');
    // Markers that are content on one side are not left over by the merge.
    commit(repo, 'sample', '<<<<<<< ours\nexample\n>>>>>>> theirs\n', 'conflict sample');
    let own = await view();
    await manager.updateFromTarget(own.id);
    git(copy, 'add', 'file');
    own = await view();
    assert.equal(own.mergeInProgress, true);
    assert.deepEqual(own.conflicts, []);
    assert.deepEqual(own.remainingMarkers, ['file']);
    await assert.rejects(manager.finishTargetUpdate(own.id), /Marqueurs de conflit encore présents : file\./);
    writeFileSync(join(copy, 'file'), 'session and project work\n');
    own = await view();
    assert.deepEqual(own.remainingMarkers, ['file'], 'the index still has the markers');
    git(copy, 'add', 'file');
    own = await view();
    assert.deepEqual(own.remainingMarkers, []);
    own = await manager.finishTargetUpdate(own.id);
    assert.equal(own.mergeInProgress, false);
    assert.equal(git(copy, 'show', 'HEAD:file'), 'session and project work');
  }));
