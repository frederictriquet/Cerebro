import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-project-pin-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
mkdirSync(process.env.CEREBRO_DATA_DIR, { recursive: true });
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;

const { CerebroDatabase } = await import('../server/db.ts');
const { parseProject } = await import('../shared/types.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');
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

const pinnedIds = (projects) => projects.filter((project) => project.pinned).map((project) => project.id);

test('migration defaults existing projects to unpinned; one pinned project per machine', () => {
  const path = join(root, 'migration.db');
  let db = new CerebroDatabase(path);
  const first = db.createProject('Premier', root);
  assert.equal(first.pinned, false);
  db.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('DROP INDEX projects_pinned');
  legacy.exec('ALTER TABLE projects DROP COLUMN pinned');
  legacy.close();

  db = new CerebroDatabase(path);
  try {
    assert.equal(db.getProject(first.id).pinned, false);
    const second = db.createProject('Second', root);

    assert.deepEqual(pinnedIds(db.setProjectPinned(first.id, true)), [first.id]);
    // Épingler un autre projet retire l'épingle du premier.
    assert.deepEqual(pinnedIds(db.setProjectPinned(second.id, true)), [second.id]);
    assert.throws(() => db.connection.prepare('UPDATE projects SET pinned = 1 WHERE id = ?').run(first.id));
    // Modifier le projet par ailleurs garde son épingle.
    assert.equal(db.updateProject(second.id, { name: 'Renommé' }).pinned, true);
    assert.equal(db.getProject(second.id).pinned, true);

    assert.deepEqual(pinnedIds(db.setProjectPinned(second.id, false)), []);
    assert.equal(db.setProjectPinned('missing', true), null);

    // Une machine antérieure à l'épingle n'envoie pas le champ.
    const { pinned: ignored, ...oldPayload } = db.getProject(first.id);
    assert.equal(parseProject(oldPayload).pinned, false);
  } finally {
    db.close();
  }
});

test('API validates the pin, returns the whole list and keeps a single pin after restart', async () => {
  const db = new CerebroDatabase();
  const first = db.createProject('API un', root);
  const second = db.createProject('API deux', root);
  db.close();
  let app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  const pinUrl = (id) => `/api/projects/${id}/pin`;
  try {
    for (const payload of [{}, { pinned: 'true' }, { pinned: 1 }, { pinned: null }]) {
      assert.equal((await send('PATCH', pinUrl(first.id), payload)).statusCode, 400);
    }
    assert.equal((await send('PATCH', pinUrl('missing'), { pinned: true })).statusCode, 404);
    const response = await send('PATCH', pinUrl(first.id), { pinned: true });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(pinnedIds(response.json()), [first.id]);
    assert.deepEqual(pinnedIds((await send('PATCH', pinUrl(second.id), { pinned: true })).json()), [second.id]);
    await app.close();
    app = await buildServer();
    assert.deepEqual(pinnedIds((await send('GET', '/api/projects')).json()), [second.id]);
    assert.equal((await send('DELETE', `/api/projects/${second.id}`)).statusCode, 204);
    assert.deepEqual(pinnedIds((await send('GET', '/api/projects')).json()), []);
  } finally {
    await app.close();
  }
});

test('switching machines opens the pinned project when its list is known, the home page otherwise', () => {
  const projects = [
    { id: 'a', pinned: false },
    { id: 'b/c', pinned: true },
  ];
  assert.equal(machineHash('mac', projects), '#/m/mac/p/b%2Fc');
  assert.equal(machineHash(null, projects), '#/p/b%2Fc');
  assert.equal(machineHash('local', projects), '#/p/b%2Fc');
  assert.equal(machineHash('mac', [{ id: 'a', pinned: false }]), '#/m/mac/');
  assert.equal(machineHash(null, [{ id: 'a', pinned: false }]), '#/');
  // Surveillance sans snapshot : pas de liste connue.
  assert.equal(machineHash('mac', undefined), '#/m/mac/');
  assert.equal(machineHash(null), '#/');
});
