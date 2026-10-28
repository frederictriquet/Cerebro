import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, mock, test } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-conflict-resolution-api-'));
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
  const [project, { agent, mode, tuning, prompt, validate, joined, title, epicId, context }] = args;
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
  await validate?.();
  return { ...db.getSession(session.id), cwd: workspace.path };
});
const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (path, file, content, message) => {
  writeFileSync(join(path, file), content);
  git(path, 'add', file);
  git(path, 'commit', '-m', message);
};
const repo = join(root, 'repo');
mkdirSync(repo);
git(repo, 'init', '-b', 'main');
git(repo, 'config', 'user.email', 'test@example.com');
git(repo, 'config', 'user.name', 'Test');
writeFileSync(join(repo, 'file'), 'base\n');
git(repo, 'add', '.');
git(repo, 'commit', '-m', 'base');
const db = new CerebroDatabase();
const project = db.createProject('Conflits', repo);
db.updateProject(project.id, {
  resolutionSettings: { agent: 'codex', mode: 'acceptEdits', model: null, effort: 'high' },
});
const conversation = db.createSession(
  {
    id: randomUUID(),
    projectId: project.id,
    agent: 'codex',
    mode: 'auto',
    model: null,
    effort: null,
    prompt: 'Réécris le fichier pour la conversation',
    title: 'Conversation d’origine',
    status: 'exited',
    agentSessionId: 'fake',
  },
  'token',
);
const epic = db.createEpic(project.id, 'Epic', '', null);
const step = db.createTask(project.id, 'Étape de l’epic\nRemplacer la ligne de base.', null, epic.id);
db.updateTask(step.id, { sessionId: conversation.id });
const workspace = await createWorkspace(db, conversation.id, project);
commit(workspace.path, 'file', 'conversation\n', 'travail de la conversation');
commit(repo, 'file', 'projet\n', 'travail du projet');
after(() => {
  mock.restoreAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('« Résoudre avec l’IA » launches a session on the merge left in conflict in the copy, until it is finished or abandoned', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  const view = async (id) => {
    const response = await send('GET', `/api/worktrees/${id}`);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  try {
    const own = (await send('GET', `/api/projects/${project.id}/worktrees`))
      .json()
      .worktrees.find((w) => w.sessionId === conversation.id);
    const url = `/api/worktrees/${own.id}/resolve-conflicts`;
    // No merge in progress: nothing to resolve.
    let refused = await send('POST', url);
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /Aucun conflit de mise à jour/);
    assert.equal((await send('POST', '/api/worktrees/missing/resolve-conflicts')).statusCode, 404);

    const update = async () => {
      const response = await send('POST', `/api/worktrees/${own.id}/update-from-target`);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().conflicts, ['file']);
      return git(workspace.path, 'rev-parse', 'MERGE_HEAD');
    };
    const launch = async () => {
      const response = await send('POST', url);
      assert.equal(response.statusCode, 201, response.body);
      return response.json();
    };

    // Abandoning the update forgets its resolution session.
    let mergeHead = await update();
    let session = await launch();
    assert.equal(workspaceFor(db, session.id).path, workspace.path);
    assert.equal(session.agent, 'codex');
    assert.equal(session.mode, 'acceptEdits');
    assert.equal(session.title, 'Conflits · Conversation d’origine');
    assert.equal(db.getProject(project.id).sessionDefaults.agent, 'claude');
    const prompt = launches.at(-1)[1].prompt;
    assert.match(prompt, /- file/);
    assert.match(prompt, /travail de la conversation/);
    assert.match(prompt, /travail du projet/);
    assert.match(prompt, /Réécris le fichier pour la conversation/);
    assert.match(prompt, /Tâche d’epic confiée à cette conversation : « Étape de l’epic »/);
    assert.match(prompt, /Remplacer la ligne de base/);
    let current = await view(own.id);
    assert.equal(current.conflictResolution.sessionId, session.id);
    assert.equal(current.conflictResolution.mergeHead, mergeHead);
    assert.deepEqual(current.resolver, { sessionId: session.id, title: session.title, status: 'idle' });

    // While that session lives, a second one is refused and the existing one is named.
    refused = await send('POST', url);
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().sessionId, session.id);
    let response = await send('POST', `/api/worktrees/${own.id}/update-from-target/abort`);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().resolver, null);
    assert.equal(response.json().conflictResolution, undefined);
    db.updateSession(session.id, { status: 'exited' });

    // The same merge started again: the session of the abandoned one is not shown.
    mergeHead = await update();
    current = await view(own.id);
    assert.equal(current.resolver, null);
    session = await launch();
    current = await view(own.id);
    assert.equal(current.resolver.sessionId, session.id);
    // An exited resolution session can be replaced.
    db.updateSession(session.id, { status: 'exited' });
    assert.equal((await view(own.id)).resolver.status, 'exited');
    session = await launch();
    assert.equal((await view(own.id)).conflictResolution.sessionId, session.id);

    // Finishing the update once the session has resolved the file (and is idle) forgets it too.
    writeFileSync(join(workspace.path, 'file'), 'conversation et projet\n');
    response = await send('POST', `/api/worktrees/${own.id}/update-from-target/finish`);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().mergeInProgress, false);
    assert.equal(response.json().resolver, null);
    assert.equal(response.json().conflictResolution, undefined);
    assert.equal(git(workspace.path, 'rev-parse', 'HEAD^2'), mergeHead);
    assert.equal(db.getSession(session.id).status, 'idle');
  } finally {
    await app.close();
  }
});
