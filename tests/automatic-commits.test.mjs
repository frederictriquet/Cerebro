import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  promises as fsPromises,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { after, test } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-auto-commits-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
const { CerebroDatabase } = await import('../server/db.ts');
const { AutomaticCommits } = await import('../server/automatic-commits.ts');
const { createServices } = await import('../server/services.ts');
const { proposeCommits } = await import('../server/commit-proposal.ts');
const { runHeadless } = await import('../server/headless.ts');
const { createWorkspace } = await import('../server/provenance.ts');
const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
after(() => rmSync(root, { recursive: true, force: true }));
async function fixture(run) {
  const directory = mkdtempSync(join(root, 'case-'));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const db = new CerebroDatabase(join(directory, 'db.sqlite'));
  const project = db.createProject('Project', repo);
  let services = createServices(db);
  let manager = new AutomaticCommits(db, services);
  let calls = 0;
  const settings = { agent: 'codex', model: 'test-model', effort: 'low', strategy: 'single' };
  const context = { scope: `projects/${project.id}`, path: repo, projectId: project.id, sessionId: null, settings };
  const proposal = async (input) => {
    calls++;
    return {
      commits: [{ message: 'feat: implement the intended changes', paths: input.files.map((file) => file.path) }],
    };
  };
  manager.proposeCommits = proposal;
  const finish = async (operation) => {
    for (let i = 0; i < 500; i++) {
      const current = manager.get(operation.id);
      if (current.status !== 'running') return current;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timeout');
  };
  const f = {
    repo,
    directory,
    project,
    db,
    context,
    finish,
    get manager() {
      return manager;
    },
    get services() {
      return services;
    },
    get calls() {
      return calls;
    },
    restart: async () => {
      await manager.shutdown();
      // A restarted server starts with empty in-memory state.
      services = createServices(db);
      manager = new AutomaticCommits(db, services);
      manager.proposeCommits = proposal;
    },
  };
  try {
    await run(f);
  } finally {
    await manager.shutdown();
    db.close();
  }
}
test('one action drafts a message with project tuning, commits and pushes to a local remote', async () =>
  fixture(async (f) => {
    const remote = join(f.directory, 'remote.git');
    git(f.directory, 'init', '--bare', remote);
    git(f.repo, 'remote', 'add', 'origin', remote);
    writeFileSync(join(f.repo, 'file'), 'implemented\n');
    f.manager.proposeCommits = async (input) => {
      assert.deepEqual(input.settings, f.context.settings);
      assert.match(input.files[0].diff, /implemented/);
      return { commits: [{ message: 'feat: implement requested behavior', paths: ['file'] }] };
    };
    const result = await f.finish(await f.manager.start(f.context, randomUUID(), true));
    assert.equal(result.status, 'succeeded', result.error);
    assert.equal(result.commits[0].title, 'feat: implement requested behavior');
    assert.equal(result.pushOperation.status, 'succeeded');
    assert.equal(git(remote, 'rev-parse', 'main'), git(f.repo, 'rev-parse', 'HEAD'));
    assert.equal(f.db.listSessions().length, 0);
  }));
test('a clean repository pushes directly without any inference', async () =>
  fixture(async (f) => {
    const remote = join(f.directory, 'remote.git');
    git(f.directory, 'init', '--bare', remote);
    git(f.repo, 'remote', 'add', 'origin', remote);
    const result = await f.finish(await f.manager.start(f.context, randomUUID(), true));
    assert.equal(result.status, 'succeeded');
    assert.equal(result.commits.length, 0);
    assert.equal(f.calls, 0);
  }));
test('a shared dependency link alone neither blocks the commit nor the push', async () =>
  fixture(async (f) => {
    const remote = join(f.directory, 'remote.git');
    git(f.directory, 'init', '--bare', remote);
    git(f.repo, 'remote', 'add', 'origin', remote);
    const source = join(f.directory, 'source');
    mkdirSync(join(source, 'node_modules'), { recursive: true });
    symlinkSync(join(source, 'node_modules'), join(f.repo, 'node_modules'), 'dir');
    const context = {
      ...f.context,
      prepareCommit: () => f.services.git.prepareCommit(f.repo, { sharedIgnored: ['node_modules'], source }),
    };
    const result = await f.finish(await f.manager.start(context, randomUUID(), true));
    assert.equal(result.status, 'succeeded', result.error);
    assert.deepEqual(result.exclusions, []);
    assert.equal(result.commits.length, 0);
    assert.equal(f.calls, 0);
    assert.equal(result.pushOperation.status, 'succeeded');
  }));
test('duplicate clicks, request replay and subdirectory aliases do not draft or commit twice', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.repo, 'file'), 'work\n');
    mkdirSync(join(f.repo, 'subdir'));
    let unblock;
    const waiting = new Promise((resolve) => {
      unblock = resolve;
    });
    let calls = 0;
    f.manager.proposeCommits = async (input) => {
      calls++;
      await waiting;
      return { commits: [{ message: 'change', paths: input.files.map((file) => file.path) }] };
    };
    const id = randomUUID();
    const [first, second] = await Promise.all([
      f.manager.start(f.context, id, false),
      f.manager.start({ ...f.context, path: join(f.repo, 'subdir') }, randomUUID(), false),
    ]);
    assert.equal(first.id, second.id);
    unblock();
    assert.equal((await f.finish(first)).status, 'succeeded');
    assert.equal(calls, 1);
    assert.equal((await f.manager.start(f.context, id, false)).status, 'succeeded');
    assert.equal(git(f.repo, 'rev-list', '--count', 'HEAD'), '2');
  }));
test('concurrent edits after inference invalidate the snapshot without creating a commit', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.repo, 'file'), 'first\n');
    const before = git(f.repo, 'rev-parse', 'HEAD');
    f.manager.proposeCommits = async () => {
      writeFileSync(join(f.repo, 'file'), 'human changed it\n');
      return { commits: [{ message: 'change', paths: ['file'] }] };
    };
    const result = await f.finish(await f.manager.start(f.context, randomUUID(), false));
    assert.equal(result.status, 'failed');
    assert.match(result.error, /obsolète/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
    assert.equal(readFileSync(join(f.repo, 'file'), 'utf8'), 'human changed it\n');
  }));
test('a resolved merge still in progress blocks the automatic commit without calling the model', async () =>
  fixture(async (f) => {
    git(f.repo, 'checkout', '-q', '-b', 'target');
    writeFileSync(join(f.repo, 'file'), 'target\n');
    git(f.repo, 'commit', '-qam', 'target');
    git(f.repo, 'checkout', '-q', 'main');
    writeFileSync(join(f.repo, 'file'), 'main\n');
    git(f.repo, 'commit', '-qam', 'main');
    assert.throws(() => git(f.repo, 'merge', '--no-ff', '--no-commit', 'target'));
    writeFileSync(join(f.repo, 'file'), 'resolved\n');
    git(f.repo, 'add', 'file');
    const before = git(f.repo, 'rev-parse', 'HEAD');
    const result = await f.finish(await f.manager.start(f.context, randomUUID(), false));
    assert.equal(result.status, 'blocked');
    assert.match(result.error, /Opération Git en cours/);
    assert.equal(f.calls, 0);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
    assert.ok(existsSync(join(f.repo, '.git/MERGE_HEAD')));
  }));
test('an index.lock taken by an external git during drafting blocks the automatic commit instead of failing it', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.repo, 'file'), 'work\n');
    const before = git(f.repo, 'rev-parse', 'HEAD');
    const lock = join(f.repo, '.git/index.lock');
    f.manager.proposeCommits = async (input) => {
      writeFileSync(lock, '');
      return { commits: [{ message: 'feat: work', paths: input.files.map((file) => file.path) }] };
    };
    const result = await f.finish(await f.manager.start(f.context, randomUUID(), false));
    assert.equal(result.status, 'blocked');
    assert.equal(result.error, 'Une autre opération Git est en cours (index.lock) : réessayez.');
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
    assert.ok(existsSync(lock));
  }));
test('an index.lock taken by an external git between two commits fails the automatic commit with the commits already created', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.repo, 'file'), 'work\n');
    writeFileSync(join(f.repo, 'new'), 'new\n');
    const before = git(f.repo, 'rev-parse', 'HEAD');
    const lock = join(f.repo, '.git/index.lock');
    f.manager.proposeCommits = async () => ({
      commits: [
        { message: 'feat: first', paths: ['file'] },
        { message: 'feat: second', paths: ['new'] },
      ],
    });
    const original = fsPromises.rename;
    fsPromises.rename = async (from, to) => {
      await original(from, to);
      if (to === join(f.repo, '.git/index')) writeFileSync(lock, '', { flag: 'wx' });
    };
    syncBuiltinESMExports();
    let result;
    try {
      result = await f.finish(await f.manager.start(f.context, randomUUID(), false, undefined, 'atomic'));
    } finally {
      fsPromises.rename = original;
      syncBuiltinESMExports();
    }
    assert.equal(result.status, 'failed');
    assert.match(result.error, /Plan appliqué partiellement : 1 commit\(s\) sur 2/);
    assert.doesNotMatch(result.error, /réessayez/);
    assert.equal(result.commits.length, 1);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD^'), before);
    assert.equal(git(f.repo, 'log', '-1', '--format=%s'), 'feat: first');
  }));
test('an active commit can only be reused by an action requesting the same strategy', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.repo, 'file'), 'work\n');
    let unblock;
    const waiting = new Promise((resolve) => {
      unblock = resolve;
    });
    f.manager.proposeCommits = async (input) => {
      await waiting;
      return { commits: [{ message: 'change', paths: input.files.map((file) => file.path) }] };
    };
    const id = randomUUID();
    const first = await f.manager.start(f.context, id, false, undefined, 'atomic');
    try {
      const same = await f.manager.start(f.context, randomUUID(), false, undefined, 'atomic');
      assert.equal(same.id, first.id);
      await assert.rejects(f.manager.start(f.context, randomUUID(), false, undefined, 'single'), /déjà en préparation/);
      await assert.rejects(f.manager.start(f.context, id, false, undefined, 'single'), /autre action/);
    } finally {
      unblock();
    }
    assert.equal((await f.finish(first)).status, 'succeeded');
  }));
test('new requests use the effective strategy while recorded requests remain idempotent', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.repo, 'file'), 'work\n');
    writeFileSync(join(f.repo, 'second'), 'work\n');
    let unblock;
    const waiting = new Promise((resolve) => {
      unblock = resolve;
    });
    f.manager.proposeCommits = async (input) => {
      await waiting;
      return { commits: input.files.map((file) => ({ message: `change ${file.path}`, paths: [file.path] })) };
    };
    const id = randomUUID();
    const otherId = randomUUID();
    const first = await f.manager.start(f.context, id, false, undefined, 'atomic');
    try {
      assert.equal(f.context.settings.strategy, 'single');
      await assert.rejects(f.manager.start(f.context, otherId, false), /déjà en préparation/);
      assert.equal(
        f.db.connection.prepare('SELECT operation_id FROM automatic_commit_requests WHERE id=?').get(otherId),
        undefined,
      );
      assert.equal((await f.manager.start(f.context, id, false)).id, first.id);
      const matching = { ...f.context, settings: { ...f.context.settings, strategy: 'atomic' } };
      assert.equal((await f.manager.start(matching, otherId, false)).id, first.id);
      assert.equal((await f.manager.start(f.context, otherId, false)).id, first.id);
    } finally {
      unblock();
    }
    const result = await f.finish(first);
    assert.equal(result.status, 'succeeded', result.error);
    assert.equal(result.commits.length, 2);
    await f.restart();
    for (const requestId of [id, otherId]) {
      const replay = await f.manager.start(f.context, requestId, false);
      assert.equal(replay.id, first.id);
      assert.equal(replay.status, 'succeeded');
      assert.equal(replay.settings.strategy, 'atomic');
    }
    assert.equal(git(f.repo, 'rev-list', '--count', 'HEAD'), '3');
  }));
test('scanners exclude suspicious files and the model only sees eligible diffs', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.repo, 'file'), 'safe\n');
    writeFileSync(join(f.repo, '.env'), 'TOKEN=do-not-send\n');
    f.manager.proposeCommits = async (input) => {
      assert.deepEqual(
        input.files.map((file) => file.path),
        ['file'],
      );
      assert.ok(!JSON.stringify(input).includes('do-not-send'));
      return { commits: [{ message: 'safe change', paths: ['file'] }] };
    };
    const result = await f.finish(await f.manager.start(f.context, randomUUID(), false));
    assert.equal(result.status, 'succeeded');
    assert.equal(result.exclusions[0].path, '.env');
    assert.equal(existsSync(join(f.repo, '.env')), true);
    assert.equal(git(f.repo, 'status', '--porcelain'), '?? .env');
  }));
test('a reviewed diff lifts its warning only while unchanged, and never for a detected secret', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.repo, 'notes.log'), 'reviewed\n');
    writeFileSync(join(f.repo, 'stale.log'), 'shown\n');
    writeFileSync(join(f.repo, 'key.txt'), `sk-${'a'.repeat(40)}\n`);
    const shown = await f.services.git.prepareCommit(f.repo);
    writeFileSync(join(f.repo, 'stale.log'), 'edited after review\n');
    const reviewed = { snapshotId: shown.id, paths: ['notes.log', 'stale.log', 'key.txt'] };
    const result = await f.finish(await f.manager.start(f.context, randomUUID(), false, reviewed));
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.files, ['notes.log']);
    assert.equal(git(f.repo, 'show', '--format=', '--name-only', 'HEAD'), 'notes.log');
    assert.match(result.exclusions.find((file) => file.path === 'stale.log').reason, /Modifié depuis votre examen/);
    assert.match(result.exclusions.find((file) => file.path === 'key.txt').reason, /Secret détecté/);
    await assert.rejects(
      f.manager.start(f.context, randomUUID(), false, { snapshotId: shown.id, paths: 'notes.log' }),
      /examinés invalide/,
    );
  }));
test('a detected secret is committed only on its own override of the exact diff shown', async () =>
  fixture(async (f) => {
    const token = `sk-proj-${'0123456789abcdefghijklmnopqrstuvwxyz'}`;
    writeFileSync(join(f.repo, 'key.txt'), `API_KEY=${token}\n`);
    writeFileSync(join(f.repo, '.env'), `OPENAI=${token}\n`);
    const shown = await f.services.git.prepareCommit(f.repo);
    const key = shown.files.find((file) => file.path === 'key.txt');
    assert.equal(key.blocked, true);
    assert.deepEqual(key.secrets, [{ line: 1, kind: 'openai', excerpt: 'sk-p…wxyz' }]);
    assert.ok(!JSON.stringify(key.secrets).includes(token));
    let sent = '';
    f.manager.proposeCommits = async (input) => {
      sent = JSON.stringify(input);
      return { commits: [{ message: 'test: fixture token', paths: input.files.map((file) => file.path) }] };
    };
    // Reviewed as an ordinary warning only: still excluded, nothing sent to the model.
    let result = await f.finish(
      await f.manager.start(f.context, randomUUID(), false, { snapshotId: shown.id, paths: ['key.txt'] }),
    );
    assert.equal(result.status, 'blocked');
    assert.equal(sent, '');
    assert.deepEqual(result.overridden, []);
    assert.match(result.exclusions.find((file) => file.path === 'key.txt').reason, /dérogation absente/);
    // A file name warning needs both boxes: the override alone leaves `.env` out.
    result = await f.finish(
      await f.manager.start(f.context, randomUUID(), false, {
        snapshotId: shown.id,
        paths: [],
        secrets: ['key.txt', '.env'],
      }),
    );
    assert.equal(result.status, 'succeeded', result.error);
    assert.deepEqual(result.files, ['key.txt']);
    assert.deepEqual(result.overridden, ['key.txt']);
    assert.ok(sent.includes(token));
    assert.equal(git(f.repo, 'show', '--format=', '--name-only', 'HEAD'), 'key.txt');
    assert.match(result.exclusions.find((file) => file.path === '.env').reason, /Fichier pouvant contenir des secrets/);
    assert.doesNotMatch(result.exclusions.find((file) => file.path === '.env').reason, /Secret détecté/);
    assert.deepEqual(f.manager.get(result.id).overridden, ['key.txt']);
    // Edited after the review: excluded again.
    writeFileSync(join(f.repo, 'key.txt'), `API_KEY=${token}\nOTHER=${token}\n`);
    const before = git(f.repo, 'rev-parse', 'HEAD');
    result = await f.finish(
      await f.manager.start(f.context, randomUUID(), false, {
        snapshotId: shown.id,
        paths: ['.env'],
        secrets: ['key.txt', '.env'],
      }),
    );
    assert.deepEqual(result.overridden, ['.env']);
    assert.deepEqual(result.files, ['.env']);
    assert.match(result.exclusions.find((file) => file.path === 'key.txt').reason, /Modifié depuis votre examen/);
    assert.notEqual(git(f.repo, 'rev-parse', 'HEAD'), before);
    // Shown again, then the snapshot expires (a restart forgets every snapshot): excluded again.
    const again = await f.services.git.prepareCommit(f.repo);
    await f.restart();
    result = await f.finish(
      await f.manager.start(f.context, randomUUID(), false, { snapshotId: again.id, paths: [], secrets: ['key.txt'] }),
    );
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.overridden, []);
    assert.match(result.exclusions[0].reason, /Secret détecté : dérogation absente.*Examen expiré/);
    await assert.rejects(
      f.manager.start(f.context, randomUUID(), false, { snapshotId: again.id, paths: [], secrets: 'key.txt' }),
      /examinés invalide/,
    );
  }));
test('unknown session attribution requires intervention and never calls the model', async () =>
  fixture(async (f) => {
    const id = randomUUID();
    f.db.createSession(
      {
        id,
        projectId: f.project.id,
        agent: 'codex',
        mode: 'auto',
        model: null,
        effort: null,
        prompt: '',
        title: 'Legacy',
        status: 'exited',
        agentSessionId: 'fake',
      },
      'token',
    );
    writeFileSync(join(f.repo, 'file'), 'legacy work\n');
    const context = {
      ...f.context,
      scope: `sessions/${id}`,
      sessionId: id,
      prepareCommit: () => f.services.sessionGit.prepareCommit(id),
      execute: (plan) => f.services.sessionGit.executeCommit(id, plan),
    };
    const result = await f.finish(await f.manager.start(context, randomUUID(), true));
    assert.equal(result.status, 'blocked');
    assert.match(result.error, /en-tête du projet/);
    assert.equal(f.calls, 0);
    assert.equal(git(f.repo, 'rev-list', '--count', 'HEAD'), '1');
  }));
test('Git hooks are respected and existing staged files outside the selected scope are preserved', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.repo, 'file'), 'work\n');
    writeFileSync(join(f.repo, '.env'), 'local\n');
    git(f.repo, 'add', '.env');
    const indexBefore = git(f.repo, 'diff', '--cached', '--binary');
    writeFileSync(join(f.repo, '.git/hooks/pre-commit'), '#!/bin/sh\necho refused >&2\nexit 1\n', { mode: 0o755 });
    const result = await f.finish(await f.manager.start(f.context, randomUUID(), false));
    assert.equal(result.status, 'failed');
    assert.match(result.error, /refused/);
    assert.equal(git(f.repo, 'diff', '--cached', '--binary'), indexBefore);
    assert.equal(git(f.repo, 'rev-list', '--count', 'HEAD'), '1');
  }));
test('invalid proposal fails before mutation and atomic proposals execute in order', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.repo, 'file'), 'updated\n');
    writeFileSync(join(f.repo, 'new'), 'new\n');
    f.manager.proposeCommits = async () => ({ commits: [{ message: 'bad', paths: ['file', 'unknown'] }] });
    let result = await f.finish(await f.manager.start(f.context, randomUUID(), false));
    assert.equal(result.status, 'failed');
    assert.equal(git(f.repo, 'rev-list', '--count', 'HEAD'), '1');
    f.manager.proposeCommits = async () => ({
      commits: [
        { message: 'first', paths: ['file'] },
        { message: 'second', paths: ['new'] },
      ],
    });
    result = await f.finish(
      await f.manager.start(
        { ...f.context, settings: { ...f.context.settings, strategy: 'atomic' } },
        randomUUID(),
        false,
      ),
    );
    assert.equal(result.status, 'succeeded', result.error);
    assert.deepEqual(
      result.commits.map((commit) => commit.title),
      ['first', 'second'],
    );
  }));
test('cancellation interrupts preparation without committing, and restart does not replay actions', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.repo, 'file'), 'work\n');
    f.manager.proposeCommits = async (_input, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    const operation = await f.manager.start(f.context, randomUUID(), false);
    for (let i = 0; i < 500 && f.manager.get(operation.id).phase !== 'drafting'; i++) {
      assert.equal(f.manager.get(operation.id).status, 'running');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(f.manager.get(operation.id).phase, 'drafting');
    f.manager.cancel(operation.id);
    assert.equal((await f.finish(operation)).status, 'cancelled');
    assert.equal(git(f.repo, 'rev-list', '--count', 'HEAD'), '1');
    const fake = { ...operation, id: randomUUID(), status: 'running', phase: 'committing', finishedAt: null };
    f.db.connection.prepare('INSERT INTO automatic_commits VALUES (?,?)').run(fake.id, JSON.stringify(fake));
    await f.restart();
    assert.equal(f.manager.get(fake.id).status, 'interrupted');
    assert.equal(git(f.repo, 'rev-list', '--count', 'HEAD'), '1');
  }));
test('a failed push preserves the created commit and exposes remote errors', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.repo, 'file'), 'work\n');
    const result = await f.finish(await f.manager.start(f.context, randomUUID(), true));
    assert.equal(result.status, 'failed');
    assert.equal(result.commits.length, 1);
    assert.match(result.error, /remote/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), result.commits[0].hash);
  }));
test('project commit settings survive restart and session changes independently, including legacy migration', async () =>
  fixture(async (f) => {
    f.db.updateProject(f.project.id, { commitSettings: f.context.settings });
    f.db.setSessionDefaults(f.project.id, {
      agent: 'grok',
      model: null,
      effort: 'high',
      mode: 'auto',
      prompt: 'changed',
    });
    assert.deepEqual(f.db.getProject(f.project.id).commitSettings, f.context.settings);
    const filename = join(f.directory, 'legacy.sqlite');
    let legacy = new CerebroDatabase(filename);
    const project = legacy.createProject('Legacy', f.repo);
    legacy.setSessionDefaults(project.id, { agent: 'codex', model: 'model', effort: 'low', mode: 'auto', prompt: '' });
    legacy.connection.exec('ALTER TABLE projects DROP COLUMN commit_settings');
    legacy.close();
    legacy = new CerebroDatabase(filename);
    assert.deepEqual(legacy.getProject(project.id).commitSettings, {
      agent: 'codex',
      model: 'model',
      effort: 'low',
      strategy: 'single',
    });
    legacy.setSessionDefaults(project.id, { agent: 'claude', model: null, effort: null, mode: 'auto', prompt: '' });
    legacy.close();
    legacy = new CerebroDatabase(filename);
    assert.equal(legacy.getProject(project.id).commitSettings.agent, 'codex');
    legacy.close();
  }));
test('headless adapters pass model/effort and parse Claude, Codex and Grok output without real inference', async () => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const capture = join(root, 'capture.json');
  const script = `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);const input=fs.readFileSync(0,'utf8');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,input,cwd:process.cwd()}));const result={commits:[{message:'feat: meaningful message',paths:['file']}]};if(args[0]==='exec')fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));else if(args.includes('--prompt-file'))console.log(JSON.stringify({text:JSON.stringify(result),structuredOutput:result,stopReason:'end_turn',sessionId:'grok-session',requestId:'request'}));else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:result}));\n`;
  for (const agent of ['claude', 'codex', 'grok']) writeFileSync(join(bin, agent), script, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    for (const agent of ['claude', 'codex', 'grok']) {
      const result = await proposeCommits(
        {
          files: [{ path: 'file', diff: '+change', blocked: false, warnings: [], hunks: [] }],
          log: 'abc feat: example',
          settings: { agent, model: 'selected-model', effort: 'low', strategy: 'single' },
        },
        new AbortController().signal,
      );
      assert.equal(result.commits[0].message, 'feat: meaningful message');
      const sent = JSON.parse(readFileSync(capture, 'utf8'));
      assert.ok(sent.args.includes('selected-model'));
      assert.ok(sent.args.some((arg) => arg === 'low' || arg.includes('model_reasoning_effort="low"')));
      assert.match(sent.cwd, /cerebro-message-/);
      assert.equal(existsSync(sent.cwd), false);
      if (agent === 'codex') {
        assert.ok(sent.args.includes('read-only'));
        assert.ok(sent.args.includes('shell_tool'));
        assert.ok(sent.args.includes('--ephemeral'));
        assert.match(sent.input, /feat: example/);
      } else assert.ok(sent.args.includes('--tools'));
    }
  } finally {
    process.env.PATH = previous;
  }
});

test('headless read-only access lets each agent read the project and nothing else', async () => {
  const bin = mkdtempSync(join(root, 'read-only-bin-'));
  const project = mkdtempSync(join(root, 'read-only-project-'));
  const capture = join(bin, 'capture.json');
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['answer'],
    properties: { answer: { type: 'string' } },
  };
  const script = `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);const input=fs.readFileSync(0,'utf8');const result=JSON.parse(process.env.FAKE_RESULT);fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,input,cwd:process.cwd(),leaked:Object.keys(process.env).filter(key=>/^(CEREBRO_(SESSION_ID|TOKEN|URL)|CLAUDECODE)$/.test(key))}));if(args[0]==='exec')fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));else if(args.includes('--prompt-file'))console.log(JSON.stringify({structuredOutput:result,stopReason:'end_turn'}));else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:result}));\n`;
  for (const agent of ['claude', 'codex', 'grok']) writeFileSync(join(bin, agent), script, { mode: 0o755 });
  const saved = {
    PATH: process.env.PATH,
    CEREBRO_TOKEN: process.env.CEREBRO_TOKEN,
    CEREBRO_SESSION_ID: process.env.CEREBRO_SESSION_ID,
    CLAUDECODE: process.env.CLAUDECODE,
  };
  Object.assign(process.env, {
    PATH: `${bin}:${saved.PATH}`,
    CEREBRO_TOKEN: 'secret',
    CEREBRO_SESSION_ID: 'session',
    CLAUDECODE: '1',
  });
  const value = (args, flag) => args[args.indexOf(flag) + 1];
  try {
    for (const agent of ['claude', 'codex', 'grok']) {
      process.env.FAKE_RESULT = JSON.stringify({ answer: 'lu' });
      const run = (access) =>
        runHeadless({
          agent,
          model: 'm',
          effort: 'high',
          prompt: 'Que fait ce dépôt ?',
          schema,
          cwd: project,
          access,
          timeoutMs: 10_000,
          signal: new AbortController().signal,
        });
      assert.deepEqual(await run('read-only'), { answer: 'lu' });
      const { args, cwd, leaked } = JSON.parse(readFileSync(capture, 'utf8'));
      assert.equal(cwd, project);
      assert.deepEqual(leaked, []);
      if (agent === 'claude') {
        assert.equal(value(args, '--tools'), 'Read,Glob,Grep');
        assert.equal(value(args, '--permission-mode'), 'dontAsk');
        assert.equal(value(args, '--max-turns'), '30');
        assert.equal(value(args, '--setting-sources'), 'user');
        assert.equal(JSON.parse(value(args, '--settings')).disableAllHooks, true);
      } else if (agent === 'codex') {
        assert.equal(value(args, '--sandbox'), 'read-only');
        assert.ok(!args.includes('shell_tool'));
        assert.equal(sentInput(capture), 'Que fait ce dépôt ?');
      } else {
        assert.equal(value(args, '--tools'), 'Read,Glob,Grep');
        assert.ok(!args.includes('--deny'));
        assert.deepEqual(
          args.filter((_, i) => args[i - 1] === '--allow'),
          ['Read', 'Glob', 'Grep'],
        );
        assert.equal(value(args, '--permission-mode'), 'dontAsk');
        assert.equal(value(args, '--max-turns'), '30');
      }
      await run('none');
      const closed = JSON.parse(readFileSync(capture, 'utf8')).args;
      if (agent === 'codex') assert.ok(closed.includes('shell_tool'));
      else assert.equal(value(closed, '--tools'), '');
      if (agent === 'claude') {
        assert.equal(value(closed, '--setting-sources'), 'user');
        assert.equal(JSON.parse(value(closed, '--settings')).disableAllHooks, true);
      }
      if (agent === 'grok') assert.equal(value(closed, '--deny'), '*');
      process.env.FAKE_RESULT = JSON.stringify({ answer: 42 });
      await assert.rejects(run('read-only'), /non conforme au schéma \(\$\.answer/);
    }
  } finally {
    for (const [key, previous] of Object.entries(saved)) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    delete process.env.FAKE_RESULT;
  }
});
const sentInput = (capture) => JSON.parse(readFileSync(capture, 'utf8')).input;

test('Grok structured output and text fallback still require a complete valid proposal', async () => {
  const bin = mkdtempSync(join(root, 'grok-output-'));
  const previous = process.env.PATH;
  const proposal = { commits: [{ message: 'fix: retain conversation associations', paths: ['file'] }] };
  const context = {
    files: [{ path: 'file', diff: '+change', blocked: false, warnings: [], hunks: [] }],
    log: '',
    settings: { agent: 'grok', model: null, effort: null, strategy: 'single' },
  };
  process.env.PATH = `${bin}:${previous}`;
  try {
    const cases = [
      { output: { structuredOutput: proposal, text: '', stopReason: 'end_turn' } },
      { output: { text: JSON.stringify(proposal), stopReason: 'end_turn' } },
      { output: { text: '```json\n' + JSON.stringify(proposal) + '\n```', stopReason: 'end_turn' } },
      {
        output: { structuredOutput: proposal, text: JSON.stringify(proposal), stopReason: 'max_tokens' },
        error: /n’a pas terminé.*max_tokens/,
      },
      {
        output: {
          text: JSON.stringify({ commits: [{ message: 'wrong file', paths: ['unknown'] }] }),
          stopReason: 'end_turn',
        },
        error: /inconnu ou répété/,
      },
      {
        output: { type: 'result', subtype: 'error_max_turns', is_error: true, structured_output: proposal },
        error: /pas produit de proposition utilisable/,
      },
    ];
    for (const { output, error } of cases) {
      writeFileSync(
        join(bin, 'grok'),
        `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(output))});\n`,
        { mode: 0o755 },
      );
      const result = proposeCommits(context, new AbortController().signal);
      if (error) await assert.rejects(result, error);
      else assert.deepEqual(await result, proposal);
    }
  } finally {
    process.env.PATH = previous;
  }
});
test('a copy holding only content inherited from the project says there is nothing new to commit', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.repo, 'file'), 'uncommitted in the project\n');
    const id = randomUUID();
    f.db.createSession(
      {
        id,
        projectId: f.project.id,
        agent: 'codex',
        mode: 'auto',
        model: null,
        effort: null,
        prompt: '',
        title: 'Step',
        status: 'exited',
        agentSessionId: 'fake',
      },
      'token',
    );
    const workspace = await createWorkspace(f.db, id, f.project);
    const context = {
      ...f.context,
      scope: `sessions/${id}`,
      path: workspace.root,
      sessionId: id,
      prepareCommit: () => f.services.sessionGit.prepareCommit(id),
      execute: (plan) => f.services.sessionGit.executeCommit(id, plan),
    };
    const result = await f.finish(await f.manager.start(context, randomUUID(), false));
    assert.equal(result.status, 'blocked');
    assert.match(result.error, /Rien de nouveau à commiter/);
    assert.match(result.exclusions[0].reason, /inchangé depuis/);
    assert.equal(f.calls, 0);
  }));
