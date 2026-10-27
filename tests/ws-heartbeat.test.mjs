import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
const { startHeartbeat } = await import('../server/ws-heartbeat.ts');

test('le heartbeat coupe une connexion qui ne répond plus aux pings et garde les autres', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const heartbeat = startHeartbeat(40);
  server.on('connection', (socket) => heartbeat.watch(socket));
  const url = `ws://127.0.0.1:${server.address().port}`;
  // Sans pong automatique, le client simule une machine en veille.
  const dead = new WebSocket(url, { autoPong: false });
  const live = new WebSocket(url);
  try {
    await Promise.all([once(dead, 'open'), once(live, 'open')]);
    const [code] = await Promise.race([
      once(dead, 'close'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('connexion morte jamais coupée')), 2000)),
    ]);
    assert.equal(code, 1006, 'terminate() coupe sans poignée de fermeture');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(live.readyState, WebSocket.OPEN, 'une connexion qui répond reste ouverte');
  } finally {
    heartbeat.stop();
    dead.terminate();
    live.terminate();
    server.close();
  }
});
