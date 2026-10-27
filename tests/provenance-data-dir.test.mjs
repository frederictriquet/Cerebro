import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
// The data directory is a link whose target lies inside the repository: the textual path looks
// outside, only its physical location reveals that the copies would land in the project.
const root = mkdtempSync(join(tmpdir(), 'cerebro-provenance-data-'));
const repo = join(root, 'repo');
mkdirSync(join(repo, '.cerebro'), { recursive: true });
symlinkSync(join(repo, '.cerebro'), join(root, 'data'), 'dir');
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.HOME = root;
const { CerebroDatabase } = await import('../server/db.ts');
const { createWorkspace } = await import('../server/provenance.ts');
const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(repo, 'init', '-b', 'main');
git(repo, 'config', 'user.name', 'Test');
git(repo, 'config', 'user.email', 'test@example.com');
writeFileSync(join(repo, '.gitignore'), '.cerebro/\n');
writeFileSync(join(repo, 'file'), 'original\n');
git(repo, 'add', '.');
git(repo, 'commit', '-m', 'base');
const db = new CerebroDatabase(join(root, 'test.db'));
const project = db.createProject('Demo', repo);
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
test('a data directory reached through a link into the repository is refused before any copy', async () => {
  db.createSession(
    {
      id: 'inside',
      projectId: project.id,
      agent: 'codex',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: 'inside',
      status: 'exited',
      agentSessionId: 'inside',
    },
    'token',
  );
  await assert.rejects(createWorkspace(db, 'inside', project), /hors du dépôt/);
  assert.equal(existsSync(join(repo, '.cerebro', 'workspaces')), false);
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
});
