import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import Fastify from 'fastify';
const { relayHttp } = await import('../server/proxy.ts');

test('relayHttp coupe la réponse amont quand le client ferme pendant le streaming', async () => {
  let upstreamClosed;
  const closed = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  let timer;
  // Amont lent : un premier morceau, puis plus rien avant longtemps.
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('premier morceau');
    timer = setTimeout(() => res.end('fin'), 30_000);
    res.on('close', () => {
      clearTimeout(timer);
      upstreamClosed(res.writableFinished);
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const app = Fastify();
  app.get('/relay', (req, reply) =>
    relayHttp(
      req,
      reply,
      new URL(`http://127.0.0.1:${upstream.address().port}/`),
      {},
      { unreachable: 'Amont injoignable' },
    ),
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const client = request(`http://127.0.0.1:${app.server.address().port}/relay`);
    client.on('error', () => {});
    client.end();
    const [response] = await once(client, 'response');
    assert.equal(response.statusCode, 200);
    await once(response, 'data');
    client.destroy();
    const finished = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000))]);
    assert.equal(finished, false, 'la réponse amont doit être interrompue, pas menée à son terme');
  } finally {
    clearTimeout(timer);
    await app.close();
    upstream.closeAllConnections();
    upstream.close();
  }
});
