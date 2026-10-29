import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-backlog-cross-project-'));
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

test('une session ajoute et consulte dans le backlog d’un autre projet, sans y modifier l’existant', async () => {
  const app = await buildServer();
  const db = new CerebroDatabase();
  try {
    const home = db.createProject('EDOP', root);
    const cerebro = db.createProject('Cerebro', root);
    const session = db.createSession(
      {
        id: randomUUID(),
        projectId: home.id,
        agent: 'claude',
        mode: 'auto',
        model: null,
        effort: null,
        prompt: 'travail',
        title: 'Session EDOP',
        status: 'idle',
        agentSessionId: 'fake',
      },
      'token',
    );
    const existing = db.createTask(cerebro.id, 'Tâche existante', null);
    const send = (method, path, payload) =>
      app.inject({
        method,
        url: `/api/backlog/${session.id}${path}`,
        headers: { 'x-cerebro-token': 'token' },
        ...(payload === undefined ? {} : { payload }),
      });

    const projects = (await send('GET', '/projects')).json();
    assert.deepEqual(
      projects.map(({ name, current }) => [name, current]).sort(),
      [
        ['Cerebro', false],
        ['EDOP', true],
      ],
    );

    const added = await send('POST', '?project=cerebro', {
      epic: { title: 'Limites vues depuis EDOP', description: 'contexte' },
      tasks: ['Première', { text: 'Seconde', dependsOn: [1, existing.id] }],
    });
    assert.equal(added.statusCode, 201);
    const { epic, tasks } = added.json();
    assert.equal(db.getEpic(epic.id).projectId, cerebro.id);
    assert.ok(tasks.every((t) => db.getTask(t.id).projectId === cerebro.id && t.epicId === epic.id));
    assert.deepEqual(tasks[1].dependsOn, [tasks[0].id, existing.id]);
    assert.equal(db.getTask(tasks[0].id).sourceSessionId, session.id);
    assert.equal((await send('GET', '')).json().length, 0);

    const listed = (await send('GET', `?project=${cerebro.id}`)).json();
    assert.equal(listed.length, 3);
    assert.equal(listed.filter((t) => t.mine).length, 2);
    assert.equal((await send('GET', '/epics?project=Cerebro')).json()[0].mine, true);
    assert.equal((await send('POST', '?project=Cerebro', { epic: epic.id, tasks: ['Troisième'] })).statusCode, 201);

    // Dépendance ou epic d'un autre projet : refusés.
    const own = db.createTask(home.id, 'Tâche EDOP', null);
    assert.equal((await send('POST', '?project=Cerebro', { tasks: [{ text: 'x', dependsOn: [own.id] }] })).statusCode, 400);
    const homeEpic = db.createEpic(home.id, 'Epic EDOP', '', null);
    assert.equal((await send('POST', '?project=Cerebro', { epic: homeEpic.id, tasks: ['x'] })).statusCode, 400);

    // L'existant de l'autre projet reste hors d'atteinte ; seul ce que la session y a créé se supprime.
    assert.equal(
      (await send('POST', '/epics?project=Cerebro', { title: 'Vol', taskIds: [existing.id] })).statusCode,
      400,
    );
    assert.equal((await send('PATCH', `/tasks/${existing.id}`, { dependsOn: [] })).statusCode, 404);
    assert.equal((await send('PATCH', `/tasks/${tasks[0].id}`, { epicId: null })).statusCode, 404);
    assert.equal((await send('DELETE', `/tasks/${existing.id}`)).statusCode, 404);
    assert.equal((await send('DELETE', `/tasks/${tasks[0].id}`)).statusCode, 204);
    assert.equal(db.getTask(tasks[0].id), null);
    const empty = (await send('POST', '/epics?project=Cerebro', { title: 'Vide' })).json();
    assert.equal(db.getEpic(empty.id).projectId, cerebro.id);
    assert.equal((await send('DELETE', `/epics/${empty.id}`)).statusCode, 204);
    const foreignEpic = db.createEpic(cerebro.id, 'Epic Cerebro', '', null);
    assert.equal((await send('DELETE', `/epics/${foreignEpic.id}`)).statusCode, 404);

    const missing = await send('GET', '?project=Inconnu');
    assert.equal(missing.statusCode, 404);
    assert.match(missing.json().error, /Cerebro/);
    db.createProject('cerebro', root);
    assert.equal((await send('GET', '?project=Cerebro')).statusCode, 400);
    assert.equal((await send('GET', `?project=${cerebro.id}`)).statusCode, 200);
  } finally {
    db.close();
    await app.close();
  }
});
