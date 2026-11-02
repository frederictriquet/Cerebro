import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mock, test } from 'node:test';
const { PeerLookupError, PeerResolver, remoteRequest } = await import('../server/peer-network.ts');

// Résolutions système simulées : chacune reste en cours jusqu'à ce que le test la règle.
function fakeSystem(resolver) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  mock.method(resolver, 'systemLookup', (hostname) => {
    let settle;
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    calls.push({ hostname, ...settle });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return promise.finally(() => {
      inFlight -= 1;
    });
  });
  return {
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const eaiAgain = (hostname) =>
  Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), { code: 'EAI_AGAIN', syscall: 'getaddrinfo' });

// Rejet vérifié plus loin dans le test : traité dès maintenant, sans quoi le lanceur le compte comme non géré.
function expected(promise) {
  promise.catch(() => {});
  return promise;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// Horloge et minuteurs simulés pour le temps du test.
async function withClock(run) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    await run();
  } finally {
    mock.timers.reset();
  }
}

const MAC = [{ address: '100.64.0.1', family: 4 }];

test('les connexions simultanées vers un nom partagent une résolution, gardée 60 s puis resservie pendant la suivante', () =>
  withClock(async () => {
    const resolver = new PeerResolver();
    const system = fakeSystem(resolver);
    const first = Promise.all(Array.from({ length: 5 }, () => resolver.resolve('Mac.tailnet.ts.net')));
    await flush();
    assert.deepEqual(
      system.calls.map((call) => call.hostname),
      ['mac.tailnet.ts.net'],
    );
    system.calls[0].resolve(MAC);
    for (const addresses of await first) assert.deepEqual(addresses, MAC);

    mock.timers.tick(59_999);
    assert.deepEqual(await resolver.resolve('mac.tailnet.ts.net'), MAC);
    await flush();
    assert.equal(system.calls.length, 1);

    // Expiré : l'adresse connue est resservie aussitôt, une nouvelle résolution part en arrière-plan.
    mock.timers.tick(1);
    assert.deepEqual(await resolver.resolve('mac.tailnet.ts.net'), MAC);
    assert.deepEqual(await resolver.resolve('mac.tailnet.ts.net'), MAC);
    await flush();
    assert.equal(system.calls.length, 2);
    system.calls[1].resolve([{ address: '100.64.0.2', family: 4 }]);
    await flush();
    assert.deepEqual(await resolver.resolve('mac.tailnet.ts.net'), [{ address: '100.64.0.2', family: 4 }]);
    assert.equal(system.calls.length, 2);
  }));

test('une seule résolution système à la fois, tous noms confondus, dans leur ordre d’arrivée', () =>
  withClock(async () => {
    const resolver = new PeerResolver();
    const system = fakeSystem(resolver);
    const a = resolver.resolve('a.example');
    const b = expected(resolver.resolve('b.example'));
    const c = resolver.resolve('c.example');
    await flush();
    assert.deepEqual(
      system.calls.map((call) => call.hostname),
      ['a.example'],
    );
    system.calls[0].resolve([{ address: '10.0.0.1', family: 4 }]);
    await flush();
    assert.deepEqual(
      system.calls.map((call) => call.hostname),
      ['a.example', 'b.example'],
    );
    system.calls[1].reject(Object.assign(new Error('getaddrinfo ENOTFOUND b.example'), { code: 'ENOTFOUND' }));
    await flush();
    system.calls[2].resolve([{ address: '10.0.0.3', family: 4 }]);
    assert.deepEqual(await a, [{ address: '10.0.0.1', family: 4 }]);
    await assert.rejects(b, (error) => {
      assert.ok(error instanceof PeerLookupError);
      assert.equal(error.code, 'ENOTFOUND');
      assert.equal(error.message, 'Nom b.example non résolu (ENOTFOUND)');
      return true;
    });
    assert.deepEqual(await c, [{ address: '10.0.0.3', family: 4 }]);
    assert.equal(system.maxInFlight, 1);
  }));

test('un échec est gardé 1, 2, 4 puis 5 min : d’ici là les connexions échouent aussitôt, sans nouvelle résolution', () =>
  withClock(async () => {
    const resolver = new PeerResolver();
    const system = fakeSystem(resolver);
    const first = expected(resolver.resolve('mac.tailnet.ts.net'));
    await flush();
    system.calls[0].reject(eaiAgain('mac.tailnet.ts.net'));
    await assert.rejects(first, { code: 'EAI_AGAIN', message: 'Nom mac.tailnet.ts.net non résolu (EAI_AGAIN)' });

    for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      const attempts = system.calls.length;
      mock.timers.tick(delay - 1);
      await assert.rejects(resolver.resolve('mac.tailnet.ts.net'), { code: 'EAI_AGAIN' });
      await flush();
      assert.equal(system.calls.length, attempts, `aucune résolution avant ${delay / 1_000} s`);
      // Délai écoulé : une tentative part, mais la connexion ne l'attend pas et reçoit l'échec connu.
      mock.timers.tick(1);
      await assert.rejects(resolver.resolve('mac.tailnet.ts.net'), { code: 'EAI_AGAIN' });
      await assert.rejects(resolver.resolve('mac.tailnet.ts.net'), { code: 'EAI_AGAIN' });
      await flush();
      assert.equal(system.calls.length, attempts + 1, `une seule tentative après ${delay / 1_000} s`);
      system.calls.at(-1).reject(eaiAgain('mac.tailnet.ts.net'));
      await flush();
    }

    // Nom de nouveau résolu : la tentative suivante efface l'échec.
    mock.timers.tick(300_000);
    await assert.rejects(resolver.resolve('mac.tailnet.ts.net'), { code: 'EAI_AGAIN' });
    await flush();
    system.calls.at(-1).resolve(MAC);
    await flush();
    assert.deepEqual(await resolver.resolve('mac.tailnet.ts.net'), MAC);
  }));

test('une connexion attend 4 s au plus une première résolution, qui continue et garde son emplacement', () =>
  withClock(async () => {
    const resolver = new PeerResolver();
    const system = fakeSystem(resolver);
    const slow = expected(resolver.resolve('slow.example'));
    await flush();
    mock.timers.tick(1_000);
    // Arrivée 1 s après le début de la résolution : attente jusqu'à début + 4 s.
    const later = expected(resolver.resolve('slow.example'));
    const other = expected(resolver.resolve('other.example'));
    await flush();
    mock.timers.tick(3_000);
    await assert.rejects(slow, { code: 'ETIMEOUT', message: 'Résolution de slow.example trop lente (plus de 4 s)' });
    await assert.rejects(later, { code: 'ETIMEOUT' });
    // Résolution en cours depuis plus de 4 s : échec immédiat, sans nouvelle résolution.
    await assert.rejects(resolver.resolve('slow.example'), { code: 'ETIMEOUT' });
    mock.timers.tick(1_000);
    await assert.rejects(other, {
      code: 'ETIMEOUT',
      message: "Résolution de other.example en attente depuis plus de 4 s, derrière celle d'un autre pair",
    });
    assert.deepEqual(
      system.calls.map((call) => call.hostname),
      ['slow.example'],
    );

    // La résolution lente finit par échouer (20 s, puis EAI_AGAIN) : l'emplacement passe à other.example.
    mock.timers.tick(15_000);
    system.calls[0].reject(eaiAgain('slow.example'));
    await flush();
    assert.deepEqual(
      system.calls.map((call) => call.hostname),
      ['slow.example', 'other.example'],
    );
    await assert.rejects(resolver.resolve('slow.example'), { message: 'Nom slow.example non résolu (EAI_AGAIN)' });
    const pending = resolver.resolve('other.example');
    system.calls[1].resolve([{ address: '10.0.0.2', family: 4 }]);
    assert.deepEqual(await pending, [{ address: '10.0.0.2', family: 4 }]);
    assert.equal(system.maxInFlight, 1);
  }));

test('lookup suit le contrat de net : tableau (all) ou adresse seule, famille demandée, adresse IP telle quelle', () =>
  withClock(async () => {
    const resolver = new PeerResolver();
    const system = fakeSystem(resolver);
    const lookup = (hostname, options) =>
      new Promise((resolve) => {
        resolver.lookup(hostname, options, (error, address, family) => resolve({ error, address, family }));
      });
    const dual = [
      { address: 'fd7a:115c:a1e0::1', family: 6 },
      { address: '100.64.0.1', family: 4 },
    ];
    const pending = lookup('dual.example', { all: true, hints: 32 });
    await flush();
    system.calls[0].resolve(dual);
    assert.deepEqual(await pending, { error: null, address: dual, family: undefined });
    assert.deepEqual(await lookup('dual.example', {}), { error: null, address: 'fd7a:115c:a1e0::1', family: 6 });
    assert.deepEqual(await lookup('dual.example', { family: 4 }), { error: null, address: '100.64.0.1', family: 4 });
    assert.deepEqual((await lookup('dual.example', { family: 'IPv6', all: true })).address, [dual[0]]);
    assert.deepEqual(await lookup('192.168.1.20', { all: true }), {
      error: null,
      address: [{ address: '192.168.1.20', family: 4 }],
      family: undefined,
    });
    assert.equal(system.calls.length, 1);

    const v4only = lookup('v4.example', { family: 6 });
    await flush();
    system.calls[1].resolve([{ address: '10.0.0.1', family: 4 }]);
    const { error } = await v4only;
    assert.ok(error instanceof PeerLookupError);
    assert.equal(error.code, 'ENOTFOUND');
  }));

test('la résolution système réelle résout localhost', async () => {
  const addresses = await new PeerResolver().resolve('localhost');
  assert.ok(addresses.some((entry) => entry.address === '127.0.0.1' || entry.address === '::1'));
});

test('remoteRequest : JSON et jeton envoyés, statut et corps rendus, délai dépassé nommé', async () => {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/base/api/slow') return;
      res.writeHead(req.url === '/base/api/missing' ? 404 : 200, { 'content-type': 'application/json' });
      res.end(req.url === '/base/api/missing' ? 'pas du JSON' : JSON.stringify({ echo: body === '' ? null : body }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const remote = { id: 'peer', name: 'Peer', url: `http://localhost:${server.address().port}/base`, token: 'secret' };
    assert.deepEqual(
      await remoteRequest(remote, '/api/peer/sync', { method: 'POST', body: { a: 1 }, timeoutMs: 5_000 }),
      {
        status: 200,
        body: { echo: '{"a":1}' },
      },
    );
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/base/api/peer/sync');
    assert.equal(received[0].headers.authorization, 'Bearer secret');
    assert.equal(received[0].headers['content-type'], 'application/json');
    assert.deepEqual(await remoteRequest(remote, '/api/missing', { timeoutMs: 5_000 }), { status: 404, body: null });
    assert.equal(received[1].method, 'GET');
    await assert.rejects(remoteRequest(remote, '/api/slow', { timeoutMs: 200 }), {
      message: 'pas de réponse en 0.2 s',
    });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
