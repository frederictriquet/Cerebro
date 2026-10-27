import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Fausse CLI claude qui ne répond jamais et ignore SIGTERM : seul SIGKILL l'arrête.
const root = mkdtempSync(join(tmpdir(), 'cerebro-catalog-claude-'));
const bin = join(root, 'bin');
const pids = join(root, 'pids');
mkdirSync(bin);
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.PATH = `${bin}:/usr/bin:/bin`;
writeFileSync(join(bin, 'claude'), `#!/bin/sh\ntrap '' TERM\necho $$ >> '${pids}'\nexec sleep 600\n`);
chmodSync(join(bin, 'claude'), 0o755);

const { discoverClaude } = await import('../server/catalog.ts');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let spawned = [];
after(() => {
  for (const pid of spawned) if (alive(pid)) process.kill(pid, 'SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

test('découverte claude expirée : la CLI lancée par le SDK est tuée', async () => {
  await assert.rejects(discoverClaude(500), /délai dépassé/);
  spawned = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
  assert.equal(spawned.length, 1);
  // Le SDK envoie SIGTERM 2 s après close(), puis SIGKILL 5 s plus tard.
  const deadline = Date.now() + 10_000;
  while (spawned.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(spawned.filter(alive), []);
});
