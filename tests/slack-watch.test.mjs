import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, beforeEach, test, mock } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-slack-watch-'));
process.env.CEREBRO_DATA_DIR = root;
process.env.HOME = root;
process.env.CEREBRO_SLACK_TOKEN = 'bot-token';
process.env.CEREBRO_SLACK_USER = 'UFRED';
process.env.CEREBRO_SLACK_USER_TOKEN = 'user-token';
process.env.CEREBRO_SLACK_API_URL = 'http://slack.test/api';
const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { SlackNotifier } = await import('../server/slack.ts');
const { newWatch } = await import('../server/slack-state.ts');
const { WATCH_CALLS_PER_MINUTE } = await import('../server/slack-watches.ts');
const db = new CerebroDatabase(':memory:');
const manager = new SessionManager(db, createServices(db));
const peers = { ready: Promise.resolve(), owns: () => true, setSlackPoster: () => {} };
const notifier = new SlackNotifier(manager, db, peers);
clearInterval(notifier.pollTimer);
const watcher = notifier.watcher;
const project = db.createProject('Demo', root);
for (const id of ['live', 'ended']) {
  db.createSession(
    {
      id,
      projectId: project.id,
      agent: 'claude',
      mode: 'default',
      model: null,
      effort: null,
      prompt: '',
      title: id,
      status: id === 'live' ? 'idle' : 'exited',
      agentSessionId: null,
    },
    `token-${id}`,
  );
}

// Faux Slack : fils et historiques par canal, appels notés avec le jeton utilisé.
const threads = new Map();
const histories = new Map();
const calls = [];
mock.method(globalThis, 'fetch', async (url, init) => {
  const method = String(url).replace('http://slack.test/api/', '');
  const body = Object.fromEntries(new URLSearchParams(init.body));
  const token = init.headers.authorization.replace('Bearer ', '');
  calls.push({ method, body, token });
  const after = (messages) => messages.filter((message) => Number(message.ts) > Number(body.oldest ?? 0));
  const payload =
    method === 'auth.test'
      ? { ok: true, user_id: 'UCEREBRO', bot_id: 'BCEREBRO' }
      : method === 'conversations.open'
        ? { ok: true, channel: { id: 'DM' } }
        : method === 'conversations.replies'
          ? { ok: true, messages: after(threads.get(`${body.channel}:${body.ts}`) ?? []), has_more: false }
          : method === 'conversations.history'
            ? { ok: true, messages: after(histories.get(body.channel) ?? []).reverse(), has_more: false }
            : method === 'users.info'
              ? { ok: true, user: { name: body.user.toLowerCase(), profile: { display_name: `Nom ${body.user}` } } }
              : method === 'chat.getPermalink'
                ? { ok: true, permalink: `https://slack.test/${body.channel}/p${body.message_ts}` }
                : { ok: true, ts: `${Date.now() / 1000}`, channel: body.channel };
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
});
const typed = [];
mock.method(manager, 'writeInput', (sessionId, data) => {
  typed.push({ sessionId, data });
  return true;
});
const posts = () => calls.filter((call) => call.method === 'chat.postMessage');
const reads = () => calls.filter((call) => call.method.startsWith('conversations.') && call.token === 'user-token');
// Les envois Slack de la remise partent en arrière-plan.
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const ROOT = '1700000000.000100';
const ts = (i) => `1700000001.${String(i).padStart(6, '0')}`;
function watch(sessionId, fields = {}) {
  const created = newWatch({ sessionId, channel: 'C1', threadTs: ROOT, lastTs: ROOT, ...fields }, 7);
  notifier.state.watches.set(sessionId, [...(notifier.state.watches.get(sessionId) ?? []), created]);
  return created;
}
async function settings(patch) {
  assert.ok(notifier.updateSettings(patch));
  await notifier.settingsSaved();
}

beforeEach(async () => {
  notifier.state.watches.clear();
  threads.clear();
  histories.clear();
  calls.length = 0;
  typed.length = 0;
  db.updateSession('live', { status: 'idle' });
  await settings({ watchDeliveryLive: ['inject'], watchDeliveryEnded: ['dm'], watchIncludeSelf: false });
});
after(() => {
  notifier.stop();
  mock.restoreAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('les messages d’un tiers sont tapés dans la session, en une seule injection par cycle', async () => {
  const watched = watch('live', { label: 'PMO' });
  threads.set(`C1:${ROOT}`, [
    { ts: ROOT, text: 'parent', user: 'UFRED' },
    { ts: ts(1), text: 'premier &lt;ok&gt;', user: 'UALICE' },
    { ts: ts(2), text: 'second', user: 'UALICE' },
  ]);
  await watcher.poll();
  assert.deepEqual(
    typed.map(({ data }) => data),
    [
      `[Slack #C1 · thread ${ROOT} · PMO] Nom UALICE : premier <ok>\nhttps://slack.test/C1/p${ts(1)}\n` +
        `[Slack #C1 · thread ${ROOT} · PMO] Nom UALICE : second\nhttps://slack.test/C1/p${ts(2)}`,
      '\r',
    ],
  );
  assert.equal(watched.lastTs, ts(2));
  assert.equal(calls.filter((call) => call.method === 'users.info').length, 1, 'auteur mis en cache');
  assert.ok(
    calls.every((call) => call.token === (call.method === 'auth.test' ? 'bot-token' : 'user-token')),
    'lecture avec le jeton user seulement',
  );
  // Rien de nouveau : rien n’est retapé.
  typed.length = 0;
  await watcher.poll();
  assert.deepEqual(typed, []);
});

test('les messages de l’utilisateur et du bot Cerebro sont ignorés, les bots tiers remis', async () => {
  const watched = watch('live');
  threads.set(`C1:${ROOT}`, [
    { ts: ts(1), text: 'posté par ma session', user: 'UFRED' },
    { ts: ts(2), text: 'alerte Cerebro', user: 'UCEREBRO', bot_id: 'BCEREBRO' },
    { ts: ts(3), text: 'rejoint', user: 'UBOB', subtype: 'channel_join' },
    { ts: ts(4), text: 'réponse PMO', user: 'UPMO', bot_id: 'BPMO', bot_profile: { name: 'Agent PMO' } },
  ]);
  await watcher.poll();
  assert.deepEqual(
    typed.map(({ data }) => data),
    [`[Slack #C1 · thread ${ROOT}] Agent PMO : réponse PMO\nhttps://slack.test/C1/p${ts(4)}`, '\r'],
  );
  assert.equal(watched.lastTs, ts(4), 'le curseur passe aussi les messages filtrés');

  await settings({ watchIncludeSelf: true });
  typed.length = 0;
  threads.get(`C1:${ROOT}`).push({ ts: ts(5), text: 'moi aussi', user: 'UFRED' });
  watcher.polledAt.clear();
  await watcher.poll();
  assert.match(typed[0].data, /Nom UFRED : moi aussi/);
});

test('niveau haut d’un canal : seuls les messages hors fil sont remis', async () => {
  watch('live', { channel: 'C2', threadTs: null });
  histories.set('C2', [
    { ts: ts(1), text: 'nouveau sujet', user: 'UALICE', thread_ts: ts(1) },
    { ts: ts(2), text: 'réponse dans un fil', user: 'UALICE', thread_ts: ts(1) },
    { ts: ts(3), text: 'message simple', user: 'UBOB' },
  ]);
  await watcher.poll();
  assert.equal(reads()[0].method, 'conversations.history');
  assert.equal(reads()[0].body.ts, undefined);
  assert.equal(typed.length, 2);
  assert.match(typed[0].data, /^\[Slack #C2\] Nom UALICE : nouveau sujet\n/);
  assert.match(typed[0].data, /\n\[Slack #C2\] Nom UBOB : message simple\n/);
  assert.doesNotMatch(typed[0].data, /réponse dans un fil/);
});

test('session terminée : le message part en DM, la surveillance reste active', async () => {
  watch('ended');
  threads.set(`C1:${ROOT}`, [{ ts: ts(1), text: 'après la fin', user: 'UALICE' }]);
  await watcher.poll();
  await settle();
  assert.deepEqual(typed, []);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.channel, 'DM');
  assert.equal(posts()[0].token, 'bot-token');
  assert.match(posts()[0].body.text, /\*Demo\* · ended \(claude\) · _session terminée_/);
  assert.match(
    posts()[0].body.text,
    /\*Nom UALICE\* dans #C1 · thread .*<https:\/\/slack.test\/C1\/p.*\|Voir dans Slack>\n> après la fin/,
  );
  assert.equal(notifier.state.watches.get('ended').length, 1);
});

test('session terminée et remise « terminée » vide : rien n’est envoyé', async () => {
  await settings({ watchDeliveryEnded: [] });
  const watched = watch('ended');
  threads.set(`C1:${ROOT}`, [{ ts: ts(1), text: 'perdu', user: 'UALICE' }]);
  await watcher.poll();
  await settle();
  assert.deepEqual(typed, []);
  assert.deepEqual(posts(), []);
  assert.equal(watched.lastTs, ts(1));
});

test('une surveillance expirée est supprimée sans être lue', async () => {
  const expired = watch('ended');
  expired.expiresAt = Date.now() - 1;
  const kept = watch('live');
  await watcher.poll();
  assert.deepEqual(notifier.state.watches.get('live'), [kept]);
  assert.equal(notifier.state.watches.has('ended'), false);
  assert.equal(reads().length, 1);
});

test('la remise propre à une surveillance remplace le réglage de session vivante', async () => {
  watch('live', { deliver: ['dm'] });
  threads.set(`C1:${ROOT}`, [{ ts: ts(1), text: 'en DM', user: 'UALICE' }]);
  await watcher.poll();
  await settle();
  assert.deepEqual(typed, []);
  assert.equal(posts().length, 1);
  assert.match(posts()[0].body.text, /^:speech_balloon: \*Demo\* · live \(claude\)\n/);
});

test('notification : dans le fil de la session, ouvert s’il n’existe pas', async () => {
  await settings({ watchDeliveryLive: ['inject', 'notify'] });
  watch('live');
  threads.set(`C1:${ROOT}`, [{ ts: ts(1), text: 'à notifier', user: 'UALICE' }]);
  await watcher.poll();
  await settle();
  assert.equal(typed.length, 2);
  assert.equal(posts().length, 1);
  assert.match(posts()[0].body.text, /^:bell: /);
  assert.equal(posts()[0].body.thread_ts, undefined);
  assert.equal(notifier.threads.get('live').kind, 'notify', 'le fil de notification devient celui de la session');
  notifier.threads.delete('live');
});

test('une session en attente reçoit les messages à la fermeture du dialogue, une session close en DM', async () => {
  db.updateSession('live', { status: 'waiting' });
  watch('live');
  threads.set(`C1:${ROOT}`, [{ ts: ts(1), text: 'patience', user: 'UALICE' }]);
  await watcher.poll();
  assert.deepEqual(typed, [], 'le dialogue n’est pas fermé');
  db.updateSession('live', { status: 'running' });
  await watcher.poll();
  assert.match(typed[0].data, /patience/);

  typed.length = 0;
  db.updateSession('live', { status: 'waiting' });
  threads.get(`C1:${ROOT}`).push({ ts: ts(2), text: 'trop tard', user: 'UALICE' });
  watcher.polledAt.clear();
  await watcher.poll();
  db.updateSession('live', { status: 'exited' });
  await watcher.poll();
  await settle();
  assert.deepEqual(typed, []);
  assert.equal(posts().length, 1);
  assert.match(posts()[0].body.text, /trop tard/);
});

test('budget de lecture du jeton user et intervalle par surveillance respectés', async () => {
  await settings({ watchIntervalSec: 60 });
  const all = Array.from({ length: WATCH_CALLS_PER_MINUTE + 10 }, (_, i) => watch('live', { channel: `C${i}` }));
  watcher.reads.length = 0;
  await watcher.poll();
  assert.equal(reads().length, WATCH_CALLS_PER_MINUTE);
  // Budget épuisé : rien de plus dans la minute.
  await watcher.poll();
  assert.equal(reads().length, WATCH_CALLS_PER_MINUTE);
  // Budget libéré : les surveillances pas encore lues passent d’abord, les autres attendent leur intervalle.
  watcher.reads.length = 0;
  await watcher.poll();
  assert.equal(reads().length, WATCH_CALLS_PER_MINUTE + 10);
  assert.deepEqual(
    reads()
      .slice(WATCH_CALLS_PER_MINUTE)
      .map((call) => call.body.channel),
    all.slice(WATCH_CALLS_PER_MINUTE).map((created) => created.channel),
  );
  await settings({ watchIntervalSec: 30 });
});
