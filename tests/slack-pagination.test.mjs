import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test, mock } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-slack-pages-'));
process.env.CEREBRO_DATA_DIR = root;
process.env.HOME = root;
process.env.CEREBRO_SLACK_TOKEN = 'test';
process.env.CEREBRO_SLACK_USER = 'test';
process.env.CEREBRO_SLACK_API_URL = 'http://slack.test/api';
const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { SlackNotifier } = await import('../server/slack.ts');
const db = new CerebroDatabase(':memory:');
const manager = new SessionManager(db, createServices(db));
const peers = { ready: Promise.resolve(), owns: () => true, setSlackPoster: () => {} };
const notifier = new SlackNotifier(manager, db, peers);
clearInterval(notifier.pollTimer);
const project = db.createProject('Demo', root);
const ts = (i) => `1700000001.${String(i).padStart(6, '0')}`;
// Faux Slack : l'historique renvoie les plus récents d'abord, les réponses de fil dans l'ordre chronologique,
// chacun par pages de `limit` avec has_more et next_cursor (l'index du prochain message).
let dm = [];
let thread = [];
const calls = [];
const page = (all, body) => {
  const start = Number(body.cursor ?? 0);
  const items = all.filter((message) => message.ts > body.oldest).slice(start, start + Number(body.limit));
  const next = start + items.length;
  const more = next < all.filter((message) => message.ts > body.oldest).length;
  return { ok: true, messages: items, has_more: more, response_metadata: { next_cursor: more ? String(next) : '' } };
};
mock.method(globalThis, 'fetch', async (url, init) => {
  const method = String(url).replace('http://slack.test/api/', '');
  const body = Object.fromEntries(new URLSearchParams(init.body));
  calls.push({ method, body });
  const payload =
    method === 'conversations.open'
      ? { ok: true, channel: { id: 'DM' } }
      : method === 'conversations.history'
        ? page([...dm].reverse(), body)
        : method === 'conversations.replies'
          ? page(thread, body)
          : { ok: true, ts: '1' };
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
});
const handled = [];
mock.method(notifier, 'handleDmMessage', async (channel, message) => {
  handled.push(message.text);
});
const injected = [];
mock.method(notifier.poller, 'injectReply', async (sessionId, kind, text) => {
  injected.push(text);
  return true;
});
after(() => {
  notifier.stop();
  mock.restoreAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('le DM suit le curseur Slack et traite tous les messages dans l’ordre chronologique', async () => {
  notifier.state.dmCursor = '1700000000.000000';
  dm = Array.from({ length: 450 }, (_, i) => ({ ts: ts(i), text: `cmd ${i}`, user: 'test' }));
  await notifier.poller.pollDm();
  assert.deepEqual(
    handled,
    dm.map((message) => message.text),
    'aucune commande perdue, dans l’ordre',
  );
  assert.equal(notifier.state.dmCursor, ts(449));
  const history = calls.filter((call) => call.method === 'conversations.history');
  assert.equal(history.length, 3, 'trois pages de 200');
  assert.deepEqual(
    history.map((call) => call.body.cursor),
    [undefined, '200', '400'],
  );
  // Plus rien de nouveau : une seule lecture, aucune commande rejouée.
  handled.length = 0;
  calls.length = 0;
  await notifier.poller.pollDm();
  assert.deepEqual(handled, []);
  assert.equal(calls.filter((call) => call.method === 'conversations.history').length, 1);
});

test('un fil paginé est lu jusqu’au bout, ou repris depuis le dernier message lu', async () => {
  db.createSession(
    {
      id: 's1',
      projectId: project.id,
      agent: 'codex',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: 's1',
      status: 'idle',
      agentSessionId: 's1',
    },
    'token',
  );
  const root = '1700000000.500000';
  const active = {
    channel: 'DM',
    ts: root,
    lastTs: root,
    kind: 'alert',
    createdAt: Date.now(),
    polledAt: Date.now(),
    answered: false,
    awaitingReply: false,
    skipTurnEnd: false,
    moreTurns: false,
    questions: null,
    fromDm: false,
  };
  notifier.threads.set('s1', active);
  thread = [
    { ts: root, text: 'parent', user: 'test', bot_id: 'B' },
    ...Array.from({ length: 250 }, (_, i) => ({ ts: ts(i), text: `r ${i}`, user: 'test' })),
  ];
  await notifier.poller.pollThread('s1', active);
  assert.deepEqual(
    injected,
    thread.slice(1).map((message) => message.text),
  );
  assert.equal(active.lastTs, ts(249));
  // Budget épuisé : la première page est traitée, la suite reprend au prochain passage sans trou.
  injected.length = 0;
  thread.push(...Array.from({ length: 300 }, (_, i) => ({ ts: ts(250 + i), text: `r ${250 + i}`, user: 'test' })));
  const take = mock.method(notifier.poller, 'takeThreadPoll', () => false);
  await notifier.poller.pollThread('s1', active);
  assert.deepEqual(
    injected,
    thread.slice(251, 451).map((message) => message.text),
  );
  take.mock.restore();
  await notifier.poller.pollThread('s1', active);
  assert.deepEqual(
    injected,
    thread.slice(251).map((message) => message.text),
  );
  assert.equal(active.lastTs, ts(549));
});
