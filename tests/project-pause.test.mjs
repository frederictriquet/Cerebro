import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, mock, test } from 'node:test';
import * as react from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import { moduleRunnerTransform, transformWithOxc } from 'vite';
import * as asyncAction from '../web/src/async-action.ts';
import * as format from '../web/src/format.ts';

const root = mkdtempSync(join(tmpdir(), 'cerebro-project-pause-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
mkdirSync(process.env.CEREBRO_DATA_DIR, { recursive: true });
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;

const { CerebroDatabase } = await import('../server/db.ts');
const { AutoFetch } = await import('../server/git-fetch.ts');
const { GitPulls } = await import('../server/git-pull.ts');
const { GitPushes } = await import('../server/git-push.ts');
const { WorktreeGate } = await import('../server/worktree-gate.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');
const { parseProject, parseProjectGitMap } = await import('../shared/types.ts');
const { machineHash } = await import('../web/src/route.ts');

mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});
after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

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

const pausedIds = (projects) => projects.filter((project) => project.paused).map((project) => project.id);
const pinnedIds = (projects) => projects.filter((project) => project.pinned).map((project) => project.id);

test('migration initialise paused à faux, et pause / épingle s’excluent mutuellement', () => {
  const dbPath = join(root, 'migration.db');
  let db = new CerebroDatabase(dbPath);
  const first = db.createProject('Premier', root);
  assert.equal(first.paused, false);
  db.close();

  const legacy = new DatabaseSync(dbPath);
  legacy.exec('ALTER TABLE projects DROP COLUMN paused');
  legacy.close();

  db = new CerebroDatabase(dbPath);
  try {
    assert.equal(db.getProject(first.id).paused, false);
    const second = db.createProject('Second', root);

    // Épingler puis mettre en pause retire l'épingle.
    db.setProjectPinned(first.id, true);
    assert.deepEqual(pinnedIds(db.listProjects()), [first.id]);
    assert.deepEqual(pausedIds(db.setProjectPaused(first.id, true)), [first.id]);
    assert.deepEqual(pinnedIds(db.listProjects()), []);

    // Épingler un projet en pause le sort automatiquement de pause.
    assert.deepEqual(pinnedIds(db.setProjectPinned(first.id, true)), [first.id]);
    assert.deepEqual(pausedIds(db.listProjects()), []);

    // Modifier ou réordonner conserve l'état en pause.
    db.setProjectPaused(second.id, true);
    assert.equal(db.updateProject(second.id, { name: 'Second renommé' }).paused, true);
    assert.deepEqual(
      db.reorderProjects([second.id, first.id]).map((project) => [project.id, project.paused]),
      [
        [second.id, true],
        [first.id, false],
      ],
    );
    assert.equal(db.setProjectPaused('inconnu', true), null);

    // Compatibilité avec une machine antérieure sans champ paused.
    const { paused: ignored, ...oldPayload } = db.getProject(second.id);
    assert.equal(parseProject(oldPayload).paused, false);
    assert.equal(machineHash('mac', [{ id: 'p', pinned: true, paused: true }]), '#/m/mac/');
  } finally {
    db.close();
  }
});

test('AutoFetch coupe la surveillance des projets en pause, et lancer ou reprendre une session réactive le projet', async () => {
  const gitRoot = mkdtempSync(join(root, 'git-'));
  const origin = join(gitRoot, 'origin');
  const repo = join(gitRoot, 'repo');
  const peer = join(gitRoot, 'peer');
  mkdirSync(origin);
  git(origin, 'init', '--bare', '-b', 'main');
  git(gitRoot, 'clone', origin, repo);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file'), 'initial\n');
  git(repo, 'add', 'file');
  git(repo, 'commit', '-m', 'initial');
  const initialHead = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', '-u', 'origin', 'main');
  git(gitRoot, 'clone', origin, peer);
  git(peer, 'config', 'user.email', 'peer@example.com');
  git(peer, 'config', 'user.name', 'Peer');

  const gate = new WorktreeGate();
  const pushes = new GitPushes(gate);
  const pulls = new GitPulls(gate, pushes);

  const db = new CerebroDatabase();
  const project = db.createProject('En pause', repo, 'shared');
  db.setProjectPaused(project.id, true);

  let fetchSignals = 0;
  const autoFetch = new AutoFetch(db, pulls, pushes, () => {
    fetchSignals++;
  });

  writeFileSync(join(peer, 'file'), 'distant\n');
  git(peer, 'commit', '-am', 'commit distant');
  const remoteTip = git(peer, 'rev-parse', 'HEAD');
  git(peer, 'push');

  // Tant que le projet est en pause, AutoFetch ne contacte pas son remote.
  await autoFetch.tick();
  assert.equal(fetchSignals, 0);
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/main'), initialHead);
  await autoFetch.stop();
  db.close();

  const launchMock = mock.method(SessionManager.prototype, 'launch', async function (launchedProject, options) {
    const id = options.existingId ?? 'sess-paused-test';
    const existing = this.db.getSession(id);
    if (existing) {
      return this.db.updateSession(id, { status: 'running', exitCode: null });
    }
    return this.db.createSession(
      {
        id,
        projectId: launchedProject.id,
        agent: options.agent,
        mode: options.mode,
        model: options.tuning.model,
        effort: options.tuning.effort,
        prompt: options.prompt,
        title: 'Session test',
        status: 'running',
        agentSessionId: 'agent-123',
      },
      'tok',
      null,
    );
  });

  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    for (const bad of [{}, { paused: 'true' }, { paused: 1 }, { paused: null }]) {
      assert.equal((await send('PATCH', `/api/projects/${project.id}/pause`, bad)).statusCode, 400);
    }
    assert.equal((await send('PATCH', '/api/projects/inconnu/pause', { paused: true })).statusCode, 404);

    // En pause : absent de /api/projects/git.
    const behindWhilePaused = parseProjectGitMap((await send('GET', '/api/projects/git')).json());
    assert.equal(behindWhilePaused[project.id], undefined);

    // Lancer une session réactive automatiquement le projet.
    const created = await send('POST', `/api/projects/${project.id}/sessions`, {
      agent: 'claude',
      mode: 'auto',
      prompt: 'Reprendre le travail',
    });
    assert.equal(created.statusCode, 201);
    const afterCreate = (await send('GET', '/api/projects')).json();
    assert.deepEqual(pausedIds(afterCreate), []);

    // Une fois repris, le projet réapparaît dans /api/projects/git et AutoFetch peut tirer les refs.
    const dbCheck = new CerebroDatabase();
    try {
      const fetchOnceActive = new AutoFetch(dbCheck, pulls, pushes, () => {});
      await fetchOnceActive.tick();
      await fetchOnceActive.stop();
    } finally {
      dbCheck.close();
    }
    assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/main'), remoteTip);
    const behindActive = parseProjectGitMap((await send('GET', '/api/projects/git')).json());
    assert.equal(behindActive[project.id], 1);

    // Remettre en pause via l'API puis reprendre une session terminée réactive aussi le projet.
    const pausedAgain = await send('PATCH', `/api/projects/${project.id}/pause`, { paused: true });
    assert.equal(pausedAgain.statusCode, 200);
    assert.deepEqual(pausedIds(pausedAgain.json()), [project.id]);

    const tempDb = new CerebroDatabase();
    tempDb.updateSession('sess-paused-test', { status: 'exited', exitCode: 0 });
    tempDb.close();

    const resumed = await send('POST', '/api/sessions/sess-paused-test/resume');
    assert.equal(resumed.statusCode, 200);
    assert.deepEqual(pausedIds((await send('GET', '/api/projects')).json()), []);
  } finally {
    launchMock.mock.restore();
    await app.close();
  }
});

test('ProjectTabs masque les projets en pause, expose le compteur [⏸ N] avec alerte et garde l’onglet actif temporaire', async () => {
  const stub = () => null;
  const store = {
    projects: [
      { id: 'active', name: 'Actif', path: '/actif', color: null, paused: false },
      { id: 'paused-alert', name: 'Pause question', path: '/pause-q', color: '#e5484d', paused: true },
      { id: 'paused-quiet', name: 'Pause calme', path: '/pause-c', color: null, paused: true },
    ],
    sessions: [
      {
        id: 's-paused',
        projectId: 'paused-alert',
        agent: 'claude',
        title: 'Question en pause',
        status: 'waiting',
        attention: true,
        pendingFindings: 0,
        updatedAt: 1,
        worktree: null,
      },
    ],
    tasks: [],
    hasData: true,
    projectBehind: { active: 2, 'paused-alert': 5 },
    reorderProjects: async () => {},
    setProjectPaused: async () => {},
  };

  const { ProjectTabs } = await (
    await compile('ProjectTabs.tsx')
  )({
    react,
    'react/jsx-runtime': jsx,
    './Dialog.tsx': { Modal: stub },
    './format.ts': format,
    './NewProjectForm.tsx': { NewProjectForm: stub },
    './route.ts': { href: (path) => path, go() {} },
    './store.tsx': { useStore: () => store },
    './async-action.ts': asyncAction,
  });

  // Sur l'accueil : seul « Actif » est affiché comme onglet ; le bouton [⏸ 2] porte l'alerte waiting.
  const homeHtml = renderToStaticMarkup(react.createElement(ProjectTabs, { route: { kind: 'home' } }));
  assert.match(homeHtml, /href="#\/p\/active"/);
  assert.doesNotMatch(homeHtml, /href="#\/p\/paused-alert"/);
  assert.doesNotMatch(homeHtml, /href="#\/p\/paused-quiet"/);
  assert.match(homeHtml, /class="project-tab project-tab-paused-btn alert waiting"/);
  assert.match(homeHtml, /aria-label="Projets en pause \(2\)"/);

  // Quand on consulte un projet en pause (ou l'une de ses sessions), son onglet apparaît temporairement en style paused.
  const visitingPaused = renderToStaticMarkup(
    react.createElement(ProjectTabs, { route: { kind: 'session', sessionId: 's-paused' } }),
  );
  assert.match(visitingPaused, /class="project-tab colored paused active alert waiting"[^>]*href="#\/p\/paused-alert"/);
  assert.doesNotMatch(visitingPaused, /↓5/);
  assert.doesNotMatch(visitingPaused, /href="#\/p\/paused-quiet"/);

  // Sur mobile : ProjectList sépare les actifs et replie les projets en pause.
  const { ProjectList } = await (
    await compile('mobile/ProjectList.tsx')
  )({
    react,
    'react/jsx-runtime': jsx,
    '../format.ts': format,
    '../route.ts': { href: (path) => path },
    '../store.tsx': { useStore: () => store },
  });
  const mobileHtml = renderToStaticMarkup(react.createElement(ProjectList));
  assert.match(mobileHtml, /Actif/);
  assert.doesNotMatch(mobileHtml, /Pause calme/);
  assert.match(mobileHtml, /Projets en pause \(2\)/);
});

test('ProjectPause affiche le bouton de mise en pause ou la pastille de reprise', async () => {
  let navigated = null;
  const calls = [];
  const store = {
    setProjectPaused: async (id, value) => {
      calls.push([id, value]);
    },
  };
  const { ProjectPause } = await (
    await compile('ProjectPause.tsx')
  )({
    react,
    'react/jsx-runtime': jsx,
    './async-action.ts': asyncAction,
    './route.ts': {
      go: (target) => {
        navigated = target;
      },
    },
    './store.tsx': { useStore: () => store },
  });

  const activeHtml = renderToStaticMarkup(
    react.createElement(ProjectPause, {
      project: { id: 'p1', paused: false },
      onError() {},
    }),
  );
  assert.match(activeHtml, /aria-label="Mettre le projet en pause"/);

  const pausedHtml = renderToStaticMarkup(
    react.createElement(ProjectPause, {
      project: { id: 'p1', paused: true },
      onError() {},
    }),
  );
  assert.match(pausedHtml, /En pause · Reprendre/);
  assert.equal(navigated, null);
  assert.equal(calls.length, 0);
});
