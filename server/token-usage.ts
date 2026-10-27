import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../shared/types.ts';
import type { SessionTokenUsage, TokenCounts } from '../shared/machine.ts';
import { codexHome, listCodexRollouts } from './codex-config.ts';
import { iterateJsonl } from './jsonl.ts';
import { asRecord } from './util.ts';

const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const empty = (): TokenCounts => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 });

function counts(value: unknown, claude = false, grok = false): TokenCounts | null {
  const usage = asRecord(value);
  if (usage === null) return null;
  const input = count(usage[grok ? 'prompt_tokens' : 'input_tokens']);
  const output = count(usage[grok ? 'completion_tokens' : 'output_tokens']);
  if (input === null || output === null) return null;
  const cached = count(usage[claude ? 'cache_read_input_tokens' : grok ? 'cached_prompt_tokens' : 'cached_input_tokens']) ?? 0;
  const written = count(usage[claude ? 'cache_creation_input_tokens' : 'cache_write_input_tokens']) ?? 0;
  return { inputTokens: input + (claude ? cached + written : 0), outputTokens: output, cachedInputTokens: cached, cacheWriteInputTokens: written };
}

/** CLI transcript schemas: only usage counters are retained, never message content. */
export class TokenAccumulator {
  private messages = new Map<string, TokenCounts>();
  private codex: TokenCounts | null = null;
  private grok = new Map<string, Map<string, TokenCounts>>();

  accept(agent: Session['agent'], value: unknown): void {
    const event = asRecord(value);
    if (event === null) return;
    if (agent === 'claude' && event.type === 'assistant') {
      const message = asRecord(event.message);
      const tokens = counts(message?.usage, true);
      if (typeof message?.id !== 'string' || tokens === null) return;
      // Streaming tool/text blocks repeat the same message id. Later blocks may update output usage.
      const before = this.messages.get(message.id) ?? empty();
      this.messages.set(message.id, {
        inputTokens: Math.max(before.inputTokens, tokens.inputTokens),
        outputTokens: Math.max(before.outputTokens, tokens.outputTokens),
        cachedInputTokens: Math.max(before.cachedInputTokens, tokens.cachedInputTokens),
        cacheWriteInputTokens: Math.max(before.cacheWriteInputTokens, tokens.cacheWriteInputTokens),
      });
    } else if (agent === 'codex') {
      const payload = asRecord(event.payload);
      const usage = event.type === 'token_usage_record' ? payload?.thread_token_usage
        : event.type === 'event_msg' && payload?.type === 'token_count' ? asRecord(payload.info)?.total_token_usage : null;
      // Cumulative counters already include cached input and reasoning output. Never sum snapshots.
      this.codex = counts(usage) ?? this.codex;
    } else if (agent === 'grok' && event.msg === 'shell.turn.inference_done' && typeof event.sid === 'string' && typeof event.ts === 'string') {
      const tokens = counts(event.ctx, false, true);
      if (tokens === null) return;
      const messages = this.grok.get(event.sid) ?? new Map<string, TokenCounts>();
      messages.set(`${event.ts}:${asRecord(event.ctx)?.loop_index ?? ''}`, tokens);
      this.grok.set(event.sid, messages);
    }
  }

  total(agent: Session['agent'], id = ''): TokenCounts | null {
    if (agent === 'codex') return this.codex;
    const entries = agent === 'claude' ? this.messages : this.grok.get(id);
    if (entries === undefined || entries.size === 0) return null;
    return [...entries.values()].reduce((sum, t) => ({
      inputTokens: sum.inputTokens + t.inputTokens,
      outputTokens: sum.outputTokens + t.outputTokens,
      cachedInputTokens: sum.cachedInputTokens + t.cachedInputTokens,
      cacheWriteInputTokens: sum.cacheWriteInputTokens + t.cacheWriteInputTokens,
    }), empty());
  }
}

async function files(root: string, depth: number): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(join(root, entry.name));
      else if (entry.isDirectory() && depth > 0) found.push(...await files(join(root, entry.name), depth - 1));
    }
    return found;
  } catch { return []; }
}

interface Roots { claude: string; codex: string; grok: string }

/** Bytes kept from each end of the consumed prefix to detect in-place rewrites. */
const PROBE = 4096;

interface Parsed {
  stamp: string;
  inode: number;
  size: number;
  offset: number;
  /** Bytes [0, min(PROBE, offset)) and [offset - tail.length, offset) as they were parsed. */
  head: Buffer;
  tail: Buffer;
  data: TokenAccumulator;
}

/** True when the bytes already parsed still read the same on disk at both ends of the prefix. */
async function prefixUnchanged(path: string, cached: Parsed): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    for (const [expected, position] of [[cached.head, 0], [cached.tail, cached.offset - cached.tail.length]] as const) {
      const actual = Buffer.alloc(expected.length);
      const { bytesRead } = await handle.read(actual, 0, expected.length, position);
      if (bytesRead !== expected.length || !actual.equals(expected)) return false;
    }
    return true;
  } finally { await handle.close(); }
}

export class TokenUsageTracker {
  private roots: Roots;
  private cache = new Map<string, Parsed>();
  private pending: Promise<SessionTokenUsage[]> | null = null;
  private last: { key: string; at: number; result: SessionTokenUsage[] } | null = null;

  constructor(roots: Roots = {
    claude: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    codex: codexHome(),
    grok: process.env.GROK_HOME ?? join(homedir(), '.grok'),
  }) { this.roots = roots; }

  async get(sessions: readonly Session[]): Promise<SessionTokenUsage[]> {
    const key = JSON.stringify(sessions.map((s) => [s.id, s.agent, s.agentSessionId]));
    if (this.pending !== null) { await this.pending; return this.get(sessions); }
    if (this.last?.key === key && Date.now() - this.last.at < 30_000) return this.last.result;
    this.pending = this.read(sessions);
    try {
      const result = await this.pending;
      this.last = { key, at: Date.now(), result };
      return result;
    } finally { this.pending = null; }
  }

  private async parse(agent: Session['agent'], path: string): Promise<TokenAccumulator | null> {
    try {
      const info = await stat(path);
      const stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
      const cached = this.cache.get(path);
      if (cached?.stamp === stamp) return cached.data;
      // CLI journals are assumed append-only: reuse counters and read only appended bytes. Same inode
      // and a larger size are not enough, since a file can be rewritten in place (truncate then write)
      // and grow: also require both ends of the parsed prefix to be unchanged, otherwise reread it all.
      // A rewrite that keeps both 4 KiB windows identical but alters bytes between them goes unnoticed.
      const append = cached !== undefined && cached.inode === info.ino && info.size > cached.size
        && await prefixUnchanged(path, cached);
      const data = append ? cached.data : new TokenAccumulator();
      let offset = append ? cached.offset : 0;
      let head = append ? cached.head : Buffer.alloc(0);
      let window = append ? cached.tail : Buffer.alloc(0);
      // A valid last record without a newline is usable. Revisit it after the next append;
      // each provider's accumulator deduplicates it, including streaming Claude messages.
      if (info.size > offset) offset = await iterateJsonl(path, offset, info.size, (record) => data.accept(agent, record), (consumed) => {
        // Consumed bytes directly follow the previous offset, so both windows stay contiguous.
        if (head.length < PROBE) head = Buffer.from(Buffer.concat([head, consumed]).subarray(0, PROBE));
        window = Buffer.from(Buffer.concat([window, consumed]).subarray(-PROBE));
      });
      this.cache.set(path, { stamp, inode: info.ino, size: info.size, offset, head, tail: window, data });
      return data;
    } catch { this.cache.delete(path); return null; }
  }

  private async read(sessions: readonly Session[]): Promise<SessionTokenUsage[]> {
    const agents = new Set(sessions.map((s) => s.agent));
    const [claude, codex] = await Promise.all([
      agents.has('claude') ? files(join(this.roots.claude, 'projects'), 1) : [],
      agents.has('codex') ? listCodexRollouts(join(this.roots.codex, 'sessions')) : [],
    ]);
    // Grok's updates._meta.totalTokens is not an API usage counter: use inference completion logs.
    const grokPath = join(this.roots.grok, 'logs', 'unified.jsonl');
    const grok = agents.has('grok') ? await this.parse('grok', grokPath) : null;
    const usedPaths = new Set<string>([grokPath]);
    const result: SessionTokenUsage[] = [];
    for (const session of sessions) {
      const id = session.agentSessionId;
      let tokens: TokenCounts | null = null;
      if (id !== null) {
        if (session.agent === 'grok') tokens = grok?.total('grok', id) ?? null;
        else {
          const paths = session.agent === 'claude' ? claude : codex;
          const suffix = session.agent === 'claude' ? `/${id}.jsonl` : `-${id}.jsonl`;
          const candidates = paths.filter((p) => p.endsWith(suffix));
          // A copied transcript is still the same session: take the most recently modified copy.
          const dated = await Promise.all(candidates.map(async (path) => ({ path, mtime: await stat(path).then(s => s.mtimeMs, () => 0) })));
          dated.sort((a, b) => b.mtime - a.mtime);
          const path = dated[0]?.path;
          if (path !== undefined) {
            usedPaths.add(path);
            tokens = (await this.parse(session.agent, path))?.total(session.agent) ?? null;
          }
        }
      }
      result.push({ sessionId: session.id, tokens, partial: session.agent === 'grok' && tokens !== null });
    }
    for (const path of this.cache.keys()) if (!usedPaths.has(path)) this.cache.delete(path);
    return result;
  }
}
