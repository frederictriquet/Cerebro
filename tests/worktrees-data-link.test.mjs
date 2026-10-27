import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
// The data directory is reached through a link (~/.cerebro pointing to another disk): the copies' textual
// paths differ from their physical ones, also once the copy has been deleted from disk.
const root = mkdtempSync(join(tmpdir(), 'cerebro-worktree-data-link-'));
mkdirSync(join(root, 'disk'));
symlinkSync(join(root, 'disk'), join(root, 'data'), 'dir');
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.HOME = root;
const { CerebroDatabase } = await import('../server/db.ts');
const { createWorkspace, joinWorkspace, workspaceFor } = await import('../server/provenance.ts');
const { createServices } = await import('../server/services.ts');
const { WorktreeManager } = await import('../server/worktrees.ts');
const { canonicalWorktreePath } = await import('../server/worktree-gate.ts');
const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
after(() => rmSync(root, { recursive: true, force: true }));
const repo = join(root, 'repo');
mkdirSync(repo);
git(repo, 'init', '-b', 'main');
git(repo, 'config', 'user.name', 'Test');
git(repo, 'config', 'user.email', 'test@example.com');
writeFileSync(join(repo, 'file'), 'base\n');
git(repo, 'add', '.');
git(repo, 'commit', '-m', 'base');
const session = (db, project, title) => {
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
      title,
      status: 'exited',
      agentSessionId: 'fake',
    },
    'token',
  );
  return id;
};

test('a deleted path behind a link keeps the physical identity of its remaining ancestors', () => {
  const missing = join(root, 'data', 'workspaces', 'gone');
  assert.equal(canonicalWorktreePath(missing), join(realpathSync(join(root, 'disk')), 'workspaces', 'gone'));
});

for (const way of ['remove', 'release'])
  test(`removing a shared epic copy through a linked data directory reaches every step (${way})`, async () => {
    const db = new CerebroDatabase(join(root, `${way}.sqlite`));
    const manager = new WorktreeManager(db, createServices(db));
    try {
      const project = db.createProject('Project', repo);
      const first = session(db, project, 'First step');
      const workspace = await createWorkspace(db, first, project);
      assert.ok(workspace.root.startsWith(join(root, 'data')));
      const step = session(db, project, 'Next step');
      await joinWorkspace(db, step, workspace);
      const own = (await manager.list(project.id)).worktrees.find((w) => w.sessionId === first);
      assert.equal(own.path, realpathSync(workspace.root));
      if (way === 'remove') {
        const plan = await manager.prepareAction(own.id, 'remove');
        await manager.start(own.id, 'remove', plan.token);
        await manager.shutdown();
      } else await manager.releaseSession(step, workspaceFor(db, step).root);
      assert.equal(existsSync(workspace.root), false);
      assert.ok(workspaceFor(db, first).removedAt);
      assert.ok(workspaceFor(db, step).removedAt, 'the step sharing the copy must not be resumed in a deleted folder');
    } finally {
      await manager.shutdown();
      db.close();
    }
  });
