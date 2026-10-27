import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, mock, test } from 'node:test';

// Aucun agent, compte Slack ou fichier de configuration réel n'est utilisé.
const root = mkdtempSync(join(tmpdir(), 'cerebro-defaults-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;

const { CerebroDatabase, DEFAULT_SESSION_DEFAULTS } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { EpicRunner } = await import('../server/epic-runner.ts');
const { CommandExecutor } = await import('../server/commands.ts');
const { SlackNotifier } = await import('../server/slack.ts');
const { buildAgentCommand } = await import('../server/agents.ts');
const { catalogFor } = await import('../server/catalog.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');
const { parseProject } = await import('../web/src/types.ts');

const saved = {
  agent: 'codex', mode: 'acceptEdits', model: 'gpt-6.1-sol', effort: 'xhigh', prompt: 'Prompt mémorisé\nDeuxième ligne',
};
catalogFor('codex').models.push({ value: saved.model, label: saved.model, description: '', efforts: ['high', 'xhigh'] });
mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});

// Remplacer uniquement le démarrage du PTY : résolution, persistance et commandes restent réelles.
const launches = [];
mock.method(SessionManager.prototype, 'launch', async function (project, agent, mode, tuning, prompt, resumeId, existingId = null, validate, joined, title, epicId) {
  const id = existingId ?? randomUUID();
  const command = buildAgentCommand(agent, mode, prompt, id, resumeId, tuning);
  launches.push({ agent, mode, ...tuning, prompt, command, id });
  if (existingId !== null) return this.db.getSession(existingId);
  return this.db.createSession({
    id, projectId: project.id, agent, mode, ...tuning, prompt, title: prompt,
    status: 'exited', agentSessionId: command.agentSessionId ?? id,
  }, 'test-token', epicId);
});

after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

test('migration, redémarrage et suppression des sessions conservent les réglages propres au projet', () => {
  const path = join(root, 'migration.db');
  let db = new CerebroDatabase(path);
  const project = db.createProject('Existant', root);
  db.createSession({
    id: 'old', projectId: project.id, agent: 'claude', mode: 'auto', model: null, effort: null,
    prompt: 'Ancien', title: 'Ancien', status: 'exited', agentSessionId: 'old',
  }, 'token');
  db.createSession({
    id: 'latest', projectId: project.id, ...saved, title: 'Dernier', status: 'exited', agentSessionId: 'latest',
  }, 'token');
  db.connection.exec("UPDATE sessions SET created_at = 1, updated_at = 999 WHERE id = 'old'; UPDATE sessions SET created_at = 2, updated_at = 2 WHERE id = 'latest'");
  db.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('ALTER TABLE projects DROP COLUMN session_defaults');
  legacy.close();

  db = new CerebroDatabase(path);
  assert.deepEqual(db.getProject(project.id).sessionDefaults, saved);
  db.connection.prepare('DELETE FROM sessions WHERE project_id = ?').run(project.id);
  db.updateProject(project.id, { name: 'Renommé', color: '#123456' });
  const other = db.createProject('Autre', root);
  assert.deepEqual(other.sessionDefaults, DEFAULT_SESSION_DEFAULTS);
  db.close();

  db = new CerebroDatabase(path);
  assert.deepEqual(db.getProject(project.id).sessionDefaults, saved);
  db.close();
});

test('création avec champs omis, remplacement du prompt et remise au défaut explicite', async () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Projet', root);
    db.setSessionDefaults(project.id, saved);
    const manager = new SessionManager(db);
    const events = [];
    manager.onEvent((event) => events.push(event));
    // Le Project en mémoire précède l'enregistrement des réglages : la base fait foi.
    const session = await manager.create(project, { prompt: 'Nouvelle demande' });
    assert.equal(session.agent, saved.agent);
    assert.equal(session.mode, saved.mode);
    assert.equal(session.model, saved.model);
    assert.equal(session.effort, saved.effort);
    assert.equal(session.prompt, 'Nouvelle demande');
    const { args } = launches.at(-1).command;
    assert.ok(args.includes(saved.model));
    assert.ok(args.includes('model_reasoning_effort="xhigh"'));
    assert.equal(events.at(-1).projects[0].sessionDefaults.prompt, 'Nouvelle demande');

    const inherited = await manager.create(project);
    assert.equal(inherited.prompt, 'Nouvelle demande');
    await manager.create(project, { model: null, effort: null, prompt: '' });
    assert.deepEqual(db.getProject(project.id).sessionDefaults, { ...saved, model: null, effort: null, prompt: '' });

    const beforeResume = db.getProject(project.id).sessionDefaults;
    await manager.resume(session.id);
    assert.deepEqual(db.getProject(project.id).sessionDefaults, beforeResume);
  } finally {
    db.close();
  }
});

test('les étapes automatiques d’une epic préservent le formulaire et transmettent leur prompt aux sessions', async () => {
  const db = new CerebroDatabase(':memory:');
  const manager = new SessionManager(db);
  const commands = new CommandExecutor(db);
  const runner = new EpicRunner(db, manager, commands, () => {});
  const events = [];
  manager.onEvent((event) => events.push(event));
  try {
    const project = db.createProject('Epic', root);
    db.setSessionDefaults(project.id, { ...saved, prompt: '' });
    const epic = db.createEpic(project.id, 'Correction', 'Contexte commun', null);
    const first = db.createTask(project.id, 'Première tâche', null, epic.id);
    const second = db.createTask(project.id, 'Deuxième tâche', null, epic.id);
    db.setTaskDependencies(second.id, [first.id]);
    const options = { ...saved, mode: 'plan', prompt: 'Instructions de l’epic' };
    runner.start(epic.id, options);
    const waitForStep = async (taskId) => {
      for (let i = 0; i < 200; i++) {
        runner.poke();
        const run = runner.list(epic.id)[0];
        if (run.status === 'waiting-validation' && run.currentTaskId === taskId) {
          return db.getSession(run.sessionId);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.fail('Étape non lancée');
    };
    const firstSession = await waitForStep(first.id);
    assert.match(firstSession.prompt, /Première tâche/);
    assert.ok(firstSession.prompt.includes(options.prompt));
    assert.equal(firstSession.mode, 'plan');
    assert.equal(launches.at(-1).prompt, firstSession.prompt);
    assert.deepEqual(db.getProject(project.id).sessionDefaults, { ...saved, prompt: '' });

    // Une saisie entre deux étapes doit aussi rester intacte.
    db.setSessionDefaults(project.id, saved);
    db.updateTask(first.id, { status: 'done' });
    const secondSession = await waitForStep(second.id);
    assert.match(secondSession.prompt, /Deuxième tâche/);
    assert.ok(secondSession.prompt.includes(options.prompt));
    assert.equal(launches.at(-1).prompt, secondSession.prompt);
    assert.deepEqual(db.getProject(project.id).sessionDefaults, saved);
    assert.equal(events.filter((event) => event.type === 'projects').length, 0);
  } finally {
    await runner.shutdown();
    await commands.shutdown();
    db.close();
  }
});

test('Slack hérite des réglages, préserve le prompt du formulaire et mémorise un changement explicite d’agent', async () => {
  const db = new CerebroDatabase(':memory:');
  const manager = new SessionManager(db);
  const peers = {
    ready: Promise.resolve(), generalResponder: () => true, knownRemotely: () => false, unreachableMachines: () => [],
    conflictMachines: () => [], owns: () => true,
  };
  const notifier = new SlackNotifier(manager, db, peers);
  const events = [];
  manager.onEvent((event) => events.push(event));
  mock.method(notifier, 'slackApi', async () => ({ ok: true, ts: '123.456' }));
  try {
    const project = db.createProject('Demo', root);
    db.setSessionDefaults(project.id, { ...saved, prompt: '' });
    await notifier.handleDmMessage('test', { ts: '0.0', text: 'Demo: Première demande Slack' });
    assert.equal(launches.at(-1).prompt, 'Première demande Slack');
    assert.deepEqual(db.getProject(project.id).sessionDefaults, { ...saved, prompt: '' });

    db.setSessionDefaults(project.id, saved);
    await notifier.handleDmMessage('test', { ts: '1.0', text: 'Demo+: Demande Slack' });
    assert.deepEqual(db.getProject(project.id).sessionDefaults, saved);
    assert.equal(events.filter((event) => event.type === 'projects').length, 0);
    assert.equal(launches.at(-1).prompt, 'Demande Slack');
    assert.equal(launches.at(-1).agent, 'codex');
    assert.equal(launches.at(-1).model, saved.model);
    assert.equal(launches.at(-1).effort, saved.effort);

    await notifier.handleDmMessage('test', { ts: '2.0', text: 'Demo/claude+: Changer d’agent' });
    assert.deepEqual(db.getProject(project.id).sessionDefaults, {
      agent: 'claude', mode: saved.mode, model: null, effort: null, prompt: saved.prompt,
    });
    assert.equal(launches.at(-1).prompt, 'Changer d’agent');
    assert.equal(events.at(-1).projects[0].sessionDefaults.prompt, saved.prompt);
    await notifier.handleDmMessage('test', { ts: '3.0', text: 'Demo+: Demande suivante' });
    assert.equal(launches.at(-1).agent, 'claude');
    assert.equal(launches.at(-1).prompt, 'Demande suivante');
    assert.equal(db.getProject(project.id).sessionDefaults.prompt, saved.prompt);

    const active = await manager.create(project, saved);
    db.updateSession(active.id, { status: 'idle' });
    manager.rememberDefaults(project.id, { agent: 'claude' });
    mock.method(notifier, 'injectDmMessage', async () => true);
    const count = launches.length;
    await notifier.handleDmMessage('test', { ts: '4.0', text: 'Demo/codex: Continuer' });
    assert.equal(launches.length, count);
    assert.equal(db.getProject(project.id).sessionDefaults.agent, 'codex');
    assert.equal(db.getProject(project.id).sessionDefaults.prompt, saved.prompt);
  } finally {
    notifier.stop();
    db.close();
  }
});

test('API : réglages avant lancement, rechargement, backlog et validation des changements', async () => {
  let app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    let response = await send('POST', '/api/projects', { name: 'API', path: root });
    const { id } = response.json();
    const projectUrl = `/api/projects/${id}`;
    response = await send('PATCH', projectUrl, { sessionDefaults: saved });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(parseProject(response.json()).sessionDefaults, saved);
    await app.close();
    app = await buildServer();
    response = await send('GET', '/api/projects');
    assert.deepEqual(response.json().find((p) => p.id === id).sessionDefaults, saved);

    response = await send('POST', `${projectUrl}/sessions`, {});
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().model, saved.model);
    assert.equal(response.json().effort, saved.effort);
    assert.equal(response.json().prompt, saved.prompt);
    response = await send('POST', `${projectUrl}/tasks`, { text: 'Tâche du backlog' });
    const task = response.json();
    response = await send('POST', `/api/tasks/${task.id}/start`, { prompt: task.text });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().session.agent, saved.agent);
    assert.equal(response.json().session.prompt, task.text);

    // A push operation uses the Git service, never launchSession / an agent CLI.
    execFileSync('git', ['-C', root, 'init', '-b', 'main']);
    const launchCount = launches.length;
    response = await send('POST', `${projectUrl}/git/push`);
    assert.equal(response.statusCode, 202);
    let operation = response.json();
    while (operation.finishedAt === null) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      operation = (await send('GET', `${projectUrl}/git/push`)).json();
    }
    assert.equal(operation.status, 'failed'); // Empty repository: no commit is invented.
    assert.equal(launches.length, launchCount);

    response = await send('PATCH', projectUrl, { sessionDefaults: { model: null, effort: null, prompt: '' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sessionDefaults.model, null);
    assert.equal(response.json().sessionDefaults.prompt, '');
    for (const invalid of [{ agent: null }, { mode: 'bad' }, { prompt: 42 }, { model: 'unknown' }, { effort: 'bad' }]) {
      response = await send('PATCH', projectUrl, { sessionDefaults: invalid });
      assert.equal(response.statusCode, 400);
    }
    response = await send('GET', '/api/projects');
    // Effort absent : valeur explicite du défaut Cerebro (high pour codex), modèle sans défaut catalogué.
    assert.deepEqual(response.json().find((p) => p.id === id).sessionDefaults, { ...saved, model: null, effort: 'high', prompt: '' });
  } finally {
    await app.close();
  }
});

test('API : les reviews ne mémorisent que la saisie du formulaire, pas les instructions générées', async () => {
  const repo = mkdtempSync(join(root, 'git-review-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file'), 'base\n'); git('add', '.'); git('commit', '-m', 'base');
  writeFileSync(join(repo, 'file'), 'changed\n');
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    const project = (await send('POST', '/api/projects', { name: 'Review', path: repo })).json();
    await send('PATCH', `/api/projects/${project.id}`, { sessionDefaults: saved });
    const defaults = async () => (await send('GET', '/api/projects')).json().find((p) => p.id === project.id).sessionDefaults;

    let review = (await send('POST', `/api/projects/${project.id}/git/prepare-review`)).json();
    let response = await send('POST', `/api/projects/${project.id}/git/review`, { reviewId: review.id, launch: { mode: 'plan', prompt: 'Saisie de review' } });
    assert.equal(response.statusCode, 201);
    assert.match(response.json().prompt, /^Saisie de review\n\n.+/s);
    assert.deepEqual(await defaults(), { ...saved, mode: 'plan', prompt: 'Saisie de review' });

    // Sans saisie, le prompt mémorisé reste celui du formulaire.
    await send('PATCH', `/api/projects/${project.id}`, { sessionDefaults: saved });
    review = (await send('POST', `/api/projects/${project.id}/git/prepare-review`)).json();
    response = await send('POST', `/api/projects/${project.id}/git/review`, { reviewId: review.id, launch: {} });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(await defaults(), saved);

    const session = response.json();
    const snapshot = (await send('POST', `/api/sessions/${session.id}/git/prepare-commit`)).json();
    const selection = { snapshotId: snapshot.id, selection: [{ path: 'file', all: true }], commits: [], acknowledged: ['file'] };
    response = await send('POST', `/api/sessions/${session.id}/git/review`, { selection, launch: { prompt: 'Revue de session' } });
    assert.equal(response.statusCode, 201);
    assert.match(response.json().prompt, /^Revue de session\n\n.*\+changed/s);
    assert.deepEqual(await defaults(), { ...saved, prompt: 'Revue de session' });
  } finally { await app.close(); }
});

test('API commit plan executes without launching an agent', async () => {
  const repo = mkdtempSync(join(root, 'git-api-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file'), 'new\n');
  const app = await buildServer();
  try {
    const project = (await app.inject({ method:'POST',url:'/api/projects',payload:{name:'Git API',path:repo} })).json();
    const before = launches.length;
    const snapshot = (await app.inject({method:'POST',url:`/api/projects/${project.id}/git/prepare-commit`})).json();
    const response = await app.inject({method:'POST',url:`/api/projects/${project.id}/git/commit`,payload:{snapshotId:snapshot.id,commits:[{message:'initial',selection:[{path:'file',all:true}]}],acknowledged:[],push:false}});
    assert.equal(response.statusCode,200);assert.equal(response.json().error,null);assert.equal(response.json().commits.length,1);
    assert.equal(launches.length,before);
  } finally {await app.close();}
});

test('API : un commit de session reste enregistré si la session est supprimée pendant son exécution', async () => {
  const repo = mkdtempSync(join(root, 'git-session-deleted-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file'), 'new\n');
  const app = await buildServer();
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Session supprimée', path: repo } })).json();
    const session = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/sessions`, payload: { prompt: 'Commit' } })).json();
    const snapshot = (await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/git/prepare-commit` })).json();
    // La session disparaît juste après la vérification initiale, avant la fin du commit.
    const getSession = CerebroDatabase.prototype.getSession;
    const spy = mock.method(CerebroDatabase.prototype, 'getSession', function (id) {
      const found = getSession.call(this, id);
      if (id === session.id && found !== null) { spy.mock.restore(); this.connection.prepare('DELETE FROM sessions WHERE id=?').run(id); }
      return found;
    });
    const response = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/git/commit`, payload: { snapshotId: snapshot.id, commits: [{ message: 'initial', selection: [{ path: 'file', all: true }] }], acknowledged: ['file'], push: false } });
    spy.mock.restore();
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().commits.length, 1);
    const operations = (await app.inject({ method: 'GET', url: `/api/operations?projectId=${project.id}` })).json();
    assert.deepEqual(operations.map((o) => [o.id, o.projectId, o.sessionId, o.ok]), [[response.json().operationId, project.id, session.id, true]]);
  } finally { await app.close(); }
});

test('API command tasks never launch an agent and preserve the explicit validation distinction',async()=>{
  const app=await buildServer();
  try{
    const p=(await app.inject({method:'POST',url:'/api/projects',payload:{name:'Commands',path:root}})).json();
    const command=(await app.inject({method:'POST',url:`/api/projects/${p.id}/commands`,payload:{name:'Check',executable:process.execPath,args:['-e','console.log("checked")'],cwd:'.',timeoutSeconds:10}})).json();
    const task=(await app.inject({method:'POST',url:`/api/projects/${p.id}/tasks`,payload:{text:'Check',execution:{type:'command',commandId:command.id,completion:'manual'}}})).json();
    const count=launches.length;const response=await app.inject({method:'POST',url:`/api/tasks/${task.id}/start`});assert.equal(response.statusCode,202);assert.equal(response.json().session,undefined);
    let run;do{await new Promise(r=>setTimeout(r,10));run=(await app.inject({method:'GET',url:`/api/tasks/${task.id}/runs`})).json()[0];}while(run.status==='running');
    assert.equal(run.status,'succeeded');assert.equal(launches.length,count);
    assert.equal((await app.inject({method:'GET',url:'/api/tasks'})).json().find(t=>t.id===task.id).status,'started');
  }finally{await app.close();}
});

test('API epic scheduler persists the current step and remains compatible with backlog --done',async()=>{
  let app=await buildServer();const send=(method,url,payload)=>app.inject({method,url,...(payload===undefined?{}:{payload})});
  try{
    const p=(await send('POST','/api/projects',{name:'Scheduled',path:root})).json();const a=(await send('POST',`/api/projects/${p.id}/tasks`,{text:'first'})).json();const b=(await send('POST',`/api/projects/${p.id}/tasks`,{text:'next'})).json();
    const epic=(await send('POST',`/api/projects/${p.id}/epics`,{title:'Sequential',taskIds:[a.id,b.id]})).json();const before=launches.length;
    const response=await send('POST',`/api/epics/${epic.id}/start`,{});assert.equal(response.statusCode,202);assert.equal(response.json().session,undefined);
    assert.equal((await send('POST',`/api/epics/${epic.id}/start`,{})).statusCode,409);
    await new Promise(r=>setTimeout(r,1100));let tasks=(await send('GET','/api/tasks')).json();const current=tasks.find(t=>t.id===a.id);assert.equal(current.status,'started');assert.equal(tasks.find(t=>t.id===b.id).status,'todo');assert.equal(launches.length,before+1);
    assert.deepEqual((await send('GET', '/api/sessions')).json().find(s => s.id === current.sessionId).epic, { id: epic.id, title: epic.title });
    await app.close();app=await buildServer();await new Promise(r=>setTimeout(r,50));assert.equal(launches.length,before+1);
    const done=await app.inject({method:'POST',url:`/api/backlog/${current.sessionId}/tasks/${a.id}/done`,headers:{'x-cerebro-token':'test-token'},payload:{}});assert.equal(done.statusCode,200);
    await new Promise(r=>setTimeout(r,1100));tasks=(await send('GET','/api/tasks')).json();assert.equal(tasks.find(t=>t.id===b.id).status,'started');assert.equal(launches.length,before+2);
  }finally{await app.close();}
});

test('API task launches retain their epic through retry and backlog cleanup', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    const project = (await send('POST', '/api/projects', { name: 'Session epic', path: root })).json();
    const epic = (await send('POST', `/api/projects/${project.id}/epics`, { title: 'Origine' })).json();
    const task = (await send('POST', `/api/projects/${project.id}/tasks`, { text: 'Étape', epicId: epic.id })).json();
    const first = await send('POST', `/api/tasks/${task.id}/start`, { prompt: task.text });
    assert.equal(first.statusCode, 201);
    assert.deepEqual(first.json().session.epic, { id: epic.id, title: 'Origine' });
    const second = await send('POST', `/api/tasks/${task.id}/start`, { prompt: task.text });
    assert.equal(second.statusCode, 201);
    assert.notEqual(first.json().session.id, second.json().session.id);
    await send('PATCH', `/api/epics/${epic.id}`, { title: 'Origine renommée' });
    await send('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    assert.equal((await send('DELETE', `/api/projects/${project.id}/backlog/completed`)).statusCode, 200);
    const sessions = (await send('GET', '/api/sessions')).json().filter(s => s.projectId === project.id);
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every(s => s.epic.id === epic.id && s.epic.title === 'Origine renommée'));
  } finally { await app.close(); }
});

test('POST /api/tasks/:id/start refuse une tâche LLM terminée ou dont la session tourne encore', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    const project = (await send('POST', '/api/projects', { name: 'Statut', path: root })).json();
    const task = (await send('POST', `/api/projects/${project.id}/tasks`, { text: 'Une fois' })).json();
    // Deux lancements concurrents : un seul crée une session, même si le premier n'a pas fini.
    const launch = SessionManager.prototype.launch;
    SessionManager.prototype.launch = async function (...args) { await new Promise(r => setTimeout(r, 100)); return launch.apply(this, args); };
    let concurrent;
    try { concurrent = await Promise.all([1, 2].map(() => send('POST', `/api/tasks/${task.id}/start`, { prompt: task.text }))); }
    finally { SessionManager.prototype.launch = launch; }
    assert.deepEqual(concurrent.map(r => r.statusCode).sort(), [201, 409]);
    const sessionId = concurrent.find(r => r.statusCode === 201).json().session.id;
    // Session encore active : « Relancer » la détacherait.
    const db = new CerebroDatabase();
    try { db.updateSession(sessionId, { status: 'running' }); } finally { db.close(); }
    const busy = await send('POST', `/api/tasks/${task.id}/start`, { prompt: task.text });
    assert.equal(busy.statusCode, 409, busy.body);
    // Session arrêtée : la relance reste permise.
    const reopened = new CerebroDatabase();
    try { reopened.updateSession(sessionId, { status: 'exited' }); } finally { reopened.close(); }
    const retry = await send('POST', `/api/tasks/${task.id}/start`, { prompt: task.text });
    assert.equal(retry.statusCode, 201, retry.body);
    await send('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    const count = launches.length;
    const done = await send('POST', `/api/tasks/${task.id}/start`, { prompt: task.text });
    assert.equal(done.statusCode, 409, done.body);
    assert.equal(launches.length, count);
    assert.equal((await send('GET', '/api/tasks')).json().find(t => t.id === task.id).status, 'done');
  } finally { await app.close(); }
});
