import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import WebSocket from 'ws';

const root = mkdtempSync(join(tmpdir(), 'cerebro-origin-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_PUBLIC_URL;
delete process.env.CEREBRO_HOST;
delete process.env.CEREBRO_PORT;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;

const { originAllowed, originPolicy } = await import('../server/origin.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');

mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () { this.markReady(); this.markSynced(); });
after(() => { mock.restoreAll(); rmSync(root, { recursive: true, force: true }); });

const local = originPolicy({ host: '127.0.0.1', port: 4317, publicUrl: 'https://box.tailnet.ts.net/', tokenProtected: false });
const tokenProtected = originPolicy({ host: '0.0.0.0', port: 4317, publicUrl: 'http://0.0.0.0:4317', tokenProtected: true });
const post = (headers) => ({ method: 'POST', headers: { host: '127.0.0.1:4317', ...headers } });
const upgrade = (headers) => ({ method: 'GET', headers: { host: '127.0.0.1:4317', upgrade: 'websocket', ...headers } });

test('trusts the UI origins and clients without Origin, refuses foreign pages', () => {
  for (const origin of ['http://127.0.0.1:4317', 'http://localhost:4317', 'http://[::1]:4317', 'http://127.0.0.1:5173', 'http://localhost:5173', 'https://box.tailnet.ts.net']) {
    assert.equal(originAllowed(post({ origin }), false, local), true, origin);
    assert.equal(originAllowed(upgrade({ origin }), false, local), true, origin);
  }
  assert.equal(originAllowed(post({}), false, local), true);
  assert.equal(originAllowed(upgrade({}), false, local), true);
  // Pages served on another localhost port are same-site: SameSite cookies do not stop them.
  for (const origin of ['http://localhost:8080', 'https://evil.example', 'null', 'http://127.0.0.1:4318', 'garbage']) {
    assert.equal(originAllowed(post({ origin }), false, local), false, origin);
    assert.equal(originAllowed(upgrade({ origin }), false, local), false, origin);
  }
  // Plain reads stay open (CORS already hides the response), but not websocket upgrades.
  assert.equal(originAllowed({ method: 'GET', headers: { origin: 'https://evil.example' } }, false, local), true);
  // DNS rebinding: same origin as the requested host, refused without a token.
  assert.equal(originAllowed(post({ origin: 'http://evil.example:4317', host: 'evil.example:4317' }), false, local), false);
});

test('with a token, accepts the requested host and explicit credentials', () => {
  assert.equal(originAllowed(post({ origin: 'http://192.168.1.10:4317', host: '192.168.1.10:4317' }), false, tokenProtected), true);
  assert.equal(originAllowed(upgrade({ origin: 'https://box.ts.net', host: '127.0.0.1:4317', 'x-forwarded-host': 'box.ts.net' }), false, tokenProtected), true);
  assert.equal(originAllowed(upgrade({ origin: 'http://localhost:8080', host: 'localhost:4317' }), false, tokenProtected), false);
  // Bearer or query token (e.g. the multi-machine gateway relaying a browser request).
  assert.equal(originAllowed(post({ origin: 'http://localhost:8080' }), true, local), true);
});

function connect(url, origin) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, origin === undefined ? {} : { origin });
    socket.once('message', (data) => { socket.close(); resolve({ opened: true, message: JSON.parse(data.toString()) }); });
    socket.once('unexpected-response', (_request, response) => { socket.terminate(); resolve({ opened: false, status: response.statusCode }); });
    socket.once('error', () => resolve({ opened: false, status: null }));
  });
}

test('server refuses websocket upgrades and mutations from a foreign origin', async () => {
  const app = await buildServer();
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address();
    const events = `ws://127.0.0.1:${port}/ws/events`;
    assert.deepEqual(await connect(events, 'http://localhost:8080'), { opened: false, status: 403 });
    assert.deepEqual(await connect(`ws://127.0.0.1:${port}/ws/term/any`, 'https://evil.example'), { opened: false, status: 403 });
    assert.equal((await connect(events, 'http://127.0.0.1:4317')).message.type, 'snapshot');
    assert.equal((await connect(events)).message.type, 'snapshot');

    for (const url of ['/api/sessions/missing/kill', '/api/projects/missing/purge', '/api/tasks/missing/start', '/api/epics/missing/start', '/api/updates/claude']) {
      const refused = await app.inject({ method: 'POST', url, headers: { origin: 'http://localhost:8080' } });
      assert.equal(refused.statusCode, 403, url);
      assert.deepEqual(refused.json(), { error: 'Origine refusée' });
    }
    const allowed = await app.inject({ method: 'POST', url: '/api/sessions/missing/kill', headers: { origin: 'http://localhost:5173' } });
    assert.notEqual(allowed.statusCode, 403);
    assert.notEqual((await app.inject({ method: 'POST', url: '/api/sessions/missing/kill' })).statusCode, 403);
  } finally { await app.close(); }
});
