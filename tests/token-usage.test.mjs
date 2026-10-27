import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, mock } from 'node:test';
import { TokenAccumulator, TokenUsageTracker } from '../server/token-usage.ts';

const claude = (id, output) => ({
  type: 'assistant',
  message: {
    id,
    usage: {
      input_tokens: 10,
      output_tokens: output,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    },
  },
});
const counts = (input, output) => ({
  input_tokens: input,
  output_tokens: output,
  cached_input_tokens: 80,
  reasoning_output_tokens: 5,
});
const codex = (input, output) => ({
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: counts(input, output) } },
});
const grok = (sid, ts, loop = 1) => ({
  sid,
  ts,
  msg: 'shell.turn.inference_done',
  ctx: { loop_index: loop, prompt_tokens: 120, cached_prompt_tokens: 80, completion_tokens: 10, reasoning_tokens: 5 },
});

test('Claude : blocs répétés et mises à jour de streaming ne multiplient pas les tokens, cache inclus', () => {
  const reader = new TokenAccumulator();
  reader.accept('claude', claude('one', 2));
  reader.accept('claude', claude('one', 7));
  reader.accept('claude', claude('one', 2));
  reader.accept('claude', claude('two', 3));
  assert.deepEqual(reader.total('claude'), {
    inputTokens: 260,
    outputTokens: 10,
    cachedInputTokens: 200,
    cacheWriteInputTokens: 40,
  });
});

test('Codex : snapshots cumulatifs modernes et historiques, sans addition du cache ou du raisonnement', () => {
  const reader = new TokenAccumulator();
  reader.accept('codex', codex(100, 10));
  reader.accept('codex', codex(300, 30));
  reader.accept('codex', {
    type: 'token_usage_record',
    payload: { usage: counts(50, 5), thread_token_usage: counts(350, 35) },
  });
  reader.accept('codex', { type: 'event_msg', payload: { type: 'token_count', info: null } });
  assert.deepEqual(reader.total('codex'), {
    inputTokens: 350,
    outputTokens: 35,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 0,
  });
});

test('Grok : inférences par session, doublons ignorés ; totalTokens des mises à jour exclu', () => {
  const reader = new TokenAccumulator();
  reader.accept('grok', grok('one', '2026-10-19T10:00:00Z'));
  reader.accept('grok', grok('one', '2026-10-19T10:00:00Z'));
  reader.accept('grok', grok('one', '2026-10-19T10:01:00Z', 2));
  reader.accept('grok', grok('two', '2026-10-19T10:01:00Z'));
  reader.accept('grok', { params: { _meta: { totalTokens: 999999 } } });
  assert.deepEqual(reader.total('grok', 'one'), {
    inputTokens: 240,
    outputTokens: 20,
    cachedInputTokens: 160,
    cacheWriteInputTokens: 0,
  });
  assert.equal(reader.total('grok', 'missing'), null);
});

test('mesures absentes ou invalides restent inconnues ; un vrai relevé à zéro reste zéro', () => {
  const reader = new TokenAccumulator();
  reader.accept('codex', codex(-1, 4));
  reader.accept('codex', codex(Infinity, 4));
  reader.accept('codex', codex('100', 4));
  assert.equal(reader.total('codex'), null);
  reader.accept('codex', codex(0, 0));
  assert.equal(reader.total('codex').inputTokens, 0);
});

test('lecture des journaux locaux : liaison par identifiant, ligne tronquée, reprise, cache et rotation Grok', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cerebro-tokens-'));
  const roots = { claude: join(root, 'claude'), codex: join(root, 'codex'), grok: join(root, 'grok') };
  let now = 100_000;
  const clock = mock.method(Date, 'now', () => now);
  try {
    const claudeDir = join(roots.claude, 'projects', 'project');
    const codexDir = join(roots.codex, 'sessions', '2026', '10', '19');
    const grokDir = join(roots.grok, 'logs');
    for (const dir of [claudeDir, codexDir, grokDir]) await mkdir(dir, { recursive: true });
    await writeFile(join(claudeDir, 'claude-session.jsonl'), JSON.stringify(claude('one', 5)) + '\n');
    const codexPath = join(codexDir, 'rollout-2026-codex-session.jsonl');
    await writeFile(codexPath, JSON.stringify(codex(100, 10)) + '\n{"type":');
    const grokPath = join(grokDir, 'unified.jsonl');
    await writeFile(grokPath, JSON.stringify(grok('grok-session', '2026-10-19T10:00:00Z')) + '\n');
    const sessions = ['claude', 'codex', 'grok'].map((agent) => ({
      id: agent,
      agent,
      agentSessionId: `${agent}-session`,
    }));
    sessions.push({ id: 'unknown', agent: 'codex', agentSessionId: null });
    const tracker = new TokenUsageTracker(roots);
    const first = await tracker.get(sessions);
    assert.deepEqual(
      first.map((s) => s.tokens?.inputTokens ?? null),
      [130, 100, 120, null],
    );
    assert.deepEqual(
      first.map((s) => s.partial),
      [false, false, true, false],
    );
    await appendFile(codexPath, '\n' + JSON.stringify(codex(500, 50)) + '\n');
    await appendFile(
      join(claudeDir, 'claude-session.jsonl'),
      [claude('one', 5), claude('two', 10)].map(JSON.stringify).join('\n') + '\n',
    );
    await appendFile(
      grokPath,
      [grok('grok-session', '2026-10-19T10:00:00Z'), grok('grok-session', '2026-10-19T10:01:00Z', 2)]
        .map(JSON.stringify)
        .join('\n') + '\n',
    );
    assert.equal((await tracker.get(sessions))[1].tokens.inputTokens, 100);
    now += 31_000;
    assert.deepEqual(
      (await tracker.get(sessions)).map((s) => s.tokens?.inputTokens ?? null),
      [260, 500, 240, null],
    );
    // A rotated or removed source must never keep silently serving its previous values.
    await rm(grokPath);
    await rm(join(claudeDir, 'claude-session.jsonl'));
    now += 31_000;
    assert.deepEqual(
      (await tracker.get(sessions)).map((s) => s.tokens?.inputTokens ?? null),
      [null, 500, null, null],
    );
  } finally {
    clock.mock.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('journal réécrit en place, même inode et plus gros : relu entièrement au lieu de garder des compteurs obsolètes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cerebro-tokens-'));
  const roots = { claude: join(root, 'claude'), codex: join(root, 'codex'), grok: join(root, 'grok') };
  let now = 100_000;
  const clock = mock.method(Date, 'now', () => now);
  const lines = (...events) => events.map((e) => JSON.stringify(e) + '\n').join('');
  // Ignored records push the parsed prefix beyond both 4 KiB probe windows.
  const filler = lines(...Array.from({ length: 200 }, (_, i) => ({ type: 'user', i })));
  try {
    const dir = join(roots.claude, 'projects', 'project');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'claude-session.jsonl');
    const sessions = [{ id: 'claude', agent: 'claude', agentSessionId: 'claude-session' }];
    const tracker = new TokenUsageTracker(roots);
    const read = async () => {
      now += 31_000;
      return (await tracker.get(sessions))[0].tokens?.inputTokens ?? null;
    };
    await writeFile(path, lines(claude('one', 5), claude('two', 5)));
    assert.equal(await read(), 260);
    const { ino } = await stat(path);
    // Rewritten from the start: different head.
    await writeFile(path, lines(claude('three', 5)) + filler);
    assert.equal((await stat(path)).ino, ino);
    assert.equal(await read(), 130);
    // Genuine append still reuses the counters.
    await appendFile(path, lines(claude('four', 5)));
    assert.equal(await read(), 260);
    // Same head, but the last parsed record was removed: the tail window catches it.
    await writeFile(path, lines(claude('three', 5)) + filler + lines({ type: 'user', note: 'x'.repeat(400) }));
    assert.equal((await stat(path)).ino, ino);
    assert.equal(await read(), 130);
    await appendFile(path, lines(claude('seven', 5)));
    assert.equal(await read(), 260);
  } finally {
    clock.mock.restore();
    await rm(root, { recursive: true, force: true });
  }
});
