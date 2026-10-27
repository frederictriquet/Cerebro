import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test, mock } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-notify-'));
process.env.CEREBRO_DATA_DIR = root;
process.env.HOME = root;
process.env.CEREBRO_SLACK_TOKEN = 'test';
process.env.CEREBRO_SLACK_USER = 'test';
const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { SlackNotifier } = await import('../server/slack.ts');
const db = new CerebroDatabase(':memory:');
const manager = new SessionManager(db);
const peers = { ready: Promise.resolve(), owns: () => true, setSlackPoster: () => {} };
const notifier = new SlackNotifier(manager, db, peers);
const project = db.createProject('Demo', root);
const posted = [];
mock.method(notifier, 'slackApi', async (method, body) => {
  if (method === 'chat.postMessage') posted.push(body);
  if (method === 'conversations.open') return { ok: true, channel: { id: 'DM' } };
  return { ok: true, ts: String(Date.now()), channel: 'DM' };
});
mock.method(manager, 'screenText', () => ['screen']);
notifier.updateSettings({ idle: true, waiting: true, delaySeconds: 0.02 });
function session(id) {
  const s = db.createSession(
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
  notifier.onSessionEvent({ type: 'session', session: s });
  return s;
}
const wait = () => new Promise((r) => setTimeout(r, 70));
after(() => {
  notifier.stop();
  mock.restoreAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
test('already relayed turn ends are not duplicated by automatic alerts', async () => {
  session('relay');
  notifier.threads.set('relay', {
    channel: 'DM',
    ts: '1',
    lastTs: '1',
    kind: 'notify',
    createdAt: Date.now(),
    polledAt: 0,
    answered: false,
    awaitingReply: true,
    skipTurnEnd: false,
    moreTurns: false,
    questions: null,
    fromDm: true,
  });
  const n = posted.length;
  manager.setReliableState('relay', 'idle', 'Tour terminé');
  manager.reportTurnComplete('relay', 'Réponse du tour');
  await wait();
  assert.equal(posted.length, n + 1);
  assert.equal(posted.at(-1).thread_ts, '1');
  assert.match(posted.at(-1).text, /Réponse du tour/);
});
test('simultaneous custom result and automatic alert deduplicate without losing extra context', async () => {
  session('custom');
  const n = posted.length;
  manager.setReliableState('custom', 'idle', 'Tour terminé');
  await notifier.agentMessage('custom', 'notify', 'Contexte supplémentaire');
  await wait();
  assert.equal(posted.length, n + 1);
  assert.match(posted.at(-1).text, /Contexte supplémentaire/);
});
test('unanswered semantic question keeps its thread and is not treated as task completion', async () => {
  session('question');
  const task = db.createTask(project.id, 'open', null);
  db.updateTask(task.id, { status: 'started', sessionId: 'question' });
  const n = posted.length;
  manager.markAsked('question', 'Quel choix ?');
  await notifier.agentMessage('question', 'ask', 'Quel choix ?');
  manager.setReliableState('question', 'idle', 'Tour terminé');
  manager.reportTurnComplete('question', null);
  await wait();
  assert.equal(posted.length, n + 1);
  assert.equal(db.getSession('question').status, 'waiting');
  assert.equal(db.getTask(task.id).status, 'started');
  assert.equal(notifier.threads.get('question').kind, 'ask');
});
test('viewed results and disabled settings cancel automatic notifications; durations stay factual', async () => {
  session('seen');
  const n = posted.length;
  manager.setReliableState('seen', 'idle', 'Tour terminé');
  manager.seen('seen');
  await wait();
  assert.equal(posted.length, n);
  notifier.updateSettings({ idle: false, waiting: false });
  session('disabled');
  manager.setReliableState('disabled', 'idle', 'Tour terminé');
  await wait();
  assert.equal(posted.length, n);
  notifier.updateSettings({ idle: true, waiting: true });
  session('duration');
  db.connection
    .prepare('UPDATE notification_turns SET started_at=? WHERE session_id=?')
    .run(Date.now() - 2100, 'duration');
  manager.setReliableState('duration', 'idle', 'Tour terminé');
  await wait();
  assert.equal(posted.length, n + 1);
  assert.match(posted.at(-1).text, /durée du tour : 2 s/);
});
test('known operation success/failure uses no model, preserves question threads and deduplicates persistence', async () => {
  const base = {
    projectId: project.id,
    sessionId: 'question',
    kind: 'command',
    summary: 'Vérification échouée, code 3',
    startedAt: Date.now() - 3000,
    finishedAt: Date.now(),
  };
  let n = posted.length;
  const questionThread = notifier.threads.get('question');
  notifier.operations.record({ ...base, id: 'failed', ok: false });
  await notifier.operations.deliver('failed');
  await notifier.operations.deliver('failed');
  await wait();
  assert.equal(posted.length, n + 1);
  assert.equal(posted.at(-1).thread_ts, questionThread.ts);
  assert.equal(notifier.threads.get('question'), questionThread);
  notifier.operations.record({ ...base, id: 'seen-operation', ok: true });
  notifier.operations.seen('seen-operation');
  await notifier.operations.deliver('seen-operation');
  await wait();
  assert.equal(posted.length, n + 1);
  notifier.updateSettings({ idle: false });
  notifier.operations.record({ ...base, id: 'disabled-operation', ok: true });
  await notifier.operations.deliver('disabled-operation');
  assert.equal(posted.length, n + 1);
  assert.ok(notifier.operations.get('failed').notifiedAt);
  assert.equal(db.getSession('question').status, 'waiting');
});
test('notification persistence survives notifier recreation without re-sending acknowledged results', async () => {
  const { OperationResults } = await import('../server/operation-results.ts');
  const results = new OperationResults(db);
  const sent = [];
  results.wanted = () => true;
  results.delay = () => 0;
  results.send = async (result) => {
    sent.push(result.id);
    return true;
  };
  results.restore();
  await wait();
  assert.ok(!sent.includes('failed'));
  assert.ok(!sent.includes('seen-operation'));
  results.close();
});

test('operation results acknowledge only confirmed sends and leave skipped or failed sends retryable', async () => {
  const { OperationResults } = await import('../server/operation-results.ts');
  const localDb = new CerebroDatabase(':memory:');
  const results = new OperationResults(localDb);
  results.wanted = () => true;
  results.delay = () => 60_000;
  const id = 'council:pending';
  try {
    results.record({
      id,
      projectId: null,
      sessionId: null,
      kind: 'council',
      ok: true,
      summary: 'Résultat local',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });
    await results.deliver(id);
    assert.equal(results.get(id).notifiedAt, null);
    results.send = async () => false;
    await results.deliver(id);
    assert.equal(results.get(id).notifiedAt, null);
    results.send = async () => {
      throw new Error('Échec Slack');
    };
    await assert.rejects(results.deliver(id), /Échec Slack/);
    assert.equal(results.get(id).notifiedAt, null);
    let sent = 0;
    results.send = async () => {
      sent++;
      return true;
    };
    await Promise.all([results.deliver(id), results.deliver(id)]);
    assert.ok(results.get(id).notifiedAt);
    assert.equal(sent, 1);
    await results.deliver(id);
    assert.equal(sent, 1);
  } finally {
    results.close();
    localDb.close();
  }
});

test('an operation skipped for another project owner stays pending until an actual post', async (t) => {
  notifier.updateSettings({ idle: true });
  let local = false;
  t.mock.method(peers, 'owns', () => local);
  const id = 'pending-owner';
  const n = posted.length;
  notifier.operations.record({
    id,
    projectId: project.id,
    sessionId: null,
    kind: 'command',
    ok: true,
    summary: 'Commande terminée',
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
  });
  await notifier.operations.deliver(id);
  assert.equal(posted.length, n);
  assert.equal(notifier.operations.get(id).notifiedAt, null);
  local = true;
  await notifier.operations.deliver(id);
  assert.equal(posted.length, n + 1);
  assert.ok(notifier.operations.get(id).notifiedAt);
});

test('an operation seen during peer coordination is not acknowledged as sent', async () => {
  const previous = peers.ready;
  const ready = Promise.withResolvers();
  peers.ready = ready.promise;
  const id = 'seen-during-coordination';
  const n = posted.length;
  try {
    notifier.operations.record({
      id,
      projectId: project.id,
      sessionId: null,
      kind: 'command',
      ok: true,
      summary: 'Résultat consulté',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });
    const delivery = notifier.operations.deliver(id);
    notifier.operations.seen(id);
    ready.resolve();
    await delivery;
    assert.equal(posted.length, n);
    assert.ok(notifier.operations.get(id).seenAt);
    assert.equal(notifier.operations.get(id).notifiedAt, null);
  } finally {
    ready.resolve();
    peers.ready = previous;
  }
});
test('a resumed turn drops the previous end-of-turn reason', () => {
  session('resumed');
  manager.setReliableState('resumed', 'idle', 'Tour terminé');
  manager.setRunning('resumed');
  const s = db.getSession('resumed');
  assert.equal(s.status, 'running');
  assert.equal(s.attentionReason, null);
  assert.equal(s.attention, false);
});
