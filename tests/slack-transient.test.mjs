import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, beforeEach, mock, test } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-slack-transient-'));
process.env.CEREBRO_DATA_DIR = root;
process.env.HOME = root;
process.env.CEREBRO_SLACK_TOKEN = 'test';
process.env.CEREBRO_SLACK_USER = 'test';
process.env.CEREBRO_SLACK_API_URL = 'http://slack.test/api';
const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { SlackNotifier } = await import('../server/slack.ts');
const { TRANSIENT_RETRY_DELAYS_MS } = await import('../server/slack-alerts.ts');
const db = new CerebroDatabase(':memory:');
const manager = new SessionManager(db, createServices(db));
const peers = { ready: Promise.resolve(), owns: () => true, setSlackPoster: () => {} };
const notifier = new SlackNotifier(manager, db, peers);
const project = db.createProject('Demo', root);
mock.method(notifier, 'poll', async () => {});
const logged = [];
mock.method(notifier, 'logError', (error) => logged.push(error instanceof Error ? error.message : String(error)));
// Délais réduits : cinq tentatives en quelques millisecondes au lieu d'une minute.
notifier.alerts.transientRetryDelays = [5, 5, 5, 5];

// Faux Slack : chaque appel consomme la panne prévue pour sa méthode (`failures`, rejet d'une Error ou réponse
// en erreur), sinon réussit.
const calls = [];
const failures = new Map();
const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
const network = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('getaddrinfo EAI_AGAIN slack.com'), { code: 'EAI_AGAIN' }),
  });
const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
mock.method(globalThis, 'fetch', async (url, init) => {
  const method = String(url).replace('http://slack.test/api/', '');
  const body = Object.fromEntries(new URLSearchParams(init.body));
  const failure = failures.get(method)?.shift();
  calls.push({ method, body, ok: failure === undefined });
  if (failure !== undefined) {
    const outcome = failure();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
  return json(
    method === 'conversations.open'
      ? { ok: true, channel: { id: 'DM' } }
      : { ok: true, ts: `${calls.length}.0`, channel: 'DM' },
  );
});
function session(id) {
  const s = db.createSession(
    {
      id,
      projectId: project.id,
      agent: 'claude',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: id,
      status: 'running',
      agentSessionId: id,
    },
    'token',
  );
  notifier.onSessionEvent({ type: 'session', session: s });
  return s;
}
const posts = () => calls.filter((call) => call.method === 'chat.postMessage');
async function until(ready, message) {
  for (let i = 0; i < 300; i++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(message);
}
beforeEach(() => {
  calls.length = 0;
  logged.length = 0;
  failures.clear();
});
after(() => {
  notifier.stop();
  mock.restoreAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('les nouvelles tentatives couvrent une minute environ', () => {
  assert.deepEqual(TRANSIENT_RETRY_DELAYS_MS, [2_000, 5_000, 15_000, 30_000]);
});

test("une question en panne passagère (délai, réseau, 5xx) est retentée jusqu'à son envoi, dans l'ordre de la session", async () => {
  session('passagere');
  failures.set('conversations.open', [timeout]);
  failures.set('chat.postMessage', [
    network,
    () => json({ ok: false, error: 'internal_error' }),
    () => new Response('<html>Bad gateway</html>', { status: 502 }),
  ]);
  // Mise en file sans attendre Slack : aucun appel n'a encore abouti au retour.
  assert.equal(notifier.queueAgentMessage('passagere', 'ask', 'Quel environnement ?'), false);
  assert.equal(notifier.queueAgentMessage('passagere', 'notify', 'Précision'), false);
  assert.equal(posts().filter((call) => call.ok).length, 0);
  await until(() => posts().filter((call) => call.ok).length === 2, 'question et précision attendues');
  assert.deepEqual(
    calls.map((call) => `${call.method}:${call.ok ? 'ok' : 'échec'}`),
    [
      'conversations.open:échec',
      'conversations.open:ok',
      'chat.postMessage:échec',
      'chat.postMessage:échec',
      'chat.postMessage:échec',
      'chat.postMessage:ok',
      'chat.postMessage:ok',
    ],
  );
  const [question, precision] = posts().filter((call) => call.ok);
  assert.match(question.body.text, /^:question: .*\nQuel environnement \?\n/s);
  // La précision suit la question, dans son fil : l'ordre de la session est gardé malgré les reprises.
  assert.match(precision.body.text, /Précision/);
  assert.equal(precision.body.thread_ts, notifier.threads.get('passagere').ts);
  assert.equal(notifier.threads.get('passagere').kind, 'ask');
  // Les quatre reprises d'un même message comptent ensemble, ouverture du DM comprise.
  assert.deepEqual(logged, [
    'Slack conversations.open : pas de réponse en 10 s ; nouvelle tentative dans 0.005 s (1/4)',
    'Slack chat.postMessage : erreur réseau (getaddrinfo EAI_AGAIN slack.com) ; nouvelle tentative dans 0.005 s (2/4)',
    'Slack chat.postMessage : internal_error ; nouvelle tentative dans 0.005 s (3/4)',
    'Slack chat.postMessage : HTTP 502 ; nouvelle tentative dans 0.005 s (4/4)',
  ]);
});

test('au-delà des nouvelles tentatives, le message est abandonné et journalisé', async () => {
  session('abandon');
  failures.set(
    'chat.postMessage',
    Array.from({ length: 5 }, () => timeout),
  );
  notifier.queueAgentMessage('abandon', 'ask', 'Toujours là ?');
  await until(() => logged.some((line) => line.startsWith('Envoi abandonné')), 'abandon journalisé attendu');
  assert.equal(posts().length, 5, 'une tentative puis quatre reprises');
  assert.equal(
    logged.at(-1),
    'Envoi abandonné (ask, session abandon) : Slack chat.postMessage : pas de réponse en 10 s',
  );
  // Le suivant de la session n'est pas bloqué par l'abandon.
  notifier.queueAgentMessage('abandon', 'notify', 'Suite');
  await until(() => posts().some((call) => call.ok), 'message suivant attendu');
  assert.match(posts().at(-1).body.text, /Suite/);
});

test("une erreur définitive de Slack n'est pas retentée", async () => {
  session('definitive');
  failures.set('chat.postMessage', [() => json({ ok: false, error: 'not_in_channel' })]);
  notifier.queueAgentMessage('definitive', 'notify', 'Contexte');
  await until(() => logged.length === 1, 'abandon journalisé attendu');
  assert.equal(logged[0], 'Envoi abandonné (notify, session definitive) : not_in_channel');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(posts().length, 1);
});

test("pendant une fenêtre 429, la mise en file l'annonce et l'envoi part à la fin de la fenêtre", async () => {
  session('fenetre');
  notifier.transport.rateLimitedUntil = Date.now() + 100;
  assert.equal(notifier.queueAgentMessage('fenetre', 'ask', 'Après la fenêtre ?'), true);
  assert.equal(posts().length, 0);
  await until(() => posts().some((call) => call.ok), 'envoi après la fenêtre attendu');
  assert.match(posts().at(-1).body.text, /Après la fenêtre \?/);
});
