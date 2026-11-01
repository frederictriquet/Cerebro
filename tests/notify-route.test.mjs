import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-notify-route-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_USER_TOKEN;
process.env.CEREBRO_SLACK_TOKEN = 'test';
process.env.CEREBRO_SLACK_USER = 'UFRED';
process.env.CEREBRO_SLACK_API_URL = 'http://slack.test/api';
mock.method(os, 'homedir', () => root);
syncBuiltinESMExports();

const { CerebroDatabase } = await import('../server/db.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { SlackNotifier } = await import('../server/slack.ts');
const { buildServer } = await import('../server/index.ts');
mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});
mock.method(SlackNotifier.prototype, 'poll', async () => {});

// Faux Slack lent : chat.postMessage attend `release()` tant que `blockSlack()` le retient.
const CLI = join(import.meta.dirname, '..', 'bin', 'cerebro-notify');
const realFetch = globalThis.fetch;
const posted = [];
let gate = Promise.resolve();
let release = () => {};
const blockSlack = () => {
  gate = new Promise((resolve) => (release = resolve));
};
mock.method(globalThis, 'fetch', async (url, init) => {
  if (!String(url).startsWith('http://slack.test/')) return realFetch(url, init);
  const method = String(url).replace('http://slack.test/api/', '');
  if (method === 'chat.postMessage') {
    await gate;
    posted.push(Object.fromEntries(new URLSearchParams(init.body)));
  }
  const payload =
    method === 'conversations.open'
      ? { ok: true, channel: { id: 'DM' } }
      : { ok: true, ts: `${1_700_000_000 + posted.length}.000100`, channel: 'DM' };
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
});

let app;
let db;
let session;
let url;
// Serveur qui accepte les requêtes sans jamais répondre.
const silent = createServer(() => {});

before(async () => {
  app = await buildServer();
  url = await app.listen({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  db = new CerebroDatabase();
  const project = db.createProject('Demo', root);
  session = db.createSession(
    {
      id: randomUUID(),
      projectId: project.id,
      agent: 'claude',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: 'Session',
      status: 'running',
      agentSessionId: 'fake',
    },
    'token',
  );
});

beforeEach(() => {
  release();
  posted.length = 0;
});

after(async () => {
  release();
  silent.closeAllConnections();
  silent.close();
  await app.close();
  db.close();
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

async function until(ready, message) {
  for (let i = 0; i < 300; i++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(message);
}

function runCli(args, env = {}) {
  const childEnv = { ...process.env };
  for (const name of Object.keys(childEnv)) if (name.startsWith('CEREBRO_')) delete childEnv[name];
  Object.assign(childEnv, { CEREBRO_SESSION_ID: session.id, CEREBRO_TOKEN: 'token', CEREBRO_URL: url }, env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('POST /api/notify répond sans attendre Slack, et la question est enregistrée', async () => {
  blockSlack();
  const started = Date.now();
  const response = await app.inject({
    method: 'POST',
    url: `/api/notify/${session.id}`,
    headers: { 'x-cerebro-token': 'token' },
    payload: { kind: 'ask', text: 'Quel environnement ?' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, queued: false, pending: true });
  assert.ok(Date.now() - started < 2_000, 'réponse sans attendre Slack');
  assert.equal(posted.length, 0, 'Slack retient encore le message');
  // Fin du tour avant que Slack ait répondu : la session attend la réponse à sa question.
  const stop = await app.inject({
    method: 'POST',
    url: `/api/hook/${session.id}`,
    headers: { 'x-cerebro-token': 'token' },
    payload: { agent: 'claude', event: 'Stop', payload: {} },
  });
  assert.equal(stop.statusCode, 204, stop.body);
  const waiting = db.getSession(session.id);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.attentionReason, 'Question : Quel environnement ?');
  release();
  await until(() => posted.length === 1, 'question postée une fois Slack libéré');
  assert.match(posted[0].text, /^:question: .*\nQuel environnement \?\n/s);
});

test('cerebro-notify annonce un envoi en cours, même quand Slack tarde', async () => {
  blockSlack();
  const ask = await runCli(['--ask', 'Quelle', 'base ?']);
  assert.equal(ask.code, 0, ask.stderr);
  assert.equal(
    ask.stdout,
    "Question : en cours d'envoi sur Slack, avec nouvelles tentatives automatiques en cas d'échec passager. Termine ton tour maintenant : la réponse arrivera comme prochain message de l'utilisateur.\n",
  );
  const notify = await runCli(['Contexte', 'utile']);
  assert.equal(notify.code, 0, notify.stderr);
  assert.equal(
    notify.stdout,
    "Message en cours d'envoi sur Slack, avec nouvelles tentatives automatiques en cas d'échec passager.\n",
  );
  assert.equal(posted.length, 0);
  release();
  await until(() => posted.length === 2, 'question puis message postés');
  assert.match(posted[0].text, /Quelle base \?/);
  assert.match(posted[1].text, /Contexte utile/);
});

test("sans réponse du serveur à temps, la CLI dit que l'envoi est probablement en cours et qu'il ne faut pas renvoyer", async () => {
  const env = { CEREBRO_URL: `http://127.0.0.1:${silent.address().port}`, CEREBRO_CLIENT_TIMEOUT_MS: '300' };
  const ask = await runCli(['--ask', 'Quel choix ?'], env);
  assert.equal(ask.code, 1);
  assert.equal(ask.stdout, '');
  assert.equal(
    ask.stderr,
    "cerebro-notify : le serveur Cerebro n'a pas répondu en 0.3 s. La question est probablement enregistrée (la fin du tour s'affichera comme une question) et son envoi Slack peut encore aboutir : ne la renvoie pas sans vérifier (fil Slack de la session, session dans Cerebro).\n",
  );
  const notify = await runCli(['Contexte'], env);
  assert.equal(notify.code, 1);
  assert.equal(
    notify.stderr,
    "cerebro-notify : le serveur Cerebro n'a pas répondu en 0.3 s. Le message est probablement en cours d'envoi : ne le renvoie pas sans vérifier (fil Slack de la session).\n",
  );
});
