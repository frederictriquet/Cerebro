import assert from 'node:assert/strict';
import { test } from 'node:test';

const { catalogFor, defaultEffort, parseTuning } = await import('../server/catalog.ts');

test('défaut Cerebro : modèle du catalogue et effort high quand rien n’est choisi', () => {
  assert.equal(catalogFor('claude').defaultModel, 'opus');
  assert.deepEqual(parseTuning('claude', {}), { model: 'opus', effort: 'high' });
  assert.deepEqual(parseTuning('claude', { model: null, effort: null }), { model: 'opus', effort: 'high' });
});

test('valeurs explicites conservées, valeurs hors catalogue refusées', () => {
  assert.deepEqual(parseTuning('claude', { model: 'haiku', effort: 'max' }), { model: 'haiku', effort: 'max' });
  assert.deepEqual(parseTuning('claude', { model: 'haiku', effort: null }), { model: 'haiku', effort: 'high' });
  assert.equal(parseTuning('claude', { model: 'inconnu' }), null);
  assert.equal(parseTuning('claude', { model: 'haiku', effort: 'ultra' }), null);
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
