/* global window, document -- simulés via globalThis dans le test. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-alert-ack-'));
process.env.CEREBRO_DATA_DIR = root;
process.env.HOME = root;
process.env.CEREBRO_SLACK_TOKEN = 'test';
process.env.CEREBRO_SLACK_USER = 'test';

let focused = false;
globalThis.window = Object.assign(new EventTarget(), { location: { hash: '#/s/watched' } });
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => focused });

const { sessionIsOpenAndVisible, sessionIsWatched } = await import('../web/src/notify.ts');
const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { SlackNotifier } = await import('../server/slack.ts');

const db = new CerebroDatabase(':memory:');
const manager = new SessionManager(db, createServices(db));
const notifier = new SlackNotifier(manager, db, {
  ready: Promise.resolve(),
  owns: () => true,
  setSlackPoster: () => {},
});
const project = db.createProject('Demo', root);
const posted = [];
mock.method(notifier, 'slackApi', async (method, body) => {
  if (method === 'chat.postMessage') posted.push(body);
  if (method === 'conversations.open') return { ok: true, channel: { id: 'DM' } };
  return { ok: true, ts: String(Date.now()), channel: 'DM' };
});
mock.method(manager, 'screenText', () => ['screen']);
notifier.updateSettings({ idle: true, waiting: true, delaySeconds: 0.02 });
after(() => {
  notifier.stop();
  mock.restoreAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const wait = () => new Promise((resolve) => setTimeout(resolve, 70));

// Reproduit le cas « alert » du store : n'acquitte que si la session est réellement regardée.
async function receiveAlert(id) {
  const session = db.createSession(
    {
      id,
      projectId: project.id,
      agent: 'codex',
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
  notifier.onSessionEvent({ type: 'session', session });
  window.location.hash = `#/s/${id}`;
  manager.setReliableState(id, 'waiting', 'Permission requise');
  if (sessionIsWatched(id)) manager.seen(id);
  await wait();
}

test('an alert on a displayed but unfocused session keeps attention and still reaches Slack', async () => {
  focused = false;
  const before = posted.length;
  await receiveAlert('unfocused');
  assert.equal(sessionIsOpenAndVisible('unfocused'), true, 'visibilityState alone would have acknowledged it');
  assert.equal(db.getSession('unfocused').attention, true);
  assert.equal(posted.length, before + 1);
  assert.match(posted.at(-1).text, /Permission requise/);
});

test('an alert on the session the user is actually looking at is acknowledged', async () => {
  focused = true;
  const before = posted.length;
  await receiveAlert('focused');
  assert.equal(db.getSession('focused').attention, false);
  assert.equal(posted.length, before);
});

test('sessionIsWatched requires the route, a visible document and window focus', () => {
  window.location.hash = '#/m/devbox/s/abc';
  focused = true;
  assert.equal(sessionIsWatched('abc'), true);
  assert.equal(sessionIsWatched('abc', 'devbox'), true);
  assert.equal(sessionIsWatched('abc', null), false);
  assert.equal(sessionIsWatched('other'), false);
  document.visibilityState = 'hidden';
  assert.equal(sessionIsWatched('abc'), false);
  document.visibilityState = 'visible';
  focused = false;
  assert.equal(sessionIsWatched('abc'), false);
});
