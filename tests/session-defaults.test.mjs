import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
mock.method(SessionManager.prototype, 'launch', async function (project, agent, mode, tuning, prompt, resumeId, existingId = null) {
  const id = existingId ?? randomUUID();
  const command = buildAgentCommand(agent, mode, prompt, id, resumeId, tuning);
  launches.push({ agent, mode, ...tuning, prompt, command, id });
  if (existingId !== null) return this.db.getSession(existingId);
  return this.db.createSession({
    id, projectId: project.id, agent, mode, ...tuning, prompt, title: prompt,
    status: 'exited', agentSessionId: command.agentSessionId ?? id,
  }, 'test-token');
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

test('Slack hérite des réglages, garde son instruction et mémorise un changement explicite d’agent', async () => {
  const db = new CerebroDatabase(':memory:');
  const manager = new SessionManager(db);
  const peers = {
    ready: Promise.resolve(), generalResponder: () => true, knownRemotely: () => false,
    conflictMachines: () => [], owns: () => true,
  };
  const notifier = new SlackNotifier(manager, db, peers);
  mock.method(notifier, 'slackApi', async () => ({ ok: true, ts: '123.456' }));
  try {
    const project = db.createProject('Demo', root);
    db.setSessionDefaults(project.id, saved);
    await notifier.handleDmMessage('test', { ts: '1.0', text: 'Demo+: Demande Slack' });
    assert.deepEqual(db.getProject(project.id).sessionDefaults, { ...saved, prompt: 'Demande Slack' });
    assert.equal(launches.at(-1).agent, 'codex');
    assert.equal(launches.at(-1).model, saved.model);
    assert.equal(launches.at(-1).effort, saved.effort);

    await notifier.handleDmMessage('test', { ts: '2.0', text: 'Demo/claude+: Changer d’agent' });
    assert.deepEqual(db.getProject(project.id).sessionDefaults, {
      agent: 'claude', mode: saved.mode, model: null, effort: null, prompt: 'Changer d’agent',
    });
    await notifier.handleDmMessage('test', { ts: '3.0', text: 'Demo+: Demande suivante' });
    assert.equal(launches.at(-1).agent, 'claude');

    const active = await manager.create(project, saved);
    db.updateSession(active.id, { status: 'idle' });
    manager.rememberDefaults(project.id, { agent: 'claude' });
    mock.method(notifier, 'injectDmMessage', async () => true);
    const count = launches.length;
    await notifier.handleDmMessage('test', { ts: '4.0', text: 'Demo/codex: Continuer' });
    assert.equal(launches.length, count);
    assert.equal(db.getProject(project.id).sessionDefaults.agent, 'codex');
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

    response = await send('PATCH', projectUrl, { sessionDefaults: { model: null, effort: null, prompt: '' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sessionDefaults.model, null);
    assert.equal(response.json().sessionDefaults.prompt, '');
    for (const invalid of [{ agent: null }, { mode: 'bad' }, { prompt: 42 }, { model: 'unknown' }, { effort: 'bad' }]) {
      response = await send('PATCH', projectUrl, { sessionDefaults: invalid });
      assert.equal(response.statusCode, 400);
    }
    response = await send('GET', '/api/projects');
    assert.deepEqual(response.json().find((p) => p.id === id).sessionDefaults, { ...saved, model: null, effort: null, prompt: '' });
  } finally {
    await app.close();
  }
});
