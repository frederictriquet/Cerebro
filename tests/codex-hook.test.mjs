import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Un CODEX_HOME jetable : aucun rollout réel n'est lu.
const root = mkdtempSync(join(tmpdir(), 'cerebro-codex-hook-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
after(() => rmSync(root, { recursive: true, force: true }));

const { handleHook } = await import('../server/hooks.ts');

function recorder() {
  const calls = [];
  const sessions = {
    setAgentSessionId: (...args) => calls.push(['setAgentSessionId', ...args]),
    setReliableState: (...args) => calls.push(['setReliableState', ...args]),
    reportTurnComplete: (...args) => calls.push(['reportTurnComplete', ...args]),
  };
  return { calls, sessions };
}

function writeRollout(threadId, daysAgo) {
  const day = new Date(Date.now() - daysAgo * 86_400_000);
  const pad = (n) => String(n).padStart(2, '0');
  const dir = join(
    process.env.CODEX_HOME,
    'sessions',
    String(day.getFullYear()),
    pad(day.getMonth() + 1),
    pad(day.getDate()),
  );
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `rollout-${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T10-00-00-${threadId}.jsonl`,
  );
  writeFileSync(path, '{}\n');
  return path;
}

const turnComplete = (threadId) => ({
  type: 'agent-turn-complete',
  'thread-id': threadId,
  'last-assistant-message': 'Fini',
});

test('a Codex thread resumed days after its creation is still recognised by its rollout', () => {
  const threadId = '019a0000-aaaa-4bbb-8ccc-000000000003';
  const rollout = writeRollout(threadId, 3);
  const { calls, sessions } = recorder();
  handleHook(sessions, 's1', 'codex', 'notify', turnComplete(threadId));
  assert.deepEqual(calls, [
    ['setAgentSessionId', 's1', threadId],
    ['setReliableState', 's1', 'idle', 'Tour terminé'],
    ['reportTurnComplete', 's1', 'Fini'],
  ]);

  // Thread validated once: later notifies no longer depend on the file system.
  rmSync(rollout);
  const second = recorder();
  handleHook(second.sessions, 's1', 'codex', 'notify', turnComplete(threadId));
  assert.equal(second.calls.length, 3);
});

test('Codex helper threads without a rollout stay ignored', () => {
  writeRollout('019a0000-aaaa-4bbb-8ccc-000000000004', 0);
  const { calls, sessions } = recorder();
  handleHook(sessions, 's2', 'codex', 'notify', turnComplete('019a0000-aaaa-4bbb-8ccc-00000000ffff'));
  handleHook(sessions, 's2', 'codex', 'notify', turnComplete('*'));
  assert.deepEqual(calls, []);
});

test('a missed Codex thread skips the full rollout scan for a while, but not its day folders', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const resumed = '019a0000-aaaa-4bbb-8ccc-000000000005';
  const fresh = '019a0000-aaaa-4bbb-8ccc-000000000006';
  const { calls, sessions } = recorder();
  handleHook(sessions, 's3', 'codex', 'notify', turnComplete(resumed));
  handleHook(sessions, 's3', 'codex', 'notify', turnComplete(fresh));
  assert.deepEqual(calls, []);

  // An old rollout is only found by the full scan, which the miss cache holds back.
  writeRollout(resumed, 3);
  handleHook(sessions, 's3', 'codex', 'notify', turnComplete(resumed));
  assert.deepEqual(calls, []);

  // A rollout written after the first notification lands in today's folder: seen at once.
  writeRollout(fresh, 0);
  handleHook(sessions, 's3', 'codex', 'notify', turnComplete(fresh));
  assert.deepEqual(calls[0], ['setAgentSessionId', 's3', fresh]);

  t.mock.timers.tick(60_000);
  const later = recorder();
  handleHook(later.sessions, 's3', 'codex', 'notify', turnComplete(resumed));
  assert.deepEqual(later.calls[0], ['setAgentSessionId', 's3', resumed]);
});
