import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-shared-workspace-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
(await import('../server/config.ts')).ensureDataDirs();
const { CerebroDatabase } = await import('../server/db.ts');
const { createWorkspace, sessionProvenance, workspaceFor } = await import('../server/provenance.ts');
const { sessionGitContext } = await import('../server/session-git.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
after(() => rmSync(root, { recursive: true, force: true }));
async function fixture(run) {
  const directory = mkdtempSync(join(root, 'case-'));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'feature/long-lived');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file'), 'original\n');
  writeFileSync(join(repo, '.gitignore'), 'integration-config\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const filename = join(directory, 'db.sqlite');
  let db = new CerebroDatabase(filename);
  const project = db.createProject('Integration project', repo);
  const session = (id) =>
    db.createSession(
      {
        id,
        projectId: project.id,
        agent: 'codex',
        mode: 'auto',
        model: null,
        effort: null,
        prompt: '',
        title: id,
        status: 'exited',
        agentSessionId: 'fake',
      },
      'token',
    );
  const f = {
    directory,
    repo,
    project,
    session,
    get db() {
      return db;
    },
    restart: () => {
      db.close();
      db = new CerebroDatabase(filename);
    },
  };
  try {
    await run(f);
  } finally {
    db.close();
  }
}
test('project shared mode keeps the exact integration directory, staged edits, untracked files and current branch', async () =>
  fixture(async (f) => {
    f.db.updateProject(f.project.id, { workspaceMode: 'shared' });
    const external = join(f.directory, 'external.config');
    writeFileSync(external, 'external integration binding\n');
    symlinkSync(external, join(f.repo, 'integration-config'));
    writeFileSync(join(f.repo, 'file'), 'staged\n');
    git(f.repo, 'add', 'file');
    writeFileSync(join(f.repo, 'file'), 'staged plus local work\n');
    writeFileSync(join(f.repo, 'untracked'), 'user work\n');
    const index = readFileSync(join(f.repo, '.git/index'));
    const listing = git(f.repo, 'worktree', 'list', '--porcelain');
    const refs = git(f.repo, 'show-ref');
    f.session('first');
    f.session('second');
    const first = await createWorkspace(f.db, 'first', f.project);
    const second = await createWorkspace(f.db, 'second', {
      ...f.project,
      path: join(f.directory, 'old-epic-worktree'),
    });
    for (const workspace of [first, second]) {
      assert.equal(workspace.mode, 'shared');
      assert.equal(workspace.path, f.repo);
      assert.equal(workspace.root, f.repo);
      assert.deepEqual(workspace.baseline, {});
    }
    assert.equal(readFileSync(join(first.path, 'integration-config'), 'utf8'), 'external integration binding\n');
    assert.equal(git(f.repo, 'branch', '--show-current'), 'feature/long-lived');
    assert.equal(git(f.repo, 'worktree', 'list', '--porcelain'), listing);
    assert.equal(git(f.repo, 'show-ref'), refs);
    assert.deepEqual(readFileSync(join(f.repo, '.git/index')), index);
    assert.equal(readFileSync(join(f.repo, 'untracked'), 'utf8'), 'user work\n');
    const services = createServices(f.db);
    const provenance = await sessionProvenance(f.db, services.git, 'first');
    assert.deepEqual(provenance.changes, []);
    assert.deepEqual(provenance.commits, []);
    assert.equal(sessionGitContext(f.db, 'first').mode, 'shared');
    const snapshot = await services.sessionGit.prepareCommit('first');
    assert.ok(snapshot.files.every((file) => file.warnings.length));
    assert.match(snapshot.scopeNotice, /Dossier partagé/);
  }));
test('shared mode survives restart and session deletion never removes the long-lived branch or its commits', async () =>
  fixture(async (f) => {
    f.db.updateProject(f.project.id, { workspaceMode: 'shared' });
    f.session('long-lived');
    await createWorkspace(f.db, 'long-lived', f.project);
    writeFileSync(join(f.repo, 'file'), 'first delivery\n');
    git(f.repo, 'commit', '-am', 'first delivery');
    const tip = git(f.repo, 'rev-parse', 'HEAD');
    f.restart();
    assert.equal(f.db.getProject(f.project.id).workspaceMode, 'shared');
    assert.equal(workspaceFor(f.db, 'long-lived').path, f.repo);
    await new SessionManager(f.db, createServices(f.db)).delete('long-lived');
    assert.equal(git(f.repo, 'rev-parse', 'feature/long-lived'), tip);
    assert.equal(git(f.repo, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
    f.session('next');
    const next = await createWorkspace(f.db, 'next', f.project);
    assert.equal(next.path, f.repo);
    assert.equal(readFileSync(join(next.path, 'file'), 'utf8'), 'first delivery\n');
  }));
test('resuming a shared conversation keeps its directory even after the project switches back to isolation (fake CLI)', async () =>
  fixture(async (f) => {
    f.db.updateProject(f.project.id, { workspaceMode: 'shared' });
    f.session('resume');
    await createWorkspace(f.db, 'resume', f.project);
    f.db.updateProject(f.project.id, { workspaceMode: 'isolated' });
    f.restart();
    const bin = join(f.directory, 'bin');
    mkdirSync(bin);
    const capture = join(bin, 'cwd');
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\npwd > '${capture}'\nexec /bin/sleep 2\n`, { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous}`;
    const manager = new SessionManager(f.db, createServices(f.db));
    try {
      await manager.resume('resume');
      assert.equal(readFileSync(capture, 'utf8').trim(), f.repo);
      assert.equal(git(f.repo, 'branch', '--show-current'), 'feature/long-lived');
    } finally {
      process.env.PATH = previous;
      await manager.terminate('resume');
      await manager.shutdown();
    }
    f.session('isolated');
    const isolated = await createWorkspace(f.db, 'isolated', f.project);
    assert.equal(isolated.mode, 'isolated');
    assert.notEqual(isolated.path, f.repo);
    assert.equal(workspaceFor(f.db, 'resume').mode, 'shared');
  }));
test('migration preserves isolation by default and unrelated project settings never reset the shared choice', async () =>
  fixture(async (f) => {
    assert.equal(f.project.workspaceMode, 'isolated');
    f.db.connection.exec('ALTER TABLE projects DROP COLUMN workspace_mode');
    f.restart();
    assert.equal(f.db.getProject(f.project.id).workspaceMode, 'isolated');
    f.db.updateProject(f.project.id, { workspaceMode: 'shared' });
    f.db.updateProject(f.project.id, {
      name: 'Renamed',
      commitSettings: { ...f.project.commitSettings, effort: 'low' },
    });
    f.restart();
    assert.equal(f.db.getProject(f.project.id).workspaceMode, 'shared');
    assert.equal(f.db.createProject('Other', f.repo).workspaceMode, 'isolated');
  }));

test('new epic sessions keep their original cwd after a preference change and restart (fake CLI)', async () => {
  for (const mode of ['isolated', 'shared'])
    await fixture(async (f) => {
      f.db.updateProject(f.project.id, { workspaceMode: mode });
      const epic = f.db.createEpic(f.project.id, 'Livraison', '', null);
      f.db.createSession(
        {
          id: 'origin',
          projectId: f.project.id,
          agent: 'codex',
          mode: 'auto',
          model: null,
          effort: null,
          prompt: 'origine',
          title: 'Origine',
          status: 'exited',
          agentSessionId: 'fake',
        },
        'token',
        epic.id,
      );
      const original = await createWorkspace(f.db, 'origin', f.db.getProject(f.project.id));
      writeFileSync(join(original.path, 'feature.txt'), 'travail à corriger\n');
      f.db.updateProject(f.project.id, { workspaceMode: mode === 'isolated' ? 'shared' : 'isolated' });
      f.restart();
      const bin = join(f.directory, 'bin');
      mkdirSync(bin);
      const capture = join(bin, 'cwd');
      writeFileSync(join(bin, 'codex'), `#!/bin/sh\npwd > '${capture}'\nexec /bin/sleep 2\n`, { mode: 0o755 });
      const previous = process.env.PATH;
      process.env.PATH = `${bin}:${previous}`;
      const manager = new SessionManager(f.db, createServices(f.db));
      try {
        const session = await manager.create(
          f.db.getProject(f.project.id),
          { agent: 'codex', prompt: 'Corriger' },
          undefined,
          undefined,
          'Correction',
          { epicId: epic.id },
        );
        assert.equal(readFileSync(capture, 'utf8').trim(), original.path);
        assert.equal(workspaceFor(f.db, session.id).path, original.path);
        assert.equal(workspaceFor(f.db, session.id).mode, mode);
        assert.equal(
          readFileSync(join(workspaceFor(f.db, session.id).path, 'feature.txt'), 'utf8'),
          'travail à corriger\n',
        );
        await manager.terminate(session.id);
        const independent = await manager.create(f.db.getProject(f.project.id), {
          agent: 'codex',
          prompt: 'Nouveau contexte',
        });
        const independentWorkspace = workspaceFor(f.db, independent.id);
        assert.equal(independentWorkspace.mode, mode === 'isolated' ? 'shared' : 'isolated');
        assert.notEqual(independentWorkspace.path, original.path);
        await manager.terminate(independent.id);
      } finally {
        process.env.PATH = previous;
        await manager.shutdown();
      }
    });
});
