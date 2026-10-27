import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const configUrl = new URL('../server/config.ts', import.meta.url).href;
process.env.CEREBRO_DATA_DIR = mkdtempSync(join(tmpdir(), 'cerebro-config-'));
delete process.env.CEREBRO_PORT;
const { DEFAULT_PORT, parsePort } = await import('../server/config.ts');

test('parsePort accepte un entier entre 1 et 65535 et retombe sur le port par défaut', () => {
  assert.equal(parsePort(undefined), DEFAULT_PORT);
  assert.equal(parsePort('1'), 1);
  assert.equal(parsePort('8080'), 8080);
  assert.equal(parsePort('65535'), 65535);
});

test('parsePort refuse les valeurs invalides avec un message explicite', () => {
  for (const invalid of ['', ' ', 'abc', '0', '65536', '-1', '4317.5', '12abc', '0x10', '1e3', ' 4317']) {
    assert.throws(() => parsePort(invalid), /CEREBRO_PORT invalide.*entier entre 1 et 65535/, JSON.stringify(invalid));
  }
});

test.after(() => rmSync(process.env.CEREBRO_DATA_DIR, { recursive: true, force: true }));

test('un CEREBRO_PORT invalide arrête le démarrage avec un message explicite', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cerebro-config-port-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(configUrl)});`,
      ],
      {
        env: { ...process.env, CEREBRO_DATA_DIR: dataDir, CEREBRO_PORT: 'abc' },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /\[config\] CEREBRO_PORT invalide : « abc » \(entier entre 1 et 65535 attendu\)/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
