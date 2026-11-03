import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-peer-name-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
mkdirSync(process.env.CEREBRO_DATA_DIR, { recursive: true });
process.env.CODEX_HOME = join(root, 'codex');
const claudeRoot = join(root, 'claude');
process.env.CLAUDE_CONFIG_DIR = claudeRoot;
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;

const { CerebroDatabase } = await import('../server/db.ts');
const { findPeerName } = await import('../server/peer-name.ts');
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
  rmSync(root, { recursive: true, force: true });
});

// Un processus déjà terminé : son pid n'est plus vivant.
const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
const livePid = process.pid;

function register(dir, file, content) {
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  writeFileSync(join(dir, 'sessions', file), typeof content === 'string' ? content : JSON.stringify(content));
}

test('finds the name of the running process holding the session id, ignoring stale and unrelated registrations', async () => {
  const dir = join(root, 'registry');
  const id = randomUUID();
  register(dir, `${deadPid}.json`, { pid: deadPid, sessionId: id, name: 'ancien-00', updatedAt: 9_000 });
  register(dir, `${livePid}.json`, { pid: livePid, sessionId: id, name: 'projet-ab', updatedAt: 100 });
  register(dir, '1.json', { pid: livePid, sessionId: randomUUID(), name: 'autre-cd', updatedAt: 9_000 });
  register(dir, `${livePid}.abc123.key`, 'secret');
  register(dir, 'cassé.json', '{"pid":');
  assert.equal(await findPeerName(dir, id), 'projet-ab');
});

test('keeps the most recently updated name when two running processes share the session id', async () => {
  const dir = join(root, 'two');
  const id = randomUUID();
  register(dir, 'a.json', { pid: livePid, sessionId: id, name: 'premier-01', updatedAt: 100 });
  register(dir, 'b.json', { pid: livePid, sessionId: id, name: 'dernier-02', updatedAt: 200 });
  assert.equal(await findPeerName(dir, id), 'dernier-02');
});

test('returns null without a registry, or when no running process has the session id', async () => {
  assert.equal(await findPeerName(join(root, 'absent'), randomUUID()), null);
  const dir = join(root, 'stopped');
  const id = randomUUID();
  register(dir, 'a.json', { pid: deadPid, sessionId: id, name: 'fini-03', updatedAt: 1 });
  assert.equal(await findPeerName(dir, id), null);
});

test('API returns the peer name of a running Claude session and a 404 explaining why otherwise', async () => {
  const db = new CerebroDatabase();
  const project = db.createProject('API', root);
  const create = (agent, agentSessionId) =>
    db.createSession(
      {
        id: randomUUID(),
        projectId: project.id,
        agent,
        mode: 'auto',
        model: null,
        effort: null,
        prompt: '',
        title: 'Conversation',
        status: 'running',
        agentSessionId,
      },
      'test-token',
    ).id;
  const runningId = randomUUID();
  const running = create('claude', runningId);
  const stopped = create('claude', randomUUID());
  const unnamed = create('claude', null);
  const codex = create('codex', randomUUID());
  db.close();
  register(claudeRoot, `${livePid}.json`, { pid: livePid, sessionId: runningId, name: 'api-ef', updatedAt: 1 });

  const app = await buildServer();
  try {
    const get = (id) => app.inject({ method: 'GET', url: `/api/sessions/${id}/peer-name` });
    const found = await get(running);
    assert.equal(found.statusCode, 200);
    assert.deepEqual(found.json(), { name: 'api-ef' });

    const notRunning = await get(stopped);
    assert.equal(notRunning.statusCode, 404);
    assert.match(notRunning.json().error, /pas en cours d’exécution/);

    for (const id of [unnamed, codex]) {
      const refused = await get(id);
      assert.equal(refused.statusCode, 404);
      assert.match(refused.json().error, /Seules les sessions Claude/);
    }
    assert.equal((await get('missing')).statusCode, 404);
  } finally {
    await app.close();
  }
});
