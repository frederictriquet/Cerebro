import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-provenance-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.HOME = root;
mkdirSync(process.env.CEREBRO_DATA_DIR);
const { CerebroDatabase } = await import('../server/db.ts');
const { createWorkspace, joinWorkspace, sessionProvenance, workspaceAt, workspaceFor } =
  await import('../server/provenance.ts');
const { GitPlanner } = await import('../server/git-plan.ts');
const { GitPushes } = await import('../server/git-push.ts');
const { WorktreeGate } = await import('../server/worktree-gate.ts');
const gate = new WorktreeGate();
const planner = new GitPlanner(gate, new GitPushes(gate));
const repo = join(root, 'repo');
mkdirSync(repo);
const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(repo, 'init', '-b', 'main');
git(repo, 'config', 'user.name', 'Test');
git(repo, 'config', 'user.email', 'test@example.com');
for (const name of ['first', 'second', 'shared', 'initial']) writeFileSync(join(repo, name), 'original\n');
writeFileSync(join(repo, '.gitignore'), 'ignored\nnode_modules/\n.cache/\n');
git(repo, 'add', '.');
git(repo, 'commit', '-m', 'base');
writeFileSync(join(repo, 'initial'), 'preexisting\n');
git(repo, 'add', 'initial');
writeFileSync(join(repo, 'untracked'), 'existing untracked\n');
writeFileSync(join(repo, 'ignored'), 'configuration\n');
mkdirSync(join(repo, 'node_modules', 'dependency'), { recursive: true });
writeFileSync(join(repo, 'node_modules', 'dependency', 'large.bin'), Buffer.alloc(8 * 1024 * 1024, 7));
mkdirSync(join(repo, '.cache'), { recursive: true });
writeFileSync(join(repo, '.cache', 'generated.bin'), Buffer.alloc(8 * 1024 * 1024, 8));
let db = new CerebroDatabase(join(root, 'test.db'));
const project = db.createProject('Demo', repo);
function session(id) {
  return db.createSession(
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
      agentSessionId: id,
    },
    'token',
  );
}
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
let a, b;
test('new workspaces preserve initial context and index without changing the project', async () => {
  session('a');
  session('b');
  const index = readFileSync(join(repo, '.git/index'));
  a = await createWorkspace(db, 'a', project);
  b = await createWorkspace(db, 'b', project);
  assert.equal(a.mode, 'isolated');
  assert.notEqual(a.path, b.path);
  for (const ws of [a, b]) {
    assert.equal(readFileSync(join(ws.path, 'initial'), 'utf8'), 'preexisting\n');
    assert.equal(readFileSync(join(ws.path, 'ignored'), 'utf8'), 'configuration\n');
    assert.equal(lstatSync(join(ws.path, 'node_modules')).isSymbolicLink(), true);
    assert.equal(readFileSync(join(ws.path, 'node_modules', 'dependency', 'large.bin')).length, 8 * 1024 * 1024);
    assert.deepEqual(ws.sharedIgnored, ['node_modules']);
    assert.ok(!Object.keys(ws.baseline).some((name) => name.startsWith('node_modules/')));
    assert.equal(existsSync(join(ws.path, '.cache')), false);
    assert.equal(git(ws.path, 'show', ':initial'), 'preexisting');
    assert.ok(ws.initialDirty.includes('initial'));
  }
  assert.deepEqual(readFileSync(join(repo, '.git/index')), index);
  const { changes, workspace } = await sessionProvenance(db, planner, 'a');
  assert.deepEqual(changes, []);
  assert.ok(
    !(await planner.prepareCommit(workspace.root, workspace)).files.some((file) => file.path === 'node_modules'),
    'shared dependency link stays out of the commit plan',
  );
});
test('two sessions edit distinct then shared files, original human edits never enter their scope', async () => {
  writeFileSync(join(a.path, 'first'), 'session a\n');
  writeFileSync(join(b.path, 'second'), 'session b\n');
  writeFileSync(join(a.path, 'shared'), 'a\n');
  writeFileSync(join(b.path, 'shared'), 'b\n');
  writeFileSync(join(repo, 'first'), 'human\n');
  let pa = await sessionProvenance(db, planner, 'a');
  const pb = await sessionProvenance(db, planner, 'b');
  assert.deepEqual(
    pa.changes.map((c) => c.path),
    ['first', 'shared'],
  );
  assert.deepEqual(
    pb.changes.map((c) => c.path),
    ['second', 'shared'],
  );
  assert.equal(readFileSync(join(a.path, 'first'), 'utf8'), 'session a\n');
  writeFileSync(join(a.path, 'initial'), 'session after initial\n');
  pa = await sessionProvenance(db, planner, 'a');
  assert.equal(pa.changes.find((c) => c.path === 'initial').certainty, 'uncertain');
  assert.match(pa.warning, /humaine ou externe/);
});
test('commits remain attributable by isolated branch across restart and historical sessions stay unknown', async () => {
  git(a.path, 'add', 'first');
  git(a.path, 'commit', '--only', 'first', '-m', 'session first');
  const oid = git(a.path, 'rev-parse', 'HEAD');
  db.close();
  db = new CerebroDatabase(join(root, 'test.db'));
  assert.equal(workspaceFor(db, 'a').path, a.path);
  const pa = await sessionProvenance(db, planner, 'a');
  assert.equal(pa.commits[0].hash, oid);
  assert.equal(pa.commits[0].certainty, 'workspace');
  session('historical');
  const old = await sessionProvenance(db, planner, 'historical');
  assert.equal(old.workspace.mode, 'unknown');
  assert.deepEqual(old.changes, []);
  assert.deepEqual(old.commits, []);
  assert.match(old.workspace.reason, /historique/);
});
test('commits in the source and switching an isolated branch do not invent session attribution', async () => {
  git(repo, 'commit', '--only', 'initial', '-m', 'human source');
  const pa = await sessionProvenance(db, planner, 'a');
  assert.ok(pa.commits.every((c) => c.title !== 'human source'));
  git(b.path, 'checkout', '--detach');
  const pb = await sessionProvenance(db, planner, 'b');
  assert.deepEqual(pb.commits, []);
  assert.ok(pb.changes.every((c) => c.certainty === 'uncertain'));
});
test('a later epic step joins the first copy and inherits its uncommitted work as initial changes', async () => {
  session('step1');
  session('step2');
  const first = await createWorkspace(db, 'step1', project);
  writeFileSync(join(first.path, 'second'), 'step one\n');
  assert.equal(workspaceAt(db, first.path).sessionId, 'step1');
  const second = await joinWorkspace(db, 'step2', workspaceAt(db, first.path));
  assert.equal(second.path, first.path);
  assert.equal(second.branch, first.branch);
  assert.deepEqual(second.sharedIgnored, ['node_modules']);
  assert.ok(second.initialDirty.includes('second'));
  assert.ok(!second.initialDirty.includes('node_modules'));
  assert.equal(workspaceAt(db, first.path).sessionId, 'step1', 'the copy stays owned by the first step');
  writeFileSync(join(first.path, 'shared'), 'step two\n');
  assert.deepEqual(
    (await sessionProvenance(db, planner, 'step2')).changes.map((change) => change.path),
    ['shared'],
  );
  assert.deepEqual(
    (await sessionProvenance(db, planner, 'step1')).changes.map((change) => change.path),
    ['second', 'shared'],
  );
});
