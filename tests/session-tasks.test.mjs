import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, mock, test } from 'node:test';
import { promisify } from 'node:util';

const root = mkdtempSync(join(tmpdir(), 'cerebro-session-tasks-'));
process.env.HOME = root;
process.env.CODEX_HOME = join(root, 'codex');
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CEREBRO_BIND_TOKEN = 'browser-token';
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');
const { buildAgentCommand } = await import('../server/agents.ts');
mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});
mock.method(SessionManager.prototype, 'launch', async () => {
  throw new Error('No agent should be started');
});
after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

test('session tasks: CRUD, validation, authentication, persistence and lifecycle isolation', async () => {
  let app = await buildServer();
  let db = new CerebroDatabase();
  const project = db.createProject('Session tasks', root);
  for (const id of ['first', 'second']) {
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
        agentSessionId: id,
      },
      `${id}-token`,
    );
  }
  const send = (method, url, payload, headers = { 'x-cerebro-token': 'first-token' }) =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  const base = '/api/session-tasks/first';
  const browser = '/api/sessions/first/tasks';
  const auth = { authorization: 'Bearer browser-token' };
  try {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const url = ['PATCH', 'DELETE'].includes(method) ? `${base}/missing` : base;
      for (const headers of [{}, { 'x-cerebro-token': 'second-token' }, auth]) {
        assert.equal(
          (await send(method, url, method === 'POST' || method === 'PATCH' ? { title: 'No' } : undefined, headers))
            .statusCode,
          403,
        );
      }
    }
    assert.equal((await send('GET', browser)).statusCode, 401, 'session token is not browser authentication');
    assert.equal((await send('GET', '/api/sessions/missing/tasks', undefined, auth)).statusCode, 404);
    assert.deepEqual((await send('GET', base)).json(), []);
    for (const payload of [
      {},
      [],
      { title: '' },
      { title: ' ' },
      { title: 'x'.repeat(501) },
      { title: 'x', note: null },
      { title: 'x', note: 'x'.repeat(10001) },
      { title: 'x', status: 'started' },
      { title: 'x', sessionId: 'second' },
    ]) {
      assert.equal((await send('POST', base, payload)).statusCode, 400, JSON.stringify(payload).slice(0, 80));
    }
    let response = await send('POST', base, {
      title: '  Vérifier les cas limites  ',
      note: 'évaluation\nà poursuivre',
    });
    assert.equal(response.statusCode, 201);
    const first = response.json(),
      item = `${base}/${first.id}`;
    assert.equal(first.title, 'Vérifier les cas limites');
    assert.equal(first.status, 'todo');
    assert.equal(first.sessionId, 'first');
    assert.equal((await send('GET', item)).json().note, 'évaluation\nà poursuivre');
    assert.deepEqual((await send('GET', browser, undefined, auth)).json(), [first]);
    assert.equal((await send('GET', `${browser}/${first.id}`, undefined, auth)).json().id, first.id);
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      assert.equal(
        (
          await send(
            method,
            `/api/session-tasks/second/${first.id}`,
            method === 'PATCH' ? { title: 'Hijack' } : undefined,
            { 'x-cerebro-token': 'second-token' },
          )
        ).statusCode,
        404,
      );
    }
    for (const payload of [
      {},
      { status: null },
      { status: 'unknown' },
      { title: 12 },
      { note: false },
      { id: 'replace' },
      { title: ' ' },
    ]) {
      assert.equal((await send('PATCH', item, payload)).statusCode, 400);
    }
    for (const status of ['in_progress', 'blocked', 'done', 'cancelled', 'todo']) {
      response = await send('PATCH', item, { status });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, status);
      assert.equal(response.json().note, first.note, 'partial updates preserve other fields');
    }
    response = await send(
      'PATCH',
      `${browser}/${first.id}`,
      { title: 'Vérification terminée', status: 'done', note: 'Tests passés' },
      auth,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().createdAt, first.createdAt);
    const second = (
      await send('POST', browser, { title: 'Objectif abandonné', status: 'cancelled', note: 'Hors périmètre' }, auth)
    ).json();
    const third = (await send('POST', base, { title: 'Encore à faire' })).json();
    db.updateSession('first', { status: 'idle' });
    db.updateSession('first', { status: 'exited' });
    const expected = (await send('GET', base)).json();
    assert.deepEqual(
      expected.map((task) => task.id),
      [first.id, second.id, third.id],
    );
    assert.deepEqual(
      expected.map((task) => task.status),
      ['done', 'cancelled', 'todo'],
      'session lifecycle does not complete tasks',
    );
    assert.deepEqual(db.listTasks(), [], 'project backlog is independent');
    assert.deepEqual(db.listEpics(), []);
    db.close();
    await app.close();
    app = await buildServer();
    db = new CerebroDatabase();
    assert.deepEqual((await send('GET', base)).json(), expected, 'all tasks survive restart, including completed ones');
    assert.equal((await send('PATCH', item, { note: '' })).json().note, '');
    assert.equal((await send('DELETE', `${browser}/${second.id}`, undefined, auth)).statusCode, 204);
    assert.equal((await send('DELETE', item)).statusCode, 204);
    assert.equal((await send('GET', item)).statusCode, 404);
    assert.equal((await send('DELETE', item)).statusCode, 404);
    db.deleteSession('first');
    assert.equal(
      db.connection.prepare('SELECT count(*) AS n FROM session_tasks WHERE session_id = ?').get('first').n,
      0,
    );
    assert.equal((await send('GET', browser, undefined, auth)).statusCode, 404);
    const other = (
      await send('POST', '/api/session-tasks/second', { title: 'Other' }, { 'x-cerebro-token': 'second-token' })
    ).json();
    assert.ok(other.id);
    db.deleteProject(project.id);
    assert.equal(db.connection.prepare('SELECT count(*) AS n FROM session_tasks').get().n, 0);
  } finally {
    db.close();
    await app.close();
  }
});

test('CLI uses existing session credentials and exposes the complete CRUD workflow', async () => {
  const app = await buildServer();
  const db = new CerebroDatabase();
  const project = db.createProject('CLI', root);
  db.createSession(
    {
      id: 'cli',
      projectId: project.id,
      agent: 'claude',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: 'CLI',
      status: 'exited',
      agentSessionId: 'cli',
    },
    'cli-token',
  );
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const env = { ...process.env, CEREBRO_URL: url, CEREBRO_SESSION_ID: 'cli', CEREBRO_TOKEN: 'cli-token' };
    const run = async (...args) =>
      (await promisify(execFile)(process.execPath, ['bin/cerebro-tasks', ...args], { env })).stdout;
    assert.match(await run('--help'), /cancelled/);
    assert.match(await run('list'), /Aucune sous-tâche/);
    const task = JSON.parse(await run('add', 'Vérifier émoji 🧠', '--note', 'Contrôler\nles accents'));
    assert.equal(task.title, 'Vérifier émoji 🧠');
    assert.equal(JSON.parse(await run('get', task.id)).note, 'Contrôler\nles accents');
    assert.equal(JSON.parse(await run('update', task.id, '--status', 'done', '--note', 'Vérifié')).status, 'done');
    assert.match(await run('list'), /\[done\].*Vérifier émoji 🧠/);
    assert.equal(JSON.parse(await run('list', '--json')).length, 1);
    for (const args of [
      ['update', task.id],
      ['list', '--unknown'],
      ['add', 'No', '--status', 'done'],
      ['delete'],
      ['update', task.id, '--status', 'bad'],
      ['get', 'missing'],
    ]) {
      await assert.rejects(run(...args));
    }
    assert.equal(JSON.parse(await run('list', '--json')).length, 1);
    assert.match(await run('delete', task.id), /supprimée/);
    assert.deepEqual(JSON.parse(await run('list', '--json')), []);
  } finally {
    db.close();
    await app.close();
  }
});

test('new and resumed agent sessions receive instructions to maintain and reread the task list', () => {
  for (const agent of ['claude', 'codex', 'grok']) {
    for (const resume of [null, 'existing']) {
      const command = buildAgentCommand(agent, 'auto', '', 'generated', resume);
      const instructions = command.args.join(' ');
      assert.match(instructions, /cerebro-tasks list/);
      assert.match(instructions, /compaction/);
      assert.match(instructions, /effectivement réalisé et vérifié/);
    }
  }
});
