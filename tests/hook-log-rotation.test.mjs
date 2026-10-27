import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-hook-log-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
after(() => rmSync(root, { recursive: true, force: true }));

const { appendHookLog, HOOK_LOG_MAX_BYTES, HOOK_LOG_KEEP } = await import('../server/hook-log.ts');
const { HOOK_LOG, ensureDataDirs } = await import('../server/config.ts');
// config.ts n'écrit rien à l'import : le serveur crée ses dossiers, ici le test.
ensureDataDirs();

const lines = (path) =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).n);

test('hooks.jsonl tourne par taille et ne garde que N archives', () => {
  const path = join(root, 'hooks.jsonl');
  const payload = 'x'.repeat(40);
  // Each line is 61 bytes: 3 lines fit under 200 bytes, the fourth triggers a rotation.
  for (let n = 1; n <= 9; n += 1) appendHookLog({ n, payload }, path, { maxBytes: 200, keep: 2 });

  assert.deepEqual(lines(path), [7, 8, 9]);
  assert.deepEqual(lines(`${path}.1`), [4, 5, 6]);
  assert.deepEqual(lines(`${path}.2`), [1, 2, 3]);
  assert.equal(existsSync(`${path}.3`), false);
});

test('une entrée plus grosse que la limite est quand même écrite', () => {
  const path = join(root, 'big.jsonl');
  appendHookLog({ n: 1, payload: 'y'.repeat(500) }, path, { maxBytes: 100, keep: 1 });
  appendHookLog({ n: 2, payload: 'y'.repeat(500) }, path, { maxBytes: 100, keep: 1 });
  assert.deepEqual(lines(path), [2]);
  assert.deepEqual(lines(`${path}.1`), [1]);
});

test('le journal par défaut vit dans DATA_DIR avec une limite de 20 Mo', () => {
  assert.equal(HOOK_LOG_MAX_BYTES, 20 * 1024 * 1024);
  assert.ok(HOOK_LOG_KEEP >= 1);
  appendHookLog({ n: 1 });
  assert.equal(HOOK_LOG, join(root, 'data', 'hooks.jsonl'));
  assert.deepEqual(lines(HOOK_LOG), [1]);
});
