import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// A fake `claude` on PATH only makes the agent available: the discovery itself is injected.
const root = mkdtempSync(join(tmpdir(), 'cerebro-catalog-keep-'));
const bin = join(root, 'bin');
mkdirSync(bin);
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.PATH = `${bin}:/usr/bin:/bin`;
writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n');
chmodSync(join(bin, 'claude'), 0o755);

const { Catalog } = await import('../server/catalog.ts');

after(() => rmSync(root, { recursive: true, force: true }));

const model = (value, efforts) => ({ value, label: value, description: '', efforts });
const opus = model('opus', ['low', 'medium', 'high', 'xhigh', 'max']);
const fable = model('fable', ['low', 'high']);
const sonnet = model('sonnet', ['low', 'medium', 'high']);
const answer = (models) => ({ models, efforts: models[0].efforts, defaultModel: models[0].value });

test("un modèle omis par une découverte reste proposé jusqu'à trois omissions consécutives", async () => {
  const answers = [
    answer([opus, fable, sonnet]),
    answer([opus, sonnet]),
    new Error('CLI indisponible'),
    answer([opus, sonnet]),
    answer([opus, sonnet]),
  ];
  const discover = () => {
    const next = answers.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const catalog = new Catalog({}, { claude: discover });
  const claude = async () => (await catalog.get()).claude;
  const values = async () => (await claude()).models.map((m) => m.value);

  await catalog.refresh();
  assert.deepEqual(await values(), ['opus', 'fable', 'sonnet']);

  // Second discovery without fable: kept after the CLI's models, with its own efforts.
  await catalog.refresh();
  assert.deepEqual(await values(), ['opus', 'sonnet', 'fable']);
  assert.deepEqual((await claude()).models.find((m) => m.value === 'fable').efforts, ['low', 'high']);
  assert.deepEqual(catalog.parseTuning('claude', { model: 'fable', effort: 'low' }), { model: 'fable', effort: 'low' });
  assert.equal(catalog.parseTuning('claude', { model: 'fable', effort: 'max' }), null);

  // A failed discovery does not count as an omission.
  const warn = console.warn;
  console.warn = () => {};
  try {
    await catalog.refresh();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(await values(), ['opus', 'sonnet', 'fable']);

  await catalog.refresh();
  assert.deepEqual(await values(), ['opus', 'sonnet', 'fable']);

  // Third consecutive successful discovery without fable: removed.
  await catalog.refresh();
  assert.deepEqual(await values(), ['opus', 'sonnet']);
  assert.equal(catalog.parseTuning('claude', { model: 'fable' }), null);
});

test('un modèle listé à nouveau remet son compteur à zéro', async () => {
  const answers = [
    answer([opus, fable]),
    answer([opus]),
    answer([opus]),
    answer([opus, fable]),
    answer([opus]),
    answer([opus]),
  ];
  const catalog = new Catalog({}, { claude: () => Promise.resolve(answers.shift()) });
  for (let i = 0; i < 6; i++) await catalog.refresh();
  assert.deepEqual(
    (await catalog.get()).claude.models.map((m) => m.value),
    ['opus', 'fable'],
  );
});

test('le repli initial ne compte pas comme déjà vu', async () => {
  const catalog = new Catalog({}, { claude: () => Promise.resolve(answer([fable])) });
  await catalog.refresh();
  assert.deepEqual(
    (await catalog.get()).claude.models.map((m) => m.value),
    ['fable'],
  );
});
