import assert from 'node:assert/strict';
import { test } from 'node:test';
import { llmStats } from '../web/src/llm-stats.ts';

// Local calendar dates: the period includes today and the six previous days.
const now = new Date(2026, 9, 19, 14).getTime();
const date = (day, hour = 0) => new Date(2026, 9, day, hour).getTime();
const session = (agent, createdAt, model = null, status = 'exited') => ({ agent, createdAt, model, status });

test('périodes calendaires : bornes incluses, sessions terminées et exclusion des dates futures', () => {
  const sessions = [
    session('claude', date(12, 23)),
    session('claude', date(13)),
    session('codex', now, 'gpt-test', 'running'),
    session('grok', now + 1),
    session('grok', new Date(2026, 8, 20).getTime()),
    session('grok', new Date(2026, 8, 19, 23).getTime()),
  ];
  assert.deepEqual(llmStats(sessions, '7d', now).map((r) => r.count), [1, 1, 0]);
  assert.deepEqual(llmStats(sessions, '30d', now).map((r) => r.count), [2, 1, 1]);
  assert.deepEqual(llmStats(sessions, 'all', now).map((r) => r.count), [2, 1, 2]);
});

test('répartition par agent et modèle, sans déduire le modèle choisi par défaut', () => {
  const sessions = [
    session('codex', now, null, 'starting'),
    session('codex', now, 'custom', 'running'),
    session('codex', now, 'custom', 'waiting'),
    session('codex', now, null, 'idle'),
    session('claude', now, 'custom'),
  ];
  const [claude, codex, grok] = llmStats(sessions, 'all', now);
  assert.equal(claude.count, 1);
  assert.equal(claude.active, 0);
  assert.equal(codex.count, 4);
  assert.equal(codex.active, 2);
  assert.deepEqual(codex.models, [{ model: null, count: 2 }, { model: 'custom', count: 2 }]);
  assert.deepEqual(grok, { agent: 'grok', count: 0, active: 0, models: [], tokens: null, measured: 0, partial: false });
  assert.equal(llmStats([], '7d', now).every((r) => r.count === 0 && r.models.length === 0), true);
});

test('tokens des sessions sélectionnées : totaux, cache inclus une seule fois et couverture partielle', () => {
  const sessions = [
    { ...session('codex', now), id: 'new' },
    { ...session('codex', now), id: 'missing' },
    { ...session('codex', date(1)), id: 'old' },
    { ...session('grok', now), id: 'grok' },
  ];
  const tokens = { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 800, cacheWriteInputTokens: 0 };
  const usage = [
    { sessionId: 'new', tokens, partial: false },
    { sessionId: 'old', tokens, partial: false },
    { sessionId: 'grok', tokens, partial: true },
  ];
  const [, codex, grok] = llmStats(sessions, '7d', now, usage);
  assert.deepEqual(codex.tokens, tokens);
  assert.equal(codex.measured, 1);
  assert.equal(codex.count, 2);
  assert.equal(grok.partial, true);
  assert.equal(llmStats(sessions, 'all', now, usage)[1].tokens.inputTokens, 2000);
});
