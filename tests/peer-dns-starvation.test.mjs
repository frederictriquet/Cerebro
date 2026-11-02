import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';

// Incident du 2026-10-31 : le nom MagicDNS du Mac ne se résolvait plus (20 s, puis EAI_AGAIN). Synchronisation des
// pairs, relais de l'interface et collecte des machines occupaient les deux emplacements que le pool libuv réserve à
// getaddrinfo, et la résolution de slack.com attendait derrière eux : plus aucun envoi Slack n'aboutissait.
const root = mkdtempSync(join(tmpdir(), 'cerebro-peer-dns-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CEREBRO_SLACK_TOKEN = 'test';
process.env.CEREBRO_SLACK_USER = 'test';
process.env.CEREBRO_SLACK_API_URL = 'http://slack.test/api';
mkdirSync(process.env.CEREBRO_DATA_DIR);
// Deux pairs déclarés par un nom que le DNS ne sert plus : sans limite commune, chacun occuperait un emplacement.
writeFileSync(
  join(process.env.CEREBRO_DATA_DIR, 'remotes.json'),
  JSON.stringify([
    { id: 'mac', name: 'MacBook', url: 'https://mac.tailnet.invalid', token: 'jeton-mac' },
    { id: 'nas', name: 'NAS', url: 'http://nas.tailnet.invalid:4317' },
  ]),
);
const { default: Fastify } = await import('fastify');
const { default: fastifyWebsocket } = await import('@fastify/websocket');
const { default: WebSocket } = await import('ws');
const { CerebroDatabase } = await import('../server/db.ts');
const { PeerSync } = await import('../server/peers.ts');
const { peerResolver, remoteRequest } = await import('../server/peer-network.ts');
const { registerRemoteGateway } = await import('../server/remotes.ts');
const { SlackTransport } = await import('../server/slack-api.ts');
const { collectMachines } = await import('../server/state.ts');

// Pool libuv simulé : deux résolutions getaddrinfo à la fois, les suivantes attendent leur tour, dans l'ordre.
function slowIoPool(size) {
  let busy = 0;
  const waiting = [];
  return {
    get busy() {
      return busy;
    },
    async run(work) {
      if (busy < size) busy += 1;
      else await new Promise((resolve) => waiting.push(resolve));
      try {
        return await work();
      } finally {
        const next = waiting.shift();
        if (next === undefined) busy -= 1;
        else next();
      }
    },
  };
}

const pool = slowIoPool(2);
// Résolutions des pairs : chacune garde son emplacement jusqu'à ce que le test la fasse échouer (EAI_AGAIN).
const peerLookups = [];
const hung = [];
mock.method(peerResolver, 'systemLookup', (hostname) =>
  pool.run(() => {
    peerLookups.push(hostname);
    return new Promise((_, reject) => {
      hung.push(() => reject(Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), { code: 'EAI_AGAIN' })));
    });
  }),
);
// fetch résout slack.test par getaddrinfo avant d'envoyer : un emplacement du pool, le temps d'une résolution rapide.
const slackPosts = [];
mock.method(globalThis, 'fetch', async (url, init) => {
  await pool.run(async () => {});
  slackPosts.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(init.body)) });
  return new Response(JSON.stringify({ ok: true, ts: '1.0', channel: 'D1' }), {
    headers: { 'content-type': 'application/json' },
  });
});

const app = Fastify();
let port;
before(async () => {
  await app.register(fastifyWebsocket);
  registerRemoteGateway(app, { synced: Promise.resolve(), remoteVersion: () => null });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = app.server.address().port;
});
after(async () => {
  await app.close();
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

function get(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

// Relais WebSocket de l'interface (pastilles des machines) : code de fermeture reçu par le navigateur.
function relaySocket(path) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    socket.on('error', () => {});
    socket.on('close', (code) => resolve(code));
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition non atteinte en 2 s');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function postToSlack(text) {
  const started = performance.now();
  await new SlackTransport().call('chat.postMessage', { channel: 'D1', text });
  return performance.now() - started;
}

// Durée d'un envoi Slack, ou Infinity s'il n'a pas abouti en 1 s (résolution bloquée derrière celles des pairs).
function postWithinASecond(text) {
  return Promise.race([
    postToSlack(text),
    new Promise((resolve) => setTimeout(() => resolve(Number.POSITIVE_INFINITY), 1_000)),
  ]);
}

test('témoin : deux résolutions de pair bloquées suffisent à faire attendre la résolution de Slack', async () => {
  const blocked = [];
  const holders = [0, 1].map(() => pool.run(() => new Promise((resolve) => blocked.push(resolve))));
  const post = postToSlack('témoin');
  const outcome = await Promise.race([
    post.then(() => 'envoyé'),
    new Promise((resolve) => setTimeout(() => resolve('en attente'), 300)),
  ]);
  assert.equal(outcome, 'en attente');
  for (const release of blocked) release();
  await Promise.all([...holders, post]);
  slackPosts.length = 0;
});

test('des pairs au nom non résolu n’occupent qu’un emplacement : un envoi Slack aboutit en moins d’une seconde', async () => {
  const db = new CerebroDatabase(':memory:');
  // Le constructeur lance un premier tour de synchronisation, qui commence par résoudre le Mac.
  const peers = new PeerSync(db, () => {});
  try {
    // Charge de l'interface ouverte et d'une question Slack « ? » : relais HTTP (API, VS Code), relais WebSocket des
    // pastilles et collecte des machines, vers les deux pairs.
    const relays = [];
    for (let i = 0; i < 3; i += 1) {
      for (const id of ['mac', 'nas']) relays.push(get(`/m/${id}/api/sessions`), get(`/m/${id}/vscode/`));
    }
    const sockets = [];
    for (let i = 0; i < 3; i += 1) for (const id of ['mac', 'nas']) sockets.push(relaySocket(`/m/${id}/ws/events`));
    const machines = collectMachines(db);
    const syncs = peers.sync();
    await waitFor(() => peerLookups.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const elapsed = await postWithinASecond('Question en attente');
    assert.ok(elapsed < 1_000, `envoi Slack en ${Math.round(elapsed)} ms (plus de 1 000 : bloqué derrière les pairs)`);
    assert.deepEqual(slackPosts.at(-1).body, { channel: 'D1', text: 'Question en attente' });
    assert.deepEqual(peerLookups, ['mac.tailnet.invalid'], 'une résolution à la fois : celle du NAS attend son tour');
    assert.equal(pool.busy, 1);

    // La résolution du Mac échoue enfin (20 s plus tard en vrai) ; celle du NAS prend l'emplacement et échoue aussi.
    hung.shift()();
    await waitFor(() => peerLookups.length === 2);
    assert.equal(peerLookups[1], 'nas.tailnet.invalid');
    hung.shift()();

    for (const status of await Promise.all(relays)) assert.equal(status, 502);
    for (const code of await Promise.all(sockets)) assert.equal(code, 1011);
    const [, ...remotes] = await machines;
    assert.deepEqual(remotes, [
      { ok: false, machine: 'MacBook', error: 'Nom mac.tailnet.invalid non résolu (EAI_AGAIN)' },
      { ok: false, machine: 'NAS', error: 'Nom nas.tailnet.invalid non résolu (EAI_AGAIN)' },
    ]);
    await syncs;
    assert.equal(peers.remoteVersion('mac').reachable, false);
    assert.equal(peers.remoteVersion('mac').error, 'Nom mac.tailnet.invalid non résolu (EAI_AGAIN)');

    // Pendant le délai d'échec, tours de synchronisation, relais et requêtes échouent aussitôt, sans résolution.
    const started = performance.now();
    await peers.sync();
    assert.deepEqual(await Promise.all([get('/m/mac/api/sessions'), get('/m/nas/api/sessions')]), [502, 502]);
    assert.equal(await relaySocket('/m/mac/ws/events'), 1011);
    await assert.rejects(
      remoteRequest({ id: 'mac', name: 'MacBook', url: 'https://mac.tailnet.invalid' }, '/api/x', { timeoutMs: 5_000 }),
      {
        code: 'EAI_AGAIN',
      },
    );
    assert.ok(performance.now() - started < 1_000);
    assert.equal(peerLookups.length, 2);
    assert.equal(pool.busy, 0);
    assert.ok((await postWithinASecond('Toujours joignable')) < 1_000);
  } finally {
    peers.stop();
    db.close();
  }
});
