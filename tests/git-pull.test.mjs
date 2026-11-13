import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import * as react from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import { moduleRunnerTransform, transformWithOxc } from 'vite';
import * as sharedGit from '../shared/git.ts';
import * as sharedTypes from '../shared/types.ts';
import * as asyncAction from '../web/src/async-action.ts';
import * as format from '../web/src/format.ts';

const envRoot = mkdtempSync(join(tmpdir(), 'cerebro-git-pull-env-'));
process.env.HOME = envRoot;
process.env.CEREBRO_DATA_DIR = join(envRoot, 'data');
process.env.CODEX_HOME = join(envRoot, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;

const { CerebroDatabase } = await import('../server/db.ts');
const { GitPulls } = await import('../server/git-pull.ts');
const { GitPushes } = await import('../server/git-push.ts');
const { WorktreeGate } = await import('../server/worktree-gate.ts');

after(() => {
  mock.restoreAll();
  rmSync(envRoot, { recursive: true, force: true });
});

const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'cerebro-pull-'));
  const origin = join(root, 'origin');
  const repo = join(root, 'repo');
  const peer = join(root, 'peer');
  mkdirSync(origin);
  git(origin, 'init', '--bare', '-b', 'main');
  git(root, 'clone', origin, repo);
  for (const copy of [repo]) {
    git(copy, 'config', 'user.email', 'test@example.com');
    git(copy, 'config', 'user.name', 'Test');
  }
  writeFileSync(join(repo, 'file'), 'initial\n');
  git(repo, 'add', 'file');
  git(repo, 'commit', '-m', 'initial');
  git(repo, 'push', '-u', 'origin', 'main');
  git(root, 'clone', origin, peer);
  git(peer, 'config', 'user.email', 'peer@example.com');
  git(peer, 'config', 'user.name', 'Peer');
  const gate = new WorktreeGate();
  const pushes = new GitPushes(gate);
  const pulls = new GitPulls(gate, pushes);
  try {
    await run({ root, origin, repo, peer, gate, pushes, pulls });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function wait(op) {
  while (op.finishedAt === null) await new Promise((resolve) => setTimeout(resolve, 10));
  return op;
}

const integrity = (repo) => ({
  head: git(repo, 'rev-parse', 'HEAD'),
  index: readFileSync(join(repo, '.git/index')).toString('hex'),
  file: readFileSync(join(repo, 'file'), 'utf8'),
});

async function compile(relativePath) {
  const url = new URL(`../web/src/${relativePath}`, import.meta.url);
  const source = await readFile(url, 'utf8');
  const { code } = await transformWithOxc(source, url.pathname, { jsx: { runtime: 'automatic' } });
  const transformed = await moduleRunnerTransform(code, null, url.pathname, source);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('__vite_ssr_import__', '__vite_ssr_exportName__', transformed.code);
  return async (modules) => {
    const exports = {};
    await execute(
      (id) => {
        assert.ok(Object.hasOwn(modules, id), `Import inattendu : ${id}`);
        return modules[id];
      },
      (name, get) => Object.defineProperty(exports, name, { get }),
    );
    return exports;
  };
}

test('fast-forward pull updates HEAD, index and worktree, and repeat pull reports already up to date', async () =>
  fixture(async ({ repo, peer, pulls }) => {
    const before = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(peer, 'file'), 'depuis le remote\n');
    git(peer, 'commit', '-am', 'remote update');
    const remoteHead = git(peer, 'rev-parse', 'HEAD');
    git(peer, 'push');

    const op = sharedGit.parsePullOperation(await wait(await pulls.start(repo)));
    assert.equal(op.status, 'succeeded', JSON.stringify(op));
    assert.equal(op.branch, 'main');
    assert.equal(op.upstream, 'origin/main');
    assert.equal(op.beforeHead, before);
    assert.equal(op.afterHead, remoteHead);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), remoteHead);
    assert.equal(readFileSync(join(repo, 'file'), 'utf8'), 'depuis le remote\n');
    assert.equal((await pulls.current(repo))?.id, op.id);

    const again = await wait(await pulls.start(repo));
    assert.equal(again.status, 'succeeded', JSON.stringify(again));
    assert.equal(again.beforeHead, remoteHead);
    assert.equal(again.afterHead, remoteHead);
  }));

test('divergent branches fail cleanly without merge or rebase state, even with pull.rebase=true', async () =>
  fixture(async ({ repo, peer, pulls }) => {
    writeFileSync(join(peer, 'remote-only'), 'remote\n');
    git(peer, 'add', 'remote-only');
    git(peer, 'commit', '-m', 'remote commit');
    git(peer, 'push');

    writeFileSync(join(repo, 'local-only'), 'local\n');
    git(repo, 'add', 'local-only');
    git(repo, 'commit', '-m', 'local commit');
    git(repo, 'config', 'pull.rebase', 'true');
    const before = integrity(repo);

    const op = await wait(await pulls.start(repo));
    assert.equal(op.status, 'failed');
    assert.match(op.error ?? '', /Avance rapide impossible/);
    assert.deepEqual(integrity(repo), before);
    assert.equal(existsSync(join(repo, '.git/MERGE_HEAD')), false);
    assert.equal(existsSync(join(repo, '.git/rebase-merge')), false);
  }));

test('dirty worktree, untracked files, detached HEAD, missing upstream and active merge are rejected without mutations', async () =>
  fixture(async ({ repo, peer, pulls }) => {
    git(repo, 'config', 'pull.autostash', 'true');
    writeFileSync(join(peer, 'file'), 'remote\n');
    git(peer, 'commit', '-am', 'remote');
    git(peer, 'push');

    // Untracked file counts as a pending modification.
    writeFileSync(join(repo, 'untracked.txt'), 'draft\n');
    let before = integrity(repo);
    let op = await wait(await pulls.start(repo));
    assert.equal(op.status, 'failed');
    assert.match(op.error ?? '', /modifications en attente/);
    assert.deepEqual(integrity(repo), before);
    rmSync(join(repo, 'untracked.txt'));

    // Staged modification is rejected too.
    writeFileSync(join(repo, 'file'), 'staged\n');
    git(repo, 'add', 'file');
    before = integrity(repo);
    op = await wait(await pulls.start(repo));
    assert.equal(op.status, 'failed');
    assert.match(op.error ?? '', /modifications en attente/);
    assert.deepEqual(integrity(repo), before);
    git(repo, 'reset', '--hard', 'HEAD');

    // Detached HEAD is rejected.
    git(repo, 'checkout', '--detach', 'HEAD');
    op = await wait(await pulls.start(repo));
    assert.equal(op.status, 'failed');
    assert.equal(op.error, 'HEAD détachée : choisissez une branche.');
    git(repo, 'checkout', 'main');

    // Missing upstream is rejected.
    git(repo, 'branch', '--unset-upstream');
    op = await wait(await pulls.start(repo));
    assert.equal(op.status, 'failed');
    assert.match(op.error ?? '', /upstream/);
    git(repo, 'branch', '--set-upstream-to=origin/main', 'main');

    // Active Git operation (MERGE_HEAD) is rejected.
    writeFileSync(join(repo, '.git/MERGE_HEAD'), `${git(repo, 'rev-parse', 'HEAD')}\n`);
    op = await wait(await pulls.start(repo));
    assert.equal(op.status, 'failed');
    assert.match(op.error ?? '', /Opération Git en cours/);
    rmSync(join(repo, '.git/MERGE_HEAD'));
  }));

test('concurrent starts share the same operation, gate locks overlap, and busy sessions block pulling', async () =>
  fixture(async ({ root, repo, gate, pushes }) => {
    const db = new CerebroDatabase(join(root, 'cerebro.db'));
    try {
      const pulls = new GitPulls(gate, pushes, db);
      const project = db.createProject('Pull test', repo, 'shared');
      const [first, second] = await Promise.all([pulls.start(repo), pulls.start(repo)]);
      assert.equal(first.id, second.id);
      await wait(first);
      assert.equal(first.status, 'succeeded');

      // A busy session working in the project folder blocks pulling; once idle, pulling is allowed again.
      db.createSession(
        {
          id: 's-busy',
          projectId: project.id,
          agent: 'claude',
          mode: 'auto',
          model: null,
          effort: null,
          prompt: 'travail',
          title: 'Session active',
          status: 'running',
          agentSessionId: null,
        },
        'tok',
      );
      const blocked = await wait(await pulls.start(repo));
      assert.equal(blocked.status, 'failed');
      assert.match(blocked.error ?? '', /Une session utilise encore ce dépôt/);

      db.updateSession('s-busy', { status: 'idle' });
      const allowed = await wait(await pulls.start(repo));
      assert.equal(allowed.status, 'succeeded');

      // An external WorktreeGate lease refuses starting a pull.
      const release = gate.lock([repo]);
      await assert.rejects(() => pulls.start(repo), /Une opération Git utilise cet espace de travail/);
      release();
    } finally {
      db.close();
    }
  }));

test('a throwing completion listener is logged and does not stop subsequent listeners', async () =>
  fixture(async ({ repo, pulls }) => {
    const unhandled = [];
    const onUnhandled = (cause) => unhandled.push(cause);
    process.on('unhandledRejection', onUnhandled);
    const logged = [];
    const originalError = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    const calls = [];
    const offFailing = pulls.onComplete(() => {
      throw new Error('listener pull cassé');
    });
    const offNext = pulls.onComplete((_path, op) => calls.push(op.id));
    try {
      const op = await wait(await pulls.start(repo));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(op.status, 'succeeded');
      assert.deepEqual(calls, [op.id]);
      assert.deepEqual(unhandled, []);
      assert.ok(logged.some((line) => /listener pull cassé/.test(line)));
    } finally {
      offFailing();
      offNext();
      console.error = originalError;
      process.off('unhandledRejection', onUnhandled);
    }
  }));

test('project pull API endpoints run fast-forward pull and expose current operation', async () =>
  fixture(async ({ repo, peer }) => {
    const { UpdateManager } = await import('../server/updates.ts');
    const { PeerSync } = await import('../server/peers.ts');
    const { buildServer } = await import('../server/index.ts');
    mock.method(UpdateManager.prototype, 'start', () => {});
    mock.method(PeerSync.prototype, 'sync', async function () {
      this.markReady();
      this.markSynced();
    });

    writeFileSync(join(peer, 'file'), 'via-api\n');
    git(peer, 'commit', '-am', 'via api');
    const expectedHead = git(peer, 'rev-parse', 'HEAD');
    git(peer, 'push');

    const app = await buildServer();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Pull API', path: repo },
      });
      assert.equal(created.statusCode, 201);
      const id = created.json().id;

      assert.equal((await app.inject({ method: 'GET', url: '/api/projects/inconnu/git/pull' })).statusCode, 404);
      assert.equal((await app.inject({ method: 'POST', url: '/api/projects/inconnu/git/pull' })).statusCode, 404);
      assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${id}/git/pull` })).json(), null);

      const started = await app.inject({ method: 'POST', url: `/api/projects/${id}/git/pull` });
      assert.equal(started.statusCode, 202);

      let current = sharedGit.parseOptionalPullOperation(started.json());
      while (current && current.finishedAt === null) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        const polled = await app.inject({ method: 'GET', url: `/api/projects/${id}/git/pull` });
        assert.equal(polled.statusCode, 200);
        current = sharedGit.parseOptionalPullOperation(polled.json());
      }
      assert.equal(current?.status, 'succeeded', JSON.stringify(current));
      assert.equal(current?.afterHead, expectedHead);
      assert.equal(readFileSync(join(repo, 'file'), 'utf8'), 'via-api\n');
    } finally {
      await app.close();
    }
  }));

test('desktop GitActions, PullDialog and mobile ProjectGit reflect repository state and pull results', async () => {
  const stub = () => null;
  const { GitActions } = await (
    await compile('GitActions.tsx')
  )({
    react,
    'react/jsx-runtime': jsx,
    './SessionIcons.tsx': { CommitPushIcon: stub, ReviewIcon: stub },
    './ActivityStatus.tsx': { ActivityStatus: ({ children }) => children },
    './api.ts': { api: async () => null, apiParsed: async () => null, apiPath: () => '', markOperationSeen: stub },
    './async-action.ts': asyncAction,
    './Dialog.tsx': {
      LaunchDialog: stub,
      Modal: ({ title, children }) => react.createElement('div', { 'data-modal': title }, children),
      usePrepared: () => ({ value: null, error: null }),
    },
    './store.tsx': {
      useStore: () => ({ projects: [{ id: 'p1', autoPush: false }], sessions: [], updateProject: async () => {} }),
    },
    '../../shared/types.ts': sharedTypes,
    './automatic-commits.css': {},
    './AutomaticCommitDialog.tsx': { AutomaticCommitDialog: stub },
    './format.ts': format,
    './polling.tsx': { usePolling: () => async () => {} },
    '../../shared/git.ts': sharedGit,
  });

  const cleanGit = {
    repository: true,
    branch: 'main',
    dirty: 0,
    ahead: 0,
    hasCommits: true,
    hasUpstream: true,
  };
  const cleanHtml = renderToStaticMarkup(
    react.createElement(GitActions, { projectId: 'p1', git: cleanGit, changes: '0 fichiers', pendingCommits: null }),
  );
  assert.match(
    cleanHtml,
    /<button type="button" class="btn" title="Tirer les commits de l’upstream[^"]*">Pull<\/button>/,
  );
  assert.match(cleanHtml, /<button type="button" class="btn" disabled="" title="Rien à pousser">Push<\/button>/);

  const dirtyHtml = renderToStaticMarkup(
    react.createElement(GitActions, {
      projectId: 'p1',
      git: { ...cleanGit, dirty: 2 },
      changes: '2 fichiers',
      pendingCommits: null,
    }),
  );
  assert.match(
    dirtyHtml,
    /<button type="button" class="btn" disabled="" title="Modifications en attente : commitez ou annulez-les avant de tirer">Pull<\/button>/,
  );

  const noUpstreamHtml = renderToStaticMarkup(
    react.createElement(GitActions, {
      projectId: 'p1',
      git: { ...cleanGit, hasUpstream: false },
      changes: '0 fichiers',
      pendingCommits: null,
    }),
  );
  assert.match(
    noUpstreamHtml,
    /<button type="button" class="btn" disabled="" title="Pas d’upstream configuré pour cette branche">Pull<\/button>/,
  );

  const compiledMobile = await compile('mobile/MobileGit.tsx');
  const renderMobile = async (gitState) => {
    let callIndex = 0;
    const mod = await compiledMobile({
      react: {
        ...react,
        useState: (initial) => {
          const idx = callIndex++;
          return [idx === 0 ? gitState : initial, () => {}];
        },
      },
      'react/jsx-runtime': jsx,
      '../api.ts': { api: async () => null, apiPath: () => '' },
      '../async-action.ts': asyncAction,
      '../AutomaticCommitDialog.tsx': { AutomaticCommitDialog: stub },
      '../format.ts': format,
      '../GitActions.tsx': {
        PullDialog: stub,
        PushDialog: stub,
        useSessionGitContext: () => ({ context: null, error: null }),
      },
      '../GitStatus.tsx': { DirtyFileList: stub },
      '../polling.tsx': { usePolling: () => async () => {} },
      '../store.tsx': { useStore: () => ({ updateProject: async () => {} }) },
      '../../../shared/types.ts': sharedTypes,
    });
    return renderToStaticMarkup(react.createElement(mod.ProjectGit, { project: { id: 'p1', autoPush: false } }));
  };

  const mobileClean = await renderMobile(cleanGit);
  assert.match(mobileClean, /<button type="button" class="m-button">Pull<\/button>/);
  assert.match(mobileClean, /<button type="button" class="m-button" disabled="">Push<\/button>/);

  const mobileDirty = await renderMobile({ ...cleanGit, dirty: 1 });
  assert.match(mobileDirty, /<button type="button" class="m-button" disabled="">Pull<\/button>/);
  assert.match(mobileDirty, /Modifications en attente : commitez ou annulez-les avant de tirer\./);

  // PullDialog states (updated vs already up to date).
  const compiledGitActions = await compile('GitActions.tsx');
  const renderPullDialog = async (opState) => {
    let callIndex = 0;
    const mod = await compiledGitActions({
      react: {
        ...react,
        useState: (initial) => {
          const idx = callIndex++;
          return [idx === 0 ? opState : initial, () => {}];
        },
      },
      'react/jsx-runtime': jsx,
      './SessionIcons.tsx': { CommitPushIcon: stub, ReviewIcon: stub },
      './ActivityStatus.tsx': { ActivityStatus: ({ children }) => children },
      './api.ts': { api: async () => null, apiParsed: async () => null, apiPath: () => '', markOperationSeen: stub },
      './async-action.ts': asyncAction,
      './Dialog.tsx': {
        LaunchDialog: stub,
        Modal: ({ title, children }) => react.createElement('div', { 'data-modal': title }, children),
        usePrepared: () => ({ value: null, error: null }),
      },
      './store.tsx': { useStore: () => ({ projects: [], sessions: [], updateProject: async () => {} }) },
      '../../shared/types.ts': sharedTypes,
      './automatic-commits.css': {},
      './AutomaticCommitDialog.tsx': { AutomaticCommitDialog: stub },
      './format.ts': format,
      './polling.tsx': { usePolling: () => async () => {} },
      '../../shared/git.ts': sharedGit,
    });
    return renderToStaticMarkup(react.createElement(mod.PullDialog, { projectId: 'p1', onClose: stub }));
  };

  const updatedDialog = await renderPullDialog({
    id: 'op-1',
    branch: 'main',
    upstream: 'origin/main',
    beforeHead: '11111111aaaa',
    afterHead: '22222222bbbb',
    status: 'succeeded',
    startedAt: 1,
    finishedAt: 2,
    error: null,
    exitCode: 0,
    output: 'Fast-forward\n',
  });
  assert.match(updatedDialog, /Projet mis à jour\./);
  assert.match(updatedDialog, /Branche main ← origin\/main · 11111111 → 22222222/);
  assert.match(updatedDialog, /Fast-forward/);

  const upToDateDialog = await renderPullDialog({
    id: 'op-2',
    branch: 'main',
    upstream: 'origin/main',
    beforeHead: '11111111aaaa',
    afterHead: '11111111aaaa',
    status: 'succeeded',
    startedAt: 1,
    finishedAt: 2,
    error: null,
    exitCode: 0,
    output: 'Already up to date.\n',
  });
  assert.match(upToDateDialog, /Déjà à jour\./);
});
