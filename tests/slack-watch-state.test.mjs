import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test, mock } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-slack-watch-state-'));
process.env.CEREBRO_DATA_DIR = root;
process.env.HOME = root;
process.env.CEREBRO_SLACK_API_URL = 'http://slack.test/api';
delete process.env.CEREBRO_SLACK_USER_TOKEN;
const { CerebroDatabase } = await import('../server/db.ts');
const { SlackState, newWatch, slackWatchFrom } = await import('../server/slack-state.ts');
const { slackUserTransport, SlackTransport } = await import('../server/slack-api.ts');
const { SLACK_WATCH_ENABLED, SLACK_WATCH_UNCONFIGURED } = await import('../server/config.ts');
const { withoutCerebroVariables } = await import('../server/agent-env.ts');
const db = new CerebroDatabase(':memory:');
const project = db.createProject('Demo', root);
const session = (id, status) =>
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
      status,
      agentSessionId: null,
    },
    `token-${id}`,
  );
session('live', 'running');
session('ended', 'exited');
after(() => {
  mock.restoreAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('watches survive a reload, exited sessions included, expired or orphan ones dropped', () => {
  const errors = [];
  const state = new SlackState((error) => errors.push(error));
  const thread = newWatch({ sessionId: 'live', channel: 'C1', threadTs: '1700000000.000100' }, 7);
  const channel = newWatch(
    { sessionId: 'live', channel: 'C2', threadTs: null, deliver: ['dm', 'notify'], label: 'PMO' },
    1,
  );
  const ended = newWatch({ sessionId: 'ended', channel: 'D3', threadTs: '1700000000.000200' }, 7);
  const expired = { ...newWatch({ sessionId: 'ended', channel: 'C4', threadTs: null }, 1), expiresAt: Date.now() - 1 };
  const orphan = newWatch({ sessionId: 'gone', channel: 'C5', threadTs: null }, 7);
  state.watches.set('live', [thread, channel]);
  state.watches.set('ended', [ended, expired]);
  state.watches.set('gone', [orphan]);
  state.watches.set('empty', []);
  state.changed();
  const saved = JSON.parse(readFileSync(join(root, 'slack-state.json'), 'utf8'));
  assert.equal(saved.watches.empty, undefined);
  assert.equal(saved.watches.live.length, 2);

  const reloaded = new SlackState((error) => errors.push(error));
  reloaded.load(db);
  assert.deepEqual(errors, []);
  assert.deepEqual(reloaded.watches.get('live'), [thread, channel]);
  assert.deepEqual(reloaded.watches.get('ended'), [ended]);
  assert.equal(reloaded.watches.has('gone'), false);
  assert.ok(thread.expiresAt - thread.createdAt === 7 * 24 * 60 * 60 * 1_000);
});

test('invalid watches are reported and skipped on reload, the rest of the state kept', async () => {
  const { writeFileSync } = await import('node:fs');
  const good = newWatch({ sessionId: 'live', channel: 'C1', threadTs: null }, 7);
  writeFileSync(
    join(root, 'slack-state.json'),
    JSON.stringify({
      dmCursor: '1700000000.000001',
      threads: 'oops',
      watches: {
        live: [
          good,
          { ...good }, // duplicate id
          { ...good, id: 'other', sessionId: 'ended' }, // filed under the wrong session
          { ...good, id: 'bad-mode', deliver: ['shout'] },
        ],
        ended: 'oops',
      },
    }),
  );
  const errors = [];
  const state = new SlackState((error) => errors.push(error));
  state.load(db);
  assert.equal(state.dmCursor, '1700000000.000001');
  assert.deepEqual(state.watches.get('live'), [good]);
  assert.equal(state.watches.has('ended'), false);
  assert.equal(errors.length, 5);
});

test('slackWatchFrom validates every field', () => {
  const watch = newWatch({ sessionId: 'live', channel: 'C1', threadTs: '1700000000.000100' }, 7);
  assert.deepEqual(slackWatchFrom(watch), watch);
  assert.deepEqual(slackWatchFrom({ ...watch, deliver: ['notify', 'inject', 'notify'] }).deliver, ['inject', 'notify']);
  assert.equal(slackWatchFrom({ ...watch, label: '' }).label, undefined);
  for (const broken of [
    { ...watch, id: '' },
    { ...watch, channel: '' },
    { ...watch, threadTs: 'yesterday' },
    { ...watch, threadTs: undefined },
    { ...watch, lastTs: 12 },
    { ...watch, expiresAt: Number.NaN },
    { ...watch, deliver: [] },
    { ...watch, deliver: 'dm' },
    { ...watch, label: 'x'.repeat(201) },
  ]) {
    assert.equal(slackWatchFrom(broken), null, JSON.stringify(broken));
  }
});

test('the user token transport only reads, and is disabled without CEREBRO_SLACK_USER_TOKEN', async () => {
  assert.equal(SLACK_WATCH_ENABLED, false);
  await assert.rejects(slackUserTransport().call('conversations.replies', {}), { message: SLACK_WATCH_UNCONFIGURED });
  const requests = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), authorization: init.headers.authorization });
    return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
  });
  const transport = slackUserTransport('xoxp-test');
  await transport.call('conversations.replies', { channel: 'C1', ts: '1' });
  await assert.rejects(transport.call('chat.postMessage', { channel: 'C1', text: 'hi' }), /non autorisée/);
  await assert.rejects(transport.call('reactions.add', {}), /non autorisée/);
  assert.deepEqual(requests, [
    { url: 'http://slack.test/api/conversations.replies', authorization: 'Bearer xoxp-test' },
  ]);
  // The bot transport keeps every method, and its own rate limit window.
  await assert.rejects(new SlackTransport().call('chat.postMessage', {}), { message: "Slack n'est pas configuré" });
  mock.restoreAll();
});

test('agents never receive the user token', () => {
  const env = withoutCerebroVariables({ PATH: '/bin', CEREBRO_SLACK_USER_TOKEN: 'xoxp-secret', CEREBRO_SLACK_TOKEN: 'x' });
  assert.deepEqual(env, { PATH: '/bin' });
});
