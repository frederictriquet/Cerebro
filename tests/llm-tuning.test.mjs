import assert from 'node:assert/strict';
import { test } from 'node:test';

const { Catalog, defaultEffort } = await import('../server/catalog.ts');

test('défaut Cerebro : modèle du catalogue et effort high quand rien n’est choisi', async () => {
  const catalog = new Catalog();
  assert.equal((await catalog.get()).claude.defaultModel, 'opus');
  assert.deepEqual(catalog.parseTuning('claude', {}), { model: 'opus', effort: 'high' });
  assert.deepEqual(catalog.parseTuning('claude', { model: null, effort: null }), { model: 'opus', effort: 'high' });
});

test('valeurs explicites conservées, valeurs hors catalogue refusées', () => {
  const catalog = new Catalog();
  assert.deepEqual(catalog.parseTuning('claude', { model: 'haiku', effort: 'max' }), { model: 'haiku', effort: 'max' });
  assert.deepEqual(catalog.parseTuning('claude', { model: 'haiku', effort: null }), { model: 'haiku', effort: 'high' });
  assert.equal(catalog.parseTuning('claude', { model: 'inconnu' }), null);
  assert.equal(catalog.parseTuning('claude', { model: 'haiku', effort: 'ultra' }), null);
});

test('un catalogue fourni remplace le repli de ses agents seulement, sans état partagé entre instances', () => {
  const codex = { value: 'gpt-test', label: 'GPT test', description: '', efforts: ['low', 'high'] };
  const known = new Catalog({ codex: { models: [codex], efforts: codex.efforts, defaultModel: codex.value } });
  assert.deepEqual(known.parseTuning('codex', {}), { model: 'gpt-test', effort: 'high' });
  assert.deepEqual(known.parseTuning('claude', {}), { model: 'opus', effort: 'high' });
  assert.equal(new Catalog().parseTuning('codex', { model: 'gpt-test' }), null);
});

test('effort par défaut : high s’il est proposé, sinon le premier niveau', () => {
  assert.equal(defaultEffort(['low', 'high', 'max']), 'high');
  assert.equal(defaultEffort(['low', 'max']), 'low');
  assert.equal(defaultEffort([]), null);
});

test('mode « default » non proposé : lu comme « auto » par le serveur', async () => {
  const { normalizeMode } = await import('../shared/types.ts');
  assert.equal(normalizeMode('default'), 'auto');
  assert.equal(normalizeMode('plan'), 'plan');
});
