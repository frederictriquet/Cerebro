import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-remote-gateway-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
mkdirSync(process.env.CEREBRO_DATA_DIR);
const { default: Fastify } = await import('fastify');
const { default: fastifyWebsocket } = await import('@fastify/websocket');
const { default: WebSocket, WebSocketServer } = await import('ws');
const { peerResolver } = await import('../server/peer-network.ts');
const { registerRemoteGateway, relayableApiPath } = await import('../server/remotes.ts');

const received = [];
const receivedHeaders = [];
const remote = createServer((req, res) => {
  received.push(req.url);
  receivedHeaders.push(req.headers);
  res.setHeader('content-type', 'application/json');
  res.end('{"ok":true}');
});
// WebSocket de la machine distante : salue, puis renvoie chaque message.
new WebSocketServer({ server: remote }).on('connection', (socket) => {
  socket.send('bonjour');
  socket.on('message', (data) => socket.send(`écho ${data}`));
});
// Résolutions réelles, comptées : une machine déclarée par son nom passe par le résolveur des pairs.
const lookups = mock.method(peerResolver, 'systemLookup');
const resolves = mock.method(peerResolver, 'resolve');
const app = Fastify();
let port;

before(async () => {
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve));
  writeFileSync(
    join(process.env.CEREBRO_DATA_DIR, 'remotes.json'),
    JSON.stringify([
      { id: 'peer', name: 'Peer', url: `http://127.0.0.1:${remote.address().port}` },
      { id: 'named', name: 'Named', url: `http://localhost:${remote.address().port}` },
    ]),
  );
  await app.register(fastifyWebsocket);
  registerRemoteGateway(app, { synced: Promise.resolve(), remoteVersion: () => null });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = app.server.address().port;
});
after(async () => {
  await app.close();
  mock.restoreAll();
  remote.closeAllConnections();
  await new Promise((resolve) => remote.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

// Chemin brut, sans normalisation côté client, pour éprouver celle du relais.
function get(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('only interface routes are relayable, whatever their encoding', () => {
  for (const rest of [
    'sessions',
    'sessions/abc/screen',
    'projects/p/worktrees',
    'peer/notices',
    'peer/notices/n%20one/dismiss',
    'councils/c/images/1',
  ])
    assert.equal(relayableApiPath(rest), true, rest);
  for (const rest of [
    'hook/s',
    'notify/s',
    'backlog/s',
    'session-tasks/s',
    'auth',
    'machines',
    'peer/sync',
    'peer',
    'unknown/route',
    '',
    '%68ook/s',
    'sessions/..%2Fhook/s',
    'sessions/%2E%2E/hook/s',
    'sessions%2Fx',
    'sessions%2fx',
    'sessions/%5c..%5chook',
    'sessions\\..\\hook',
    'sessions/./x',
    'sessions/%2e/x',
    'sessions/%E0%A4%A',
    'sessions/x/../../hook/s',
  ])
    assert.equal(relayableApiPath(rest), false, rest);
});

test('the gateway relays interface routes and refuses local-only or traversing paths before reaching the remote', async () => {
  assert.equal(await get('/m/peer/api/sessions/abc?x=1'), 200);
  assert.equal(await get('/m/peer/api/peer/notices'), 200);
  assert.deepEqual(received, ['/api/sessions/abc?x=1', '/api/peer/notices']);

  for (const path of [
    '/m/peer/api/hook/s',
    '/m/peer/api/session-tasks/s',
    '/m/peer/api/peer/sync',
    '/m/peer/api/sessions/..%2Fhook/s',
    '/m/peer/api/sessions/%2e%2e/hook/s',
    '/m/peer/api/sessions/%2Fhook',
    '/m/peer/api/sessions/%5C..%5Chook/s',
    '/m/peer/api/%62acklog/s',
    '/m/peer/api/sessions/../hook/s',
  ])
    assert.equal(await get(path), 403, path);
  assert.equal(received.length, 2, 'no refused path reaches the remote');
  assert.equal(await get('/m/unknown/api/sessions'), 404);
});

test('relayed browser requests reach a token-less remote without Origin or Referer', async () => {
  const send = (path, method) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            origin: 'https://pc.tailnet.ts.net',
            referer: 'https://pc.tailnet.ts.net/',
            'content-type': 'application/json',
            'content-length': 2,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
  receivedHeaders.length = 0;
  assert.equal(await send('/m/peer/api/sessions', 'POST'), 200);
  assert.equal(await send('/m/peer/api/sessions/abc', 'DELETE'), 200);
  assert.equal(await send('/m/peer/vscode/static/x', 'GET'), 200);
  assert.equal(receivedHeaders.length, 3);
  for (const headers of receivedHeaders) {
    assert.equal(headers.origin, undefined);
    assert.equal(headers.referer, undefined);
    assert.equal(headers.authorization, undefined);
  }
});

test('a remote declared by host name is relayed, HTTP and WebSocket, through the cached peer resolver', async () => {
  received.length = 0;
  assert.equal(await get('/m/named/api/sessions?y=2'), 200);
  assert.deepEqual(received, ['/api/sessions?y=2']);
  const httpResolves = resolves.mock.calls.length;
  assert.ok(httpResolves > 0, 'relais HTTP : nom résolu par le résolveur des pairs');

  const socket = new WebSocket(`ws://127.0.0.1:${port}/m/named/ws/events`);
  const [greeting] = await once(socket, 'message');
  assert.equal(String(greeting), 'bonjour');
  socket.send('ping');
  const [echo] = await once(socket, 'message');
  assert.equal(String(echo), 'écho ping');
  socket.close();
  await once(socket, 'close');
  assert.ok(resolves.mock.calls.length > httpResolves, 'relais WebSocket : nom résolu par le résolveur des pairs');

  // Une seule résolution de localhost : la connexion WebSocket a repris l'adresse en cache.
  assert.deepEqual(
    lookups.mock.calls.map((call) => call.arguments[0]),
    ['localhost'],
  );
});
