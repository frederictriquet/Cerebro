import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-operation-retry-'));
process.env.CEREBRO_DATA_DIR = root;
const { CerebroDatabase } = await import('../server/db.ts');
const { OperationResults } = await import('../server/operation-results.ts');
const db = new CerebroDatabase(join(root, 'test.db'));
after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

let counter = 0;
function operations({ retryDelays = [5, 5, 5], send }) {
  const results = new OperationResults(db);
  const errors = [];
  results.delay = () => 0;
  results.retryDelays = retryDelays;
  results.wanted = () => true;
  results.onError = cause => errors.push(cause);
  results.send = send;
  return { results, errors };
}
function record(results, finishedAt = Date.now()) {
  const id = `push:${++counter}`;
  results.record({ id, projectId: null, sessionId: null, kind: 'push', ok: false, summary: 'origin : failed', startedAt: finishedAt - 1000, finishedAt });
  return id;
}
async function until(ready) {
  for (let attempt = 0; attempt < 300; attempt++) { if (ready()) return; await delay(5); }
  assert.fail('État attendu non atteint.');
}

test('a failed Slack send retries with backoff without waiting for a restart', async () => {
  let attempts = 0;
  const { results, errors } = operations({ send: async () => { if (++attempts < 3) throw new Error('429'); return true; } });
  try {
    const id = record(results);
    await until(() => results.get(id).notifiedAt !== null);
    assert.equal(attempts, 3);
    assert.equal(errors.length, 2);
    await delay(30);
    assert.equal(attempts, 3, 'un résultat notifié ne doit plus être renvoyé');
  } finally { results.close(); }
});

test('retries stop once the backoff schedule is exhausted', async () => {
  let attempts = 0;
  const { results, errors } = operations({ retryDelays: [5, 5], send: async () => { attempts++; throw new Error('réseau'); } });
  try {
    const id = record(results);
    await until(() => attempts === 3);
    await delay(40);
    assert.equal(attempts, 3, 'un premier envoi puis un essai par palier');
    assert.equal(errors.length, 3);
    assert.equal(results.get(id).notifiedAt, null);
  } finally { results.close(); }
});

test('results older than 24 hours are not retried', async () => {
  let attempts = 0;
  const { results } = operations({ send: async () => { attempts++; throw new Error('timeout'); } });
  try {
    record(results, Date.now() - 86_400_000 - 1000);
    await until(() => attempts === 1);
    await delay(40);
    assert.equal(attempts, 1);
  } finally { results.close(); }
});

test('a result seen before the retry cancels it', async () => {
  let attempts = 0;
  const { results } = operations({ retryDelays: [30], send: async () => { attempts++; throw new Error('429'); } });
  try {
    const id = record(results);
    await until(() => attempts === 1);
    results.seen(id);
    await delay(60);
    assert.equal(attempts, 1);
  } finally { results.close(); }
});
