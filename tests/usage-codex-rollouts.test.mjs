import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCodex } from '../server/usage.ts';

const limits = (used) => JSON.stringify({
  timestamp: '2026-10-27T10:00:00.000Z',
  payload: { type: 'token_count', rate_limits: { primary: { used_percent: used, window_minutes: 300 } } },
});

test('Codex : un rollout supprimé entre readdir et stat est ignoré sans faire échouer la lecture', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cerebro-codex-'));
  const day = join(home, 'sessions', '2026', '10', '27');
  await mkdir(day, { recursive: true });
  const vanishing = join(day, 'rollout-vanishing.jsonl');
  await writeFile(vanishing, `${limits(90)}\n`);
  await writeFile(join(day, 'rollout-kept.jsonl'), `${limits(42)}\n`);

  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  // Codex deletes the rollout right after it was listed, before its stat.
  const realStat = fs.statSync;
  fs.statSync = (path, ...rest) => {
    if (path === vanishing) fs.rmSync(vanishing, { force: true });
    return realStat(path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(async () => {
    fs.statSync = realStat;
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  const usage = await readCodex();
  assert.equal(usage.error, null);
  assert.deepEqual(usage.windows.map((w) => w.percent), [42]);
});
