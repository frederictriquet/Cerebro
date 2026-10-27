import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test, mock } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-slack-budget-'));
process.env.CEREBRO_DATA_DIR = root;
process.env.HOME = root;
process.env.CEREBRO_SLACK_TOKEN = 'test';
process.env.CEREBRO_SLACK_USER = 'test';
process.env.CEREBRO_SLACK_API_URL = 'http://slack.test/api';
const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { SlackNotifier, POLL_CALLS_PER_MINUTE } = await import('../server/slack.ts');
const db = new CerebroDatabase(':memory:');
const manager = new SessionManager(db, createServices(db));
const peers = { ready: Promise.resolve(), owns: () => true, setSlackPoster: () => {} };
const notifier = new SlackNotifier(manager, db, peers);
clearInterval(notifier.pollTimer);
const project = db.createProject('Demo', root);
// Horloge simulée : chaque appel de lecture Slack est daté pour vérifier le plafond sur une minute glissante.
let now = Date.now();
mock.method(Date, 'now', () => now);
const reads = [];
mock.method(globalThis, 'fetch', async (url, init) => {
  const method = String(url).replace('http://slack.test/api/', '');
  const body = Object.fromEntries(new URLSearchParams(init.body));
  if (method === 'conversations.history' || method === 'conversations.replies')
    reads.push({ method, ts: body.ts, at: now });
  const payload = method === 'conversations.open' ? { ok: true, channel: { id: 'DM' } } : { ok: true, messages: [] };
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
});
after(() => {
  notifier.stop();
  mock.restoreAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('ten fresh threads are polled in turn within the shared per-minute budget', async () => {
  for (let i = 0; i < 10; i++) {
    const id = `s${i}`;
    db.createSession(
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
    const ts = `1700000000.00000${i}`;
    notifier.threads.set(id, {
      channel: 'DM',
      ts,
      lastTs: ts,
      kind: 'alert',
      createdAt: now,
      polledAt: now,
      answered: false,
      awaitingReply: false,
      skipTurnEnd: false,
      moreTurns: false,
      questions: null,
      fromDm: false,
    });
  }
  // Trois minutes de ticks à 5 s : sans budget, 11 lectures par tick (132/min).
  const ticks = 36;
  for (let i = 0; i < ticks; i++) {
    now += 5_000;
    await notifier.poll();
  }
  for (const call of reads) {
    const inWindow = reads.filter((other) => other.at > call.at - 60_000 && other.at <= call.at).length;
    assert.ok(inWindow <= POLL_CALLS_PER_MINUTE, `${inWindow} lectures sur une minute glissante`);
  }
  assert.equal(
    reads.filter((call) => call.method === 'conversations.history').length,
    ticks,
    'le DM est interrogé à chaque tick',
  );
  const perThread = new Map();
  for (const call of reads)
    if (call.method === 'conversations.replies') perThread.set(call.ts, (perThread.get(call.ts) ?? 0) + 1);
  assert.equal(perThread.size, 10, 'chaque fil frais est interrogé');
  const counts = [...perThread.values()];
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `répartition équitable : ${counts}`);
  assert.ok(reads.length >= POLL_CALLS_PER_MINUTE * 2, 'le budget est utilisé, pas seulement plafonné');
});
