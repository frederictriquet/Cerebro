import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-cascade-broadcast-'));
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

let sessionCount = 0;
function createSession(db, projectId, epicId = null) {
  sessionCount += 1;
  const id = `cascade-session-${sessionCount}`;
  return db.createSession(
    {
      id,
      projectId,
      agent: 'codex',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: id,
      status: 'exited',
      agentSessionId: null,
    },
    `token-${sessionCount}`,
    epicId,
  );
}

// Les clients ne recopient plus les cascades de la base : le serveur doit diffuser chaque élément modifié.
test('le serveur diffuse les éléments modifiés par les cascades de la base', async () => {
  const app = await buildServer();
  const db = new CerebroDatabase();
  let socket;
  try {
    await app.ready();
    const messages = [];
    socket = await app.injectWS(
      '/ws/events',
      {},
      {
        onInit: (ws) => ws.on('message', (data) => messages.push(JSON.parse(data.toString()))),
      },
    );
    const received = (predicate) =>
      new Promise((resolve) => {
        const found = messages.find(predicate);
        if (found) return resolve(found);
        socket.on('message', (data) => {
          const message = JSON.parse(data.toString());
          if (predicate(message)) resolve(message);
        });
      });

    const project = db.createProject('Cascades', root);
    const epic = db.createEpic(project.id, 'Avant', '', null);
    const session = createSession(db, project.id, epic.id);

    // Renommer l'epic met à jour le titre conservé par ses sessions.
    const renamed = received(
      (m) => m.type === 'session' && m.session.id === session.id && m.session.epic?.title === 'Après',
    );
    assert.equal(
      (await app.inject({ method: 'PATCH', url: `/api/epics/${epic.id}`, payload: { title: 'Après' } })).statusCode,
      200,
    );
    assert.deepEqual((await renamed).session.epic, { id: epic.id, title: 'Après' });

    // Supprimer l'epic délie ses tâches ; la session conserve son origine.
    const member = db.createTask(project.id, 'Membre', null, epic.id);
    const unlinked = received((m) => m.type === 'task' && m.task.id === member.id && m.task.epicId === null);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/epics/${epic.id}` })).statusCode, 204);
    await unlinked;
    assert.deepEqual(db.getSession(session.id).epic, { id: epic.id, title: 'Après' });

    // Supprimer une session délie la tâche qu'elle traitait.
    const assigned = db.updateTask(db.createTask(project.id, 'Affectée', null).id, { sessionId: session.id });
    assert.equal(assigned.sessionId, session.id);
    const released = received((m) => m.type === 'task' && m.task.id === assigned.id && m.task.sessionId === null);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}` })).statusCode, 204);
    await released;

    // Supprimer un projet supprime son backlog.
    const doomed = db.createProject('À supprimer', root);
    const doomedEpic = db.createEpic(doomed.id, 'Epic', '', null);
    const doomedTask = db.createTask(doomed.id, 'Tâche', null, doomedEpic.id);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${doomed.id}` })).statusCode, 204);
    await received((m) => m.type === 'projects');
    assert.ok(messages.some((m) => m.type === 'task-deleted' && m.id === doomedTask.id));
    assert.ok(messages.some((m) => m.type === 'epic-deleted' && m.id === doomedEpic.id));
  } finally {
    socket?.terminate();
    db.close();
    await app.close();
  }
});
