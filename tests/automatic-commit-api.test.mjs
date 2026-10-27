import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-auto-api-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
const { AutomaticCommits } = await import('../server/automatic-commits.ts');
const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');
const { parseProject } = await import('../shared/types.ts');
mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});
let sessions = 0;
mock.method(SessionManager.prototype, 'launch', async () => {
  sessions++;
  throw new Error('No interactive session expected');
});
const inputs = [];
mock.method(AutomaticCommits.prototype, 'proposeCommits', async (context) => {
  inputs.push(context);
  return {
    commits:
      context.settings.strategy === 'atomic'
        ? context.files.map((file) => ({ message: `feat: update ${file.path}`, paths: [file.path] }))
        : [{ message: 'feat: requested behavior', paths: context.files.map((file) => file.path) }],
  };
});
const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});
test('project API stores independent commit settings and one-click execution uses exactly those settings', async () => {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  let app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    const created = await send('POST', '/api/projects', { name: 'Automatic', path: repo });
    assert.equal(created.statusCode, 201);
    const project = created.json();
    const url = `/api/projects/${project.id}`;
    assert.equal(parseProject(project).workspaceMode, 'isolated');
    assert.equal((await send('PATCH', url, { workspaceMode: 'shared' })).json().workspaceMode, 'shared');
    for (const value of [null, 'unknown', true])
      assert.equal((await send('PATCH', url, { workspaceMode: value })).statusCode, 400);
    const settings = { agent: 'claude', model: 'sonnet', effort: 'low', strategy: 'single' };
    let response = await send('PATCH', url, { commitSettings: settings });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(parseProject(response.json()).commitSettings, settings);
    response = await send('PATCH', url, { sessionDefaults: { agent: 'codex', model: null, effort: 'high' } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().commitSettings, settings);
    for (const invalid of [
      null,
      { agent: 'unknown' },
      { model: 'unknown-model' },
      { effort: 'ultra' },
      { strategy: 'arbitrary' },
      { mode: 'bypass' },
    ])
      assert.equal((await send('PATCH', url, { commitSettings: invalid })).statusCode, 400);
    writeFileSync(join(repo, 'file'), 'implemented\n');
    const requestId = randomUUID();
    const legacyId = randomUUID();
    const db = new CerebroDatabase();
    db.createSession(
      {
        id: legacyId,
        projectId: project.id,
        agent: 'codex',
        mode: 'auto',
        model: null,
        effort: null,
        prompt: '',
        title: 'Shared conversation',
        status: 'exited',
        agentSessionId: 'fake',
      },
      'token',
    );
    db.close();
    const location = await send('GET', `/api/sessions/${legacyId}/git/context`);
    assert.equal(location.statusCode, 200);
    assert.deepEqual(location.json(), { mode: 'shared', projectId: project.id, projectName: 'Automatic', path: repo });
    assert.equal(inputs.length, 0);
    assert.equal(sessions, 0);
    response = await send('POST', `${url}/git/auto-commit`, { requestId, push: false });
    assert.equal(response.statusCode, 202);
    const operationId = response.json().id;
    let result;
    for (let i = 0; i < 300; i++) {
      result = (await send('GET', `/api/git/auto-commits/${operationId}`)).json();
      if (result.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(result.status, 'succeeded', result.error);
    assert.deepEqual(inputs.at(-1).settings, settings);
    assert.equal(result.commits[0].title, 'feat: requested behavior');
    assert.equal(sessions, 0);
    assert.equal((await send('POST', `${url}/git/auto-commit`, { requestId, push: false })).json().id, operationId);
    assert.equal(inputs.length, 1);
    await app.close();
    app = await buildServer();
    const projects = (await send('GET', '/api/projects')).json();
    assert.deepEqual(projects.find((item) => item.id === project.id).commitSettings, settings);
    assert.equal(parseProject(projects.find((item) => item.id === project.id)).workspaceMode, 'shared');
    assert.equal((await send('GET', `/api/git/auto-commits/${operationId}`)).json().status, 'succeeded');
    response = await send('PATCH', url, { commitSettings: { agent: 'grok' } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().commitSettings, {
      agent: 'grok',
      model: null,
      effort: 'high',
      strategy: 'single',
    });
  } finally {
    await app.close();
  }
});

test('each commit action overrides the project strategy for that operation only', async () => {
  const repo = join(root, 'strategies');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'first'), 'base\n');
  writeFileSync(join(repo, 'second'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    const project = (await send('POST', '/api/projects', { name: 'Strategies', path: repo })).json();
    const url = `/api/projects/${project.id}`;
    for (const strategy of ['atomic', 'single']) {
      // Réglages explicites : le défaut Cerebro (opus, effort high) est enregistré à la place de null.
      const defaults = {
        ...project.commitSettings,
        model: 'opus',
        effort: 'high',
        strategy: strategy === 'single' ? 'atomic' : 'single',
      };
      assert.equal((await send('PATCH', url, { commitSettings: defaults })).statusCode, 200);
      writeFileSync(join(repo, 'first'), `${strategy}\n`);
      writeFileSync(join(repo, 'second'), `${strategy}\n`);
      const requestId = randomUUID();
      const response = await send('POST', `${url}/git/auto-commit`, { requestId, push: false, strategy });
      assert.equal(response.statusCode, 202);
      const id = response.json().id;
      // Git takes 1 to 3 s here; wait on a deadline rather than a fixed count of polls.
      let result;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        result = (await send('GET', `/api/git/auto-commits/${id}`)).json();
        if (result.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(result.status, 'succeeded', result.error);
      assert.equal(result.commits.length, strategy === 'single' ? 1 : 2);
      assert.equal(result.pushOperation, null);
      assert.deepEqual(inputs.at(-1).settings, { ...defaults, strategy });
      const projects = (await send('GET', '/api/projects')).json();
      assert.deepEqual(projects.find((item) => item.id === project.id).commitSettings, defaults);
      assert.equal((await send('POST', `${url}/git/auto-commit`, { requestId, push: false, strategy })).json().id, id);
      assert.equal(
        (await send('POST', `${url}/git/auto-commit`, { requestId, push: false, strategy: defaults.strategy }))
          .statusCode,
        409,
      );
    }
    for (const strategy of ['invalid', null, true]) {
      const response = await send('POST', `${url}/git/auto-commit`, { requestId: randomUUID(), push: false, strategy });
      assert.equal(response.statusCode, 409);
      assert.match(response.json().error, /Stratégie de commit invalide/);
    }
  } finally {
    await app.close();
  }
});
