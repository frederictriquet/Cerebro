import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-claim-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
mock.method(os, 'homedir', () => root);
syncBuiltinESMExports();

const { CerebroDatabase } = await import('../server/db.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');
mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
});

async function withProject(fn) {
  const app = await buildServer();
  const db = new CerebroDatabase();
  try {
    const project = db.createProject('Projet', root);
    const other = db.createProject('Autre', root);
    const makeSession = (token, status = 'idle') =>
      db.createSession(
        {
          id: randomUUID(),
          projectId: project.id,
          agent: 'claude',
          mode: 'auto',
          model: null,
          effort: null,
          prompt: 'travail',
          title: 'Session',
          status,
          agentSessionId: 'fake',
        },
        token,
      );
    const session = makeSession('token');
    const send = (method, path, payload, s = session, token = 'token') =>
      app.inject({
        method,
        url: `/api/backlog/${s.id}${path}`,
        headers: { 'x-cerebro-token': token },
        ...(payload === undefined ? {} : { payload }),
      });
    await fn({ app, db, project, other, session, send, makeSession });
  } finally {
    db.close();
    await app.close();
  }
}

test('une session rattache des tâches existantes, qu’elle peut ensuite clore', () =>
  withProject(async ({ db, project, session, send }) => {
    const a = db.createTask(project.id, 'Déjà commencée', null);
    const b = db.createTask(project.id, 'Autre', null);
    const res = await send('POST', '/claim', { ids: [a.id] });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.json().claimed.map((t) => t.id),
      [a.id],
    );
    assert.equal(db.getTask(a.id).status, 'started');
    assert.equal(db.getTask(a.id).sessionId, session.id);
    assert.equal(db.getTask(b.id).status, 'todo');

    // Idempotent, et la tâche rattachée se clôt comme une tâche lancée depuis le backlog.
    const again = (await send('POST', '/claim', { ids: [a.id] })).json();
    assert.deepEqual(again.claimed, []);
    assert.deepEqual(again.already, [a.id]);
    assert.equal((await send('POST', `/tasks/${a.id}/done`, {})).statusCode, 200);
    assert.equal(db.getTask(a.id).status, 'done');
  }));

test('rattacher un epic prend ses tâches ouvertes et laisse les terminées', () =>
  withProject(async ({ db, project, session, send }) => {
    const epic = db.createEpic(project.id, 'Chantier', '', null);
    const open = db.createTask(project.id, 'Ouverte', null, epic.id);
    const finished = db.updateTask(db.createTask(project.id, 'Finie', null, epic.id).id, { status: 'done' });
    const outside = db.createTask(project.id, 'Hors epic', null);
    const res = await send('POST', '/claim', { ids: [epic.id] });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.json().claimed.map((t) => t.id),
      [open.id],
    );
    assert.equal(db.getTask(open.id).sessionId, session.id);
    assert.equal(db.getTask(finished.id).sessionId, null);
    assert.equal(db.getTask(outside.id).status, 'todo');
    // Plus rien d'ouvert à rattacher dans cet epic.
    const empty = await send('POST', '/claim', { ids: [epic.id] });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json().already, [open.id]);
  }));

test('un rattachement refusé n’en rattache aucun et dit pourquoi', () =>
  withProject(async ({ db, project, other, send, makeSession }) => {
    const free = db.createTask(project.id, 'Libre', null);
    const foreign = db.createTask(other.id, 'D’un autre projet', null);
    const finished = db.updateTask(db.createTask(project.id, 'Finie', null).id, { status: 'done' });
    const command = db.createTask(project.id, 'Commande', null, null, {
      type: 'command',
      commandId: 'x',
      completion: 'manual',
    });
    const copied = db.createTask(project.id, 'Déjà déléguée', null);
    db.createTask(other.id, 'Copie', null, null, { type: 'llm' }, copied.id);
    const busy = db.createTask(project.id, 'Prise ailleurs', null);
    const live = makeSession('t2', 'running');
    db.updateTask(busy.id, { status: 'started', sessionId: live.id });

    for (const [task, status, reason] of [
      [foreign, 404, /Introuvable/],
      [finished, 409, /terminée/],
      [command, 409, /commande/i],
      [copied, 409, /autre projet/],
      [busy, 409, /autre session/],
    ]) {
      const res = await send('POST', '/claim', { ids: [free.id, task.id] });
      assert.equal(res.statusCode, status, task.text);
      assert.match(res.json().error, reason);
      assert.equal(db.getTask(free.id).status, 'todo', `${task.text} : rien n'est rattaché`);
    }
    assert.equal((await send('POST', '/claim', { ids: [] })).statusCode, 400);
    assert.equal((await send('POST', '/claim', { ids: ['inconnu'] })).statusCode, 404);
    assert.equal((await send('POST', '/claim', { ids: [free.id] }, undefined, 'mauvais')).statusCode >= 400, true);
  }));

test('la tâche d’une session arrêtée peut être reprise', () =>
  withProject(async ({ db, project, session, send, makeSession }) => {
    const task = db.createTask(project.id, 'Abandonnée', null);
    const old = makeSession('t3', 'exited');
    db.updateTask(task.id, { status: 'started', sessionId: old.id });
    assert.equal((await send('POST', '/claim', { ids: [task.id] })).statusCode, 200);
    assert.equal(db.getTask(task.id).sessionId, session.id);
  }));

test('rendre au backlog une tâche rattachée par erreur', () =>
  withProject(async ({ db, project, session, send, makeSession }) => {
    const epic = db.createEpic(project.id, 'E', '', null);
    const mine = db.createTask(project.id, 'À rendre', null, epic.id);
    const other = makeSession('t4', 'running');
    const theirs = db.updateTask(db.createTask(project.id, 'À un autre', null).id, {
      status: 'started',
      sessionId: other.id,
    });
    await send('POST', '/claim', { ids: [epic.id] });
    assert.equal(db.getTask(mine.id).sessionId, session.id);

    assert.equal((await send('POST', '/release', { ids: [theirs.id] })).statusCode, 409);
    assert.equal(db.getTask(theirs.id).sessionId, other.id);
    const res = await send('POST', '/release', { ids: [epic.id] });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.json().released.map((t) => t.id),
      [mine.id],
    );
    assert.equal(db.getTask(mine.id).status, 'todo');
    assert.equal(db.getTask(mine.id).sessionId, null);
  }));
