import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-council-notifications-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
process.env.CEREBRO_SLACK_TOKEN = 'test';
process.env.CEREBRO_SLACK_USER = 'test';
process.env.CEREBRO_PUBLIC_URL = 'http://machine-b.test/';
delete process.env.CEREBRO_BIND_TOKEN;

const { CouncilRuns } = await import('../server/council-runner.ts');
const { ANSWER_SCHEMA, REVIEW_SCHEMA } = await import('../server/council.ts');
const { PeerSync } = await import('../server/peers.ts');
const { SlackNotifier } = await import('../server/slack.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { buildServer } = await import('../server/index.ts');

mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});
mock.method(SlackNotifier.prototype, 'poll', async () => {});
mock.method(CouncilRuns.prototype, 'availableAgents', async () => ['claude', 'codex']);
mock.method(CouncilRuns.prototype, 'invoke', async (options) => {
  if (options.schema === ANSWER_SCHEMA) return { answer: 'Un avis.' };
  if (options.schema === REVIEW_SCHEMA)
    return {
      ranking: [...options.prompt.matchAll(/<reponse lettre="([A-H])">/g)].map((match) => ({
        letter: match[1],
        reason: 'Solide.',
      })),
      blindSpot: 'Le coût.',
      missed: 'Les tests.',
    };
  return {
    agreements: 'Accord.',
    disagreements: 'Désaccord.',
    blindSpots: 'Le coût.',
    recommendation: 'Faire X.',
    firstAction: 'Mesurer.',
  };
});
after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

async function until(read, ready) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (ready(value)) return value;
    await delay(10);
  }
  assert.fail('État de notification attendu non atteint.');
}

test('a web council outside projects posts once from its machine even when another machine handles general commands', async (t) => {
  let general = false;
  t.mock.method(PeerSync.prototype, 'generalResponder', () => general);
  t.mock.method(PeerSync.prototype, 'owns', () => false);
  const accepted = Promise.withResolvers();
  const posts = [];
  t.mock.method(SlackNotifier.prototype, 'slackApi', async (method, body) => {
    if (method === 'conversations.open') return { ok: true, channel: { id: 'DM' } };
    assert.equal(method, 'chat.postMessage');
    posts.push(body);
    await accepted.promise;
    return { ok: true, channel: 'DM', ts: '1.1' };
  });
  let app = await buildServer();
  const requestId = randomUUID();
  const input = {
    requestId,
    question: 'Quelle priorité ?',
    participants: [{ personaId: 'contrarian' }, { personaId: 'outsider' }],
  };
  const operation = async () =>
    (await app.inject({ method: 'GET', url: '/api/operations' }))
      .json()
      .find((result) => result.id === `council:${requestId}`);
  try {
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/slack',
          payload: { idle: true, waiting: true, delaySeconds: 0 },
        })
      ).statusCode,
      200,
    );
    const response = await app.inject({ method: 'POST', url: '/api/councils', payload: input });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.json().origin, 'web');
    assert.equal(response.json().projectId, null);
    const pending = await until(operation, (result) => result && (posts.length > 0 || result.notifiedAt !== null));
    assert.equal(posts.length, 1, 'la machine B doit envoyer son résultat local sans attendre le répondeur général A');
    assert.equal(posts[0].channel, 'DM');
    assert.equal(posts[0].thread_ts, undefined);
    assert.match(posts[0].text, /Hors projet.*council : Faire X\./);
    assert.ok(posts[0].text.includes(`http://machine-b.test/#/c/${requestId}`));
    assert.equal(pending.seenAt, null);
    assert.equal(pending.notifiedAt, null, 'Slack n’a pas encore confirmé l’envoi');
    accepted.resolve();
    await until(operation, (result) => result && result.notifiedAt !== null);
    assert.equal((await app.inject({ method: 'POST', url: '/api/councils', payload: input })).statusCode, 202);
    await app.close();
    general = true;
    app = await buildServer();
    assert.ok((await operation()).notifiedAt);
    await delay(30);
    assert.equal(
      posts.length,
      1,
      'ni le redémarrage ni la prise des commandes générales ne doivent renvoyer le résultat',
    );
  } finally {
    accepted.resolve();
    await app.close();
  }
});

// The 30 s in-process retry is covered by operation-results-retry.test.mjs; a restart also redelivers.
test('a failed Slack post stays unacknowledged and retries from the same machine after restart', async (t) => {
  t.mock.method(PeerSync.prototype, 'generalResponder', () => false);
  const errors = [];
  t.mock.method(SlackNotifier.prototype, 'logError', (cause) => errors.push(cause));
  let attempts = 0;
  t.mock.method(SlackNotifier.prototype, 'slackApi', async (method) => {
    if (method === 'conversations.open') return { ok: true, channel: { id: 'DM' } };
    assert.equal(method, 'chat.postMessage');
    if (++attempts === 1) throw new Error('Slack indisponible');
    return { ok: true, channel: 'DM', ts: '2.1' };
  });
  let app = await buildServer();
  const requestId = randomUUID();
  const operation = async () =>
    (await app.inject({ method: 'GET', url: '/api/operations' }))
      .json()
      .find((result) => result.id === `council:${requestId}`);
  try {
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/slack',
          payload: { idle: true, waiting: true, delaySeconds: 0 },
        })
      ).statusCode,
      200,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/councils',
      payload: { requestId, question: 'Que faire ensuite ?' },
    });
    assert.equal(response.statusCode, 202, response.body);
    await until(
      () => errors,
      (value) => value.length === 1,
    );
    assert.equal(errors[0].message, 'Slack indisponible');
    assert.equal((await operation()).notifiedAt, null);
    await app.close();
    app = await buildServer();
    await until(operation, (result) => result && result.notifiedAt !== null);
    assert.equal(attempts, 2);
  } finally {
    await app.close();
  }
});
