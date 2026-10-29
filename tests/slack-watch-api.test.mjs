import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-slack-watch-api-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
process.env.CEREBRO_SLACK_USER = 'UFRED';
process.env.CEREBRO_SLACK_USER_TOKEN = 'user-token';
process.env.CEREBRO_SLACK_API_URL = 'http://slack.test/api';
mock.method(os, 'homedir', () => root);
syncBuiltinESMExports();

const { CerebroDatabase } = await import('../server/db.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');
const { DAY_MS } = await import('../server/slack-state.ts');
const { parseSlackPermalink } = await import('../bin/slack-permalink.mjs');
mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});
// Faux Slack vide : la surveillance ne lit rien pendant ces tests ; les autres appels (CLI) passent.
const realFetch = globalThis.fetch;
mock.method(globalThis, 'fetch', async (url, init) => {
  if (!String(url).startsWith('http://slack.test/')) return realFetch(url, init);
  return new Response(JSON.stringify({ ok: true, messages: [], has_more: false }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

let app;
let db;
let session;
const send = (method, path, payload, token = 'token') =>
  app.inject({
    method,
    url: `/api/slack-watch/${session.id}${path}`,
    headers: { 'x-cerebro-token': token },
    ...(payload === undefined ? {} : { payload }),
  });
const savedWatches = () => JSON.parse(readFileSync(join(root, 'data', 'slack-state.json'), 'utf8')).watches;

before(async () => {
  app = await buildServer();
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
      status: 'idle',
      agentSessionId: 'fake',
    },
    'token',
  );
});

after(async () => {
  db.close();
  await app.close();
  mock.restoreAll();
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
});

test('une session crée, renouvelle, liste et retire ses surveillances', async () => {
  const before = Date.now() / 1000;
  const created = await send('POST', '', { channel: 'C0C7TN7UBKL', threadTs: '1700000000.000100', label: 'G54' });
  assert.equal(created.statusCode, 201);
  const { watch, renewed } = created.json();
  assert.equal(renewed, false);
  assert.equal(watch.sessionId, session.id);
  assert.equal(watch.threadTs, '1700000000.000100');
  assert.equal(watch.label, 'G54');
  // Sans `since`, seul ce qui sera posté ensuite est remis : l'historique n'est pas réinjecté.
  assert.ok(Number(watch.lastTs) >= before && Number(watch.lastTs) <= Date.now() / 1000);
  assert.ok(Math.abs(watch.expiresAt - (Date.now() + 7 * DAY_MS)) < 5_000);
  assert.deepEqual(savedWatches()[session.id], [watch]);

  // Même fil : la surveillance est renouvelée, pas dupliquée ; `since` antérieur fait relire depuis là.
  const again = await send('POST', '', {
    channel: 'C0C7TN7UBKL',
    threadTs: '1700000000.000100',
    deliver: ['dm', 'inject'],
    since: '1690000000.000000',
  });
  assert.equal(again.statusCode, 200);
  const renewedWatch = again.json().watch;
  assert.equal(again.json().renewed, true);
  assert.equal(renewedWatch.id, watch.id);
  assert.equal(renewedWatch.label, 'G54');
  assert.deepEqual(renewedWatch.deliver, ['inject', 'dm']);
  assert.equal(renewedWatch.lastTs, '1690000000.000000');
  assert.ok(renewedWatch.expiresAt >= watch.expiresAt);

  const channel = (await send('POST', '', { channel: 'C0C7TN7UBKL', since: '1700000001.000000' })).json().watch;
  assert.equal(channel.threadTs, null);
  assert.equal(channel.lastTs, '1700000001.000000');

  const listed = (await send('GET', '')).json().watches;
  assert.deepEqual(
    listed.map(({ id }) => id),
    [watch.id, channel.id],
  );

  assert.equal((await send('DELETE', '/1700000000.000100')).json().removed[0].id, watch.id);
  assert.equal((await send('DELETE', `/${watch.id}`)).statusCode, 404);
  assert.equal((await send('DELETE', '/C0C7TN7UBKL')).json().removed[0].id, channel.id);
  assert.deepEqual((await send('GET', '')).json().watches, []);
  assert.equal(savedWatches()[session.id], undefined);
});

test('les demandes invalides et les jetons étrangers sont refusés', async () => {
  for (const body of [
    {},
    { channel: 'pmo-tpm' },
    { channel: 'C1X', threadTs: 'hier' },
    { channel: 'C1X', deliver: [] },
    { channel: 'C1X', deliver: ['email'] },
    { channel: 'C1X', since: 'maintenant' },
    { channel: 'C1X', label: 'x'.repeat(201) },
  ]) {
    const response = await send('POST', '', body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.equal(typeof response.json().error, 'string');
  }
  assert.equal((await send('POST', '', { channel: 'C1X' }, 'autre')).statusCode, 403);
  assert.equal((await send('GET', '', undefined, 'autre')).statusCode, 403);
  assert.equal((await send('DELETE', '/C1X', undefined, 'autre')).statusCode, 403);
});

test('un permalien Slack donne le canal et le fil', () => {
  assert.deepEqual(parseSlackPermalink('https://blacktiger.slack.com/archives/C0C7TN7UBKL/p1700000000000100'), {
    channel: 'C0C7TN7UBKL',
    threadTs: '1700000000.000100',
  });
  // Réponse dans un fil : le fil est celui de thread_ts.
  assert.deepEqual(
    parseSlackPermalink(
      'https://blacktiger.slack.com/archives/C0C7TN7UBKL/p1700000500000200?thread_ts=1700000000.000100&cid=C0C7TN7UBKL',
    ),
    { channel: 'C0C7TN7UBKL', threadTs: '1700000000.000100' },
  );
  assert.deepEqual(parseSlackPermalink('https://app.slack.com/archives/D012ABC'), {
    channel: 'D012ABC',
    threadTs: null,
  });
  assert.equal(parseSlackPermalink('C0C7TN7UBKL'), null);
  assert.equal(parseSlackPermalink('https://example.com/archives/C0C7TN7UBKL/p1700000000000100'), null);
  assert.equal(parseSlackPermalink('https://x.slack.com/messages/C0C7TN7UBKL'), null);
});

function runCli(args, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'cerebro-slack-watch'), ...args], {
      env: { ...process.env, CEREBRO_SESSION_ID: session.id, CEREBRO_TOKEN: 'token', CEREBRO_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('cerebro-slack-watch ajoute depuis un permalien, liste et retire', async () => {
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const link = 'https://blacktiger.slack.com/archives/C0C7TN7UBKL/p1700000500000200?thread_ts=1700000000.000100';
  const added = await runCli(['add', link, '--label', 'Objectif G54', '--deliver', 'inject,notify'], url);
  assert.equal(added.code, 0, added.stderr);
  assert.match(
    added.stdout,
    /Surveillance ajoutée : \w+ {2}fil C0C7TN7UBKL 1700000000\.000100 « Objectif G54 » remise inject,notify/,
  );
  assert.match((await runCli(['add', link], url)).stdout, /Surveillance renouvelée/);

  const listed = await runCli(['list', '--json'], url);
  assert.equal(listed.code, 0, listed.stderr);
  const [watch] = JSON.parse(listed.stdout);
  assert.equal(watch.channel, 'C0C7TN7UBKL');
  assert.deepEqual(watch.deliver, ['inject', 'notify']);

  const invalid = await runCli(['add', 'C0C7TN7UBKL', '--deliver', 'email'], url);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /^cerebro-slack-watch : deliver invalide/);

  const removed = await runCli(['remove', link], url);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, new RegExp(`Surveillance retirée : ${watch.id}`));
  assert.match((await runCli(['list'], url)).stdout, /Aucune surveillance Slack/);
  assert.match((await runCli(['remove', watch.id], url)).stderr, /Surveillance introuvable/);
});

// Réponse réelle du connecteur claude.ai relevée dans hooks.jsonl : un tableau de blocs texte contenant du JSON.
const connectorResponse = (channel, ts, threadTs) => [
  {
    type: 'text',
    text: JSON.stringify({
      message_link: `https://blacktiger.slack.com/archives/${channel}/p${ts.replace('.', '')}${
        threadTs === undefined ? '' : `?thread_ts=${threadTs}&cid=${channel}`
      }`,
      message_context: { message_ts: ts, channel_id: channel },
    }),
  },
];
const postHook = (payload) =>
  app.inject({
    method: 'POST',
    url: `/api/hook/${session.id}`,
    headers: { 'x-cerebro-token': 'token' },
    payload: { agent: 'claude', event: 'PostToolUse', payload: { hook_event_name: 'PostToolUse', ...payload } },
  });
const sendMessage = (input, response) =>
  postHook({ tool_name: 'mcp__claude_ai_Slack__slack_send_message', tool_input: input, tool_response: response });
const watchesNow = async () => (await send('GET', '')).json().watches;
const setAutoOnPost = async (value) =>
  assert.equal(
    (await app.inject({ method: 'PATCH', url: '/api/slack', payload: { watchAutoOnPost: value } })).statusCode,
    200,
  );

test('un post Slack de la session fait surveiller son fil', async () => {
  for (const watch of await watchesNow()) await send('DELETE', `/${watch.id}`);

  // Réponse dans un fil : le fil lui-même est surveillé, à partir du message posté.
  const inThread = await sendMessage(
    { channel_id: 'C0C7TN7UBKL', thread_ts: '1791814714.374869', message: 'TYPE: status' },
    connectorResponse('C0C7TN7UBKL', '1792072444.259979', '1791814714.374869'),
  );
  assert.equal(inThread.statusCode, 204);
  let [watch] = await watchesNow();
  assert.equal(watch.channel, 'C0C7TN7UBKL');
  assert.equal(watch.threadTs, '1791814714.374869');
  assert.equal(watch.lastTs, '1792072444.259979');

  // Second post dans le même fil : renouvelée, pas dupliquée.
  await sendMessage(
    { channel_id: 'C0C7TN7UBKL', thread_ts: '1791814714.374869', message: 'suite' },
    connectorResponse('C0C7TN7UBKL', '1792072959.696299', '1791814714.374869'),
  );
  assert.equal((await watchesNow()).length, 1);

  // Message de niveau haut adressé à un utilisateur : le ts retourné devient le fil, dans le DM réel (D…).
  await sendMessage(
    { channel_id: 'U08S6E8KHGS', message: 'test de notification' },
    connectorResponse('D08S6E8KHQA', '1792062453.744629'),
  );
  watch = (await watchesNow()).find((candidate) => candidate.channel === 'D08S6E8KHQA');
  assert.equal(watch?.threadTs, '1792062453.744629');
  assert.equal(watch.lastTs, '1792062453.744629');

  // Message programmé dans un fil : le fil est surveillé ; programmé au niveau haut : rien à surveiller encore.
  await postHook({
    tool_name: 'mcp__claude_ai_Slack__slack_schedule_message',
    tool_input: { channel_id: 'C0SCHED', thread_ts: '1700000000.000100', message: 'plus tard', post_at: 1 },
    tool_response: [{ type: 'text', text: '{}' }],
  });
  await postHook({
    tool_name: 'mcp__claude_ai_Slack__slack_schedule_message',
    tool_input: { channel_id: 'C0SCHED', message: 'plus tard', post_at: 1 },
    tool_response: [{ type: 'text', text: '{}' }],
  });
  assert.deepEqual(
    (await watchesNow()).filter(({ channel }) => channel === 'C0SCHED').map(({ threadTs }) => threadTs),
    ['1700000000.000100'],
  );

  // Charge utile inattendue ou autre outil : ignorés sans erreur pour le hook.
  const warn = mock.method(console, 'warn', () => {});
  try {
    assert.equal((await sendMessage({ channel_id: 'C0OTHER', message: 'x' }, 'ok')).statusCode, 204);
    assert.equal((await sendMessage({ channel_id: 'C0OTHER', thread_ts: 'hier', message: 'x' }, [])).statusCode, 204);
    assert.equal(warn.mock.callCount(), 2);
  } finally {
    warn.mock.restore();
  }
  await postHook({
    tool_name: 'mcp__claude_ai_Slack__slack_read_thread',
    tool_input: { channel_id: 'C0OTHER', message_ts: '1700000000.000100' },
    tool_response: connectorResponse('C0OTHER', '1700000000.000100'),
  });
  assert.equal((await watchesNow()).length, 3);
  assert.equal(savedWatches()[session.id].length, 3);
});

test('watchAutoOnPost désactivé : un post Slack ne surveille rien', async () => {
  for (const watch of await watchesNow()) await send('DELETE', `/${watch.id}`);
  await setAutoOnPost(false);
  try {
    await sendMessage(
      { channel_id: 'C0C7TN7UBKL', thread_ts: '1791814714.374869', message: 'TYPE: status' },
      connectorResponse('C0C7TN7UBKL', '1792072444.259979', '1791814714.374869'),
    );
    await sendMessage(
      { channel_id: 'C0C7TN7UBKL', message: 'nouveau' },
      connectorResponse('C0C7TN7UBKL', '1792080000.000100'),
    );
    assert.deepEqual(await watchesNow(), []);
  } finally {
    await setAutoOnPost(true);
  }
});

test("l'interface web règle la surveillance, liste toutes les surveillances et en retire une", async () => {
  const status = (await app.inject({ method: 'GET', url: '/api/slack' })).json();
  assert.equal(status.enabled, false);
  assert.equal(status.watchEnabled, true);

  const patch = {
    watchDeliveryLive: ['inject', 'notify'],
    watchDeliveryEnded: [],
    watchIntervalSec: 60,
    watchTtlDays: 3,
    watchIncludeSelf: true,
    watchAutoOnPost: false,
  };
  const patched = await app.inject({ method: 'PATCH', url: '/api/slack', payload: patch });
  assert.equal(patched.statusCode, 200);
  assert.deepEqual({ ...patched.json(), ...patch }, patched.json());
  const saved = JSON.parse(readFileSync(join(root, 'data', 'slack.json'), 'utf8'));
  assert.deepEqual({ ...saved, ...patch }, saved);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/slack' })).json(), patched.json());
  // Au moins un mode tant que la session tourne.
  assert.equal(
    (await app.inject({ method: 'PATCH', url: '/api/slack', payload: { watchDeliveryLive: [] } })).statusCode,
    400,
  );
  await app.inject({
    method: 'PATCH',
    url: '/api/slack',
    payload: {
      watchDeliveryLive: ['inject'],
      watchDeliveryEnded: ['dm'],
      watchIntervalSec: 30,
      watchTtlDays: 7,
      watchIncludeSelf: false,
      watchAutoOnPost: true,
    },
  });

  for (const watch of (await send('GET', '')).json().watches) await send('DELETE', `/${watch.id}`);
  const { watch } = (await send('POST', '', { channel: 'C0C7TN7UBKL', threadTs: '1700000000.000200' })).json();
  const listed = (await app.inject({ method: 'GET', url: '/api/slack/watches' })).json();
  assert.equal(listed.enabled, true);
  assert.deepEqual(listed.watches, [watch]);

  assert.deepEqual(listed.defaultDeliver, ['inject']);
  assert.equal(listed.botEnabled, false);

  // Remise propre à la surveillance, puis retour aux réglages.
  const deliver = (payload) =>
    app.inject({ method: 'PATCH', url: `/api/slack/watches/${session.id}/${watch.id}`, payload });
  const set = await deliver({ deliver: ['notify', 'inject', 'notify'] });
  assert.equal(set.statusCode, 200);
  assert.deepEqual(set.json().watch.deliver, ['inject', 'notify']);
  assert.deepEqual(savedWatches()[session.id][0].deliver, ['inject', 'notify']);
  for (const payload of [{ deliver: [] }, { deliver: ['post'] }, {}])
    assert.equal((await deliver(payload)).statusCode, 400);
  const reset = await deliver({ deliver: null });
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().watch.deliver, undefined);
  assert.equal(savedWatches()[session.id][0].deliver, undefined);
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/slack/watches/${session.id}/inconnue`,
        payload: { deliver: null },
      })
    ).statusCode,
    404,
  );

  const removed = await app.inject({ method: 'DELETE', url: `/api/slack/watches/${session.id}/${watch.id}` });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().removed[0].id, watch.id);
  assert.equal(
    (await app.inject({ method: 'DELETE', url: `/api/slack/watches/${session.id}/${watch.id}` })).statusCode,
    404,
  );
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/slack/watches' })).json().watches, []);
});

test('PATCH /api/projects/:id règle les envois Slack du projet, ou le rend aux réglages de la machine', async () => {
  const url = `/api/projects/${session.projectId}`;
  const patch = (slackSettings) => app.inject({ method: 'PATCH', url, payload: { slackSettings } });
  const custom = {
    mode: 'custom',
    waiting: true,
    idle: false,
    agentMessages: true,
    watchDeliveryLive: ['dm', 'inject'],
    watchDeliveryEnded: [],
  };
  const saved = await patch(custom);
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().slackSettings, { ...custom, watchDeliveryLive: ['inject', 'dm'] });
  assert.deepEqual(db.getProject(session.projectId).slackSettings, saved.json().slackSettings);
  for (const invalid of [{ ...custom, mode: 'auto' }, { ...custom, watchDeliveryLive: [] }, 'off'])
    assert.equal((await patch(invalid)).statusCode, 400);
  assert.equal((await patch({ ...custom, mode: 'off' })).json().slackSettings.mode, 'off');
  const reset = await patch(null);
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().slackSettings, null);
});
