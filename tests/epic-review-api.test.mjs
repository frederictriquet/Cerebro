import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, mock, test } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-epic-review-api-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
mkdirSync(process.env.CEREBRO_DATA_DIR);
const { CerebroDatabase } = await import('../server/db.ts');
const { createWorkspace, createWorkspaceInContext, joinWorkspace, workspaceFor } =
  await import('../server/provenance.ts');
const { epicWorkspace, rememberEpicWorkspace } = await import('../server/epic-workspace.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { PeerSync } = await import('../server/peers.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { buildServer } = await import('../server/index.ts');
mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});
const launches = [];
mock.method(SessionManager.prototype, 'launch', async (...args) => {
  launches.push(args);
  const [project, agent, mode, tuning, prompt, , , validate, joined, title, epicId, context] = args;
  const session = db.createSession(
    {
      id: randomUUID(),
      projectId: project.id,
      agent,
      mode,
      ...tuning,
      prompt,
      title: title ?? 'Session de test',
      status: 'idle',
      agentSessionId: 'fake',
    },
    'token',
    epicId,
  );
  const workspace = context
    ? await createWorkspaceInContext(db, session.id, project, context)
    : joined
      ? await joinWorkspace(db, session.id, joined)
      : await createWorkspace(db, session.id, project);
  if (epicId) rememberEpicWorkspace(db, epicId, { path: workspace.path, mode: workspace.mode });
  await validate?.();
  return db.getSession(session.id);
});

test('task, review and command launches keep the epic folder after changing the project mode in either direction', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  const until = async (predicate) => {
    for (let i = 0; i < 400; i++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for epic context');
  };
  try {
    for (const mode of ['isolated', 'shared']) {
      const p = db.createProject(`Contexte ${mode}`, repo, mode);
      const epic = db.createEpic(p.id, `Epic ${mode}`, '', null);
      const source = db.createSession(
        {
          id: randomUUID(),
          projectId: p.id,
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
      const workspace = await createWorkspace(db, source.id, p);
      writeFileSync(join(workspace.path, `feature-${mode}.txt`), 'travail original\n');
      const work = db.createTask(p.id, 'Implémenter', null, epic.id);
      db.updateTask(work.id, { status: 'done' });
      const run = {
        id: randomUUID(),
        epicId: epic.id,
        projectId: p.id,
        status: 'succeeded',
        order: [work.id],
        members: [work.id],
        versions: {},
        results: { [work.id]: 'declared-done' },
        currentTaskId: null,
        sessionId: null,
        commandRunId: null,
        stepStartedAt: 0,
        contextRoot: workspace.path,
        baseHead: git(repo, 'rev-parse', 'HEAD'),
        options: p.sessionDefaults,
        error: null,
        startedAt: 1,
        updatedAt: 1,
      };
      db.connection.prepare('INSERT INTO epic_runs VALUES (?,?,?)').run(run.id, epic.id, JSON.stringify(run));
      db.updateProject(p.id, { workspaceMode: mode === 'isolated' ? 'shared' : 'isolated' });
      const context = (await send('GET', `/api/epics/${epic.id}/workspace`)).json();
      assert.deepEqual(context, { path: workspace.path, mode });
      const reopened = new CerebroDatabase();
      try {
        assert.deepEqual(epicWorkspace(reopened, epic.id), context);
      } finally {
        reopened.close();
      }
      const count = git(repo, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length;
      const review = await send('POST', `/api/epics/${epic.id}/review`, { agent: 'codex' });
      assert.equal(review.statusCode, 201, review.body);
      assert.equal(workspaceFor(db, review.json().id).path, workspace.path);
      assert.equal(workspaceFor(db, review.json().id).mode, mode);
      const fix = db.createTask(p.id, 'Corriger seul', null, epic.id);
      const started = await send('POST', `/api/tasks/${fix.id}/start`, { agent: 'codex' });
      assert.equal(started.statusCode, 201, started.body);
      assert.equal(workspaceFor(db, started.json().session.id).path, workspace.path);
      assert.equal(workspaceFor(db, started.json().session.id).mode, mode);
      db.updateSession(started.json().session.id, { status: 'exited', exitCode: 0 });
      db.updateTask(fix.id, { status: 'done' });
      const configured = (
        await send('POST', `/api/projects/${p.id}/commands`, {
          name: 'Vérifier',
          executable: process.execPath,
          args: ['-e', 'console.log(process.cwd())'],
          cwd: '.',
          timeoutSeconds: 5,
        })
      ).json();
      const command = db.createTask(p.id, 'Vérifier seul', null, epic.id, {
        type: 'command',
        commandId: configured.id,
        completion: 'exit-zero',
      });
      const executed = await send('POST', `/api/tasks/${command.id}/start`, {});
      assert.equal(executed.statusCode, 202);
      assert.equal(executed.json().run.cwd, workspace.path);
      await until(async () => {
        const runs = (await send('GET', `/api/tasks/${command.id}/runs`)).json();
        return runs[0]?.status === 'succeeded';
      });
      db.updateTask(command.id, { status: 'done' });
      const next = db.createTask(p.id, 'Poursuivre globalement', null, epic.id);
      const continued = await send('POST', `/api/epics/${epic.id}/start`, { agent: 'codex' });
      assert.equal(continued.statusCode, 202);
      assert.equal(continued.json().contextRoot, workspace.path);
      await until(async () => {
        const runs = (await send('GET', `/api/epics/${epic.id}/runs`)).json();
        return runs[0]?.status === 'waiting-validation';
      });
      assert.equal(workspaceFor(db, db.getTask(next.id).sessionId).path, workspace.path);
      const late = db.createTask(p.id, 'Ajout en cours', null, epic.id);
      assert.equal((await send('POST', `/api/tasks/${late.id}/start`, { agent: 'codex' })).statusCode, 409);
      db.deleteTask(late.id);
      db.updateTask(next.id, { status: 'done' });
      await until(async () => {
        const runs = (await send('GET', `/api/epics/${epic.id}/runs`)).json();
        return runs[0]?.status === 'succeeded';
      });
      assert.equal(
        git(repo, 'worktree', 'list', '--porcelain')
          .split('\n')
          .filter((line) => line.startsWith('worktree ')).length,
        count,
      );
      if (mode === 'isolated') {
        for (const row of db.connection.prepare('SELECT session_id,data FROM session_workspaces').all()) {
          const existing = JSON.parse(row.data);
          if (existing.path === workspace.path)
            db.connection
              .prepare('UPDATE session_workspaces SET data=? WHERE session_id=?')
              .run(JSON.stringify({ ...existing, removedAt: Date.now() }), row.session_id);
        }
        const missing = db.createTask(p.id, 'Copie retirée', null, epic.id);
        const before = launches.length;
        assert.equal((await send('POST', `/api/tasks/${missing.id}/start`, { agent: 'codex' })).statusCode, 409);
        assert.equal((await send('POST', `/api/epics/${epic.id}/start`, { agent: 'codex' })).statusCode, 409);
        assert.equal((await send('POST', `/api/epics/${epic.id}/review`, { agent: 'codex' })).statusCode, 409);
        assert.equal(launches.length, before);
      }
    }
  } finally {
    await app.close();
  }
});

test('two individual first steps share one epic worktree while independent sessions still follow the project preference', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, payload });
  try {
    const p = db.createProject('Premières étapes', repo);
    const epic = db.createEpic(p.id, 'Contexte unique', '', null);
    const a = db.createTask(p.id, 'A', null, epic.id);
    const b = db.createTask(p.id, 'B', null, epic.id);
    const responses = await Promise.all(
      [a, b].map((task) => send('POST', `/api/tasks/${task.id}/start`, { agent: 'codex' })),
    );
    responses.forEach((response) => assert.equal(response.statusCode, 201, response.body));
    const workspaces = responses.map((response) => workspaceFor(db, response.json().session.id));
    assert.equal(workspaces[0].path, workspaces[1].path);
    assert.equal(workspaces[0].mode, 'isolated');
    db.updateProject(p.id, { workspaceMode: 'shared' });
    const independent = await send('POST', `/api/projects/${p.id}/sessions`, { agent: 'codex' });
    assert.equal(independent.statusCode, 201);
    assert.equal(workspaceFor(db, independent.json().id).path, repo);
    assert.equal(workspaceFor(db, independent.json().id).mode, 'shared');
    assert.deepEqual((await send('GET', `/api/epics/${epic.id}/workspace`)).json(), {
      path: workspaces[0].path,
      mode: 'isolated',
    });
  } finally {
    await app.close();
  }
});
test('ambiguous epics expose their copies and accept only an explicit available choice while no step is active', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    const p = db.createProject('Dossiers ambigus', repo);
    const epic = db.createEpic(p.id, 'À réconcilier', '', null);
    const source = (title) =>
      db.createSession(
        {
          id: randomUUID(),
          projectId: p.id,
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
        epic.id,
      );
    const original = source('Worktree initial');
    const workspace = await createWorkspace(db, original.id, p);
    const shared = source('Étape dans le projet');
    await createWorkspaceInContext(db, shared.id, p, { path: repo, mode: 'shared' });
    const removed = source('Copie disparue');
    const missing = await createWorkspace(db, removed.id, p);
    rmSync(missing.path, { recursive: true, force: true });
    writeFileSync(join(workspace.path, 'only-in-copy.txt'), 'travail conservé\n');
    const finished = db.createTask(p.id, 'Ancienne étape', null, epic.id);
    db.updateTask(finished.id, { status: 'done' });
    const pending = db.createTask(p.id, 'Prochaine étape', null, epic.id);
    db.updateTask(pending.id, { status: 'started' });
    const run = {
      id: randomUUID(),
      epicId: epic.id,
      projectId: p.id,
      status: 'blocked',
      order: [pending.id],
      members: [finished.id, pending.id],
      versions: {},
      results: { [finished.id]: 'declared-done' },
      currentTaskId: pending.id,
      sessionId: null,
      commandRunId: null,
      stepStartedAt: 1,
      contextRoot: repo,
      workspace: { mode: 'shared', path: repo },
      options: p.sessionDefaults,
      autoValidate: true,
      error: 'Error: Cet epic a utilisé plusieurs dossiers de travail',
      startedAt: 1,
      updatedAt: 1,
    };
    const save = () =>
      db.connection
        .prepare('INSERT INTO epic_runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
        .run(run.id, epic.id, JSON.stringify(run));
    save();
    db.connection
      .prepare('INSERT INTO epic_workspaces (epic_id,data,verified) VALUES (?,?,0)')
      .run(epic.id, JSON.stringify(run.workspace));
    const url = `/api/epics/${epic.id}/workspace`;
    const before = launches.length;
    assert.equal((await send('GET', '/api/epics/missing/workspace-options')).statusCode, 404);
    assert.equal((await send('POST', '/api/epics/missing/workspace', { path: repo })).statusCode, 404);
    assert.equal((await send('GET', url)).statusCode, 409);
    assert.equal((await send('GET', `/api/epics/${epic.id}/runs`)).json()[0].workspaceConflict, true);
    const options = await send('GET', `/api/epics/${epic.id}/workspace-options`);
    assert.equal(options.statusCode, 200, options.body);
    assert.equal(options.json().conflict, true);
    assert.equal(options.json().selected, null);
    assert.equal(options.json().choices.length, 3);
    const copy = options.json().choices.find((choice) => choice.path === workspace.path);
    assert.equal(copy.mode, 'isolated');
    assert.equal(copy.branch, workspace.branch);
    assert.ok(copy.changes.includes('?? only-in-copy.txt'));
    assert.ok(copy.sessions.some((session) => session.id === original.id));
    assert.match(
      options.json().choices.find((choice) => choice.path === missing.path).unavailableReason,
      /introuvable/,
    );
    assert.equal((await send('POST', url, {})).statusCode, 400);
    assert.equal((await send('POST', url, { path: true })).statusCode, 400);
    assert.equal((await send('POST', url, { path: root })).statusCode, 409);
    assert.equal((await send('POST', url, { path: missing.path })).statusCode, 409);
    assert.equal(
      db.connection.prepare('SELECT verified FROM epic_workspaces WHERE epic_id=?').get(epic.id).verified,
      0,
    );
    run.status = 'running';
    save();
    assert.equal((await send('POST', url, { path: workspace.path })).statusCode, 409);
    run.status = 'blocked';
    save();
    db.updateSession(shared.id, { status: 'running' });
    assert.equal((await send('POST', url, { path: workspace.path })).statusCode, 409);
    db.updateSession(shared.id, { status: 'exited' });
    db.updateSession(shared.id, { status: 'idle' });
    db.updateTask(pending.id, { sessionId: shared.id });
    assert.equal((await send('POST', url, { path: workspace.path })).statusCode, 409);
    db.updateTask(pending.id, { sessionId: null });
    db.updateSession(shared.id, { status: 'exited' });
    const chosen = await send('POST', url, { path: workspace.path });
    assert.equal(chosen.statusCode, 200, chosen.body);
    assert.deepEqual(chosen.json(), { path: workspace.path, mode: 'isolated' });
    assert.equal((await send('POST', url, { path: workspace.path })).statusCode, 200);
    assert.equal((await send('POST', url, { path: repo })).statusCode, 409);
    assert.deepEqual((await send('GET', url)).json(), chosen.json());
    assert.equal((await send('GET', `/api/epics/${epic.id}/workspace-options`)).json().conflict, false);
    const latest = (await send('GET', `/api/epics/${epic.id}/runs`)).json()[0];
    assert.equal(latest.workspaceConflict, false);
    assert.equal(latest.contextRoot, workspace.path);
    assert.equal(latest.status, 'blocked');
    assert.equal(latest.autoValidate, true);
    assert.equal(db.getTask(pending.id).status, 'started');
    assert.equal(db.getTask(finished.id).status, 'done');
    assert.deepEqual(latest.results, run.results);
    assert.equal(launches.length, before);
    assert.equal(readFileSync(join(workspace.path, 'only-in-copy.txt'), 'utf8'), 'travail conservé\n');
    assert.equal(existsSync(join(repo, 'only-in-copy.txt')), false);
    const reopened = new CerebroDatabase();
    try {
      assert.deepEqual(epicWorkspace(reopened, epic.id), chosen.json());
    } finally {
      reopened.close();
    }
  } finally {
    await app.close();
  }
});

const repo = join(root, 'repo');
mkdirSync(repo);
const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(repo, 'init', '-b', 'main');
git(repo, 'config', 'user.email', 'test@example.com');
git(repo, 'config', 'user.name', 'Test');
writeFileSync(join(repo, 'file'), 'base\n');
git(repo, 'add', '.');
git(repo, 'commit', '-m', 'base');
const db = new CerebroDatabase();
const project = db.createProject('API Project', repo);
const stepSession = randomUUID();
db.createSession(
  {
    id: stepSession,
    projectId: project.id,
    agent: 'codex',
    mode: 'auto',
    model: null,
    effort: null,
    prompt: '',
    title: 'step',
    status: 'exited',
    agentSessionId: 'fake',
  },
  'token',
);
after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});
test('review step is added once, depends on every task; epic review needs a finished run and joins its worktree', async () => {
  launches.length = 0;
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  let socket;
  try {
    const empty = (await send('POST', `/api/projects/${project.id}/epics`, { title: 'Vide' })).json();
    assert.equal((await send('POST', `/api/epics/${empty.id}/review-task`)).statusCode, 409);
    const a = (await send('POST', `/api/projects/${project.id}/tasks`, { text: 'A' })).json();
    const b = (await send('POST', `/api/projects/${project.id}/tasks`, { text: 'B' })).json();
    const epic = (
      await send('POST', `/api/projects/${project.id}/epics`, { title: 'Livraison', taskIds: [a.id, b.id] })
    ).json();
    assert.equal((await send('POST', `/api/epics/missing/review-task`)).statusCode, 404);
    const created = await send('POST', `/api/epics/${epic.id}/review-task`);
    assert.equal(created.statusCode, 201);
    assert.deepEqual(created.json().dependsOn.slice().sort(), [a.id, b.id].sort());
    assert.equal(created.json().epicId, epic.id);
    assert.match(created.json().text, /^Code review du travail de l’epic/);
    assert.equal((await send('POST', `/api/epics/${epic.id}/review-task`)).statusCode, 409);

    assert.equal((await send('POST', `/api/epics/${epic.id}/review`, {})).statusCode, 409);
    const workspace = await createWorkspace(db, stepSession, project);
    writeFileSync(join(workspace.path, 'feature.txt'), 'x\n');
    const run = {
      id: randomUUID(),
      epicId: epic.id,
      projectId: project.id,
      status: 'running',
      order: [],
      members: [],
      versions: {},
      results: {},
      currentTaskId: null,
      sessionId: null,
      commandRunId: null,
      stepStartedAt: 0,
      contextRoot: workspace.path,
      options: project.sessionDefaults,
      error: null,
      startedAt: 1,
      updatedAt: 1,
    };
    const save = (status) =>
      db.connection
        .prepare('INSERT INTO epic_runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
        .run(run.id, run.epicId, JSON.stringify({ ...run, status }));
    save('running');
    const active = await send('POST', `/api/epics/${epic.id}/review`, {});
    assert.equal(active.statusCode, 409);
    assert.match(active.json().error, /en cours/);
    assert.equal(launches.length, 0);
    save('succeeded');
    const response = await send('POST', `/api/epics/${epic.id}/review`, { prompt: 'Sois précis.' });
    assert.equal(response.statusCode, 201);
    assert.equal(launches.length, 1);
    const [, , , , prompt, , , , , title, , context] = launches[0];
    assert.equal(context?.path, workspace.path);
    assert.match(prompt, /^Sois précis\./);
    assert.match(prompt, /feature\.txt/);
    assert.match(prompt, /code review du travail produit par l’epic « Livraison »/);
    assert.match(title, /Review de l’epic « Livraison »/);
    const review = response.json();
    assert.equal(review.epic.id, epic.id);
    assert.equal(review.worktree.path, workspace.path);
    const events = [];
    socket = await app.injectWS('/ws/events');
    socket.on('message', (data) => events.push(JSON.parse(data.toString())));
    const until = async (predicate) => {
      for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('Missing findings websocket update');
    };
    const finding = (id) => ({
      id,
      title: `Bug ${id}`,
      severity: 'high',
      file: 'feature.txt',
      line: 1,
      problem: 'Valeur incorrecte',
      scenario: 'Entrée vide',
      expectedFix: 'Valider la valeur',
    });
    const payload = { title: 'Corrections', findings: [finding('a')] };
    const report = (await send('POST', `/api/sessions/${review.id}/findings`, payload)).json();
    await until(() =>
      events.some(
        (event) =>
          event.type === 'findings-available' && event.session.id === review.id && event.session.pendingFindings === 1,
      ),
    );
    assert.equal(
      (await send('GET', '/api/sessions')).json().find((session) => session.id === review.id).pendingFindings,
      1,
    );
    await send('POST', `/api/sessions/${review.id}/findings`, payload);
    await until(() =>
      events.some(
        (event) => event.type === 'session' && event.session.id === review.id && event.session.pendingFindings === 1,
      ),
    );
    assert.equal(events.filter((event) => event.type === 'findings-available').length, 1);
    const importUrl = `/api/sessions/${review.id}/findings/${report.id}/import`;
    assert.equal((await send('POST', importUrl, { selected: ['a'], epicId: true })).statusCode, 400);
    const imported = await send('POST', importUrl, { selected: ['a'], epicId: epic.id });
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().epic.id, epic.id);
    await until(() =>
      events.some(
        (event) => event.type === 'session' && event.session.id === review.id && event.session.pendingFindings === 0,
      ),
    );
    assert.equal(
      (await send('GET', '/api/sessions')).json().find((session) => session.id === review.id).pendingFindings,
      0,
    );
    assert.deepEqual(imported.json().tasks[0].dependsOn.slice().sort(), [a.id, b.id, created.json().id].sort());
    assert.equal((await send('POST', importUrl, { selected: ['a'], epicId: epic.id })).json().tasks.length, 0);
    const publishedByAgent = await app.inject({
      method: 'POST',
      url: `/api/backlog/${review.id}/findings`,
      headers: { 'x-cerebro-token': 'token' },
      payload: { title: 'Suite', findings: [finding('b')] },
    });
    assert.equal(publishedByAgent.statusCode, 200);
    const followup = publishedByAgent.json();
    const appended = (
      await send('POST', `/api/sessions/${review.id}/findings/${followup.id}/import`, { selected: ['b'] })
    ).json();
    assert.equal(appended.epic.id, epic.id);
    assert.ok(appended.tasks[0].dependsOn.includes(imported.json().tasks[0].id));
    const separate = (
      await send('POST', `/api/sessions/${review.id}/findings`, { title: 'Autre epic', findings: [finding('c')] })
    ).json();
    const newEpic = await send('POST', `/api/sessions/${review.id}/findings/${separate.id}/import`, {
      selected: ['c'],
      epicId: null,
    });
    assert.equal(newEpic.statusCode, 200);
    assert.notEqual(newEpic.json().epic.id, epic.id);
    assert.deepEqual(newEpic.json().tasks[0].dependsOn, []);
    assert.equal((await send('POST', importUrl, { selected: ['a'], epicId: newEpic.json().epic.id })).statusCode, 400);
    assert.equal(
      (await send('GET', `/api/sessions/${review.id}/findings`)).json().find((item) => item.id === report.id).epicId,
      epic.id,
    );
    assert.equal(launches.length, 1);
  } finally {
    socket?.terminate();
    await app.close();
  }
});
