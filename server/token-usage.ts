import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Session } from './db.ts';

export interface TokenCounts {
  /** All input, including cache reads and writes. Cache fields are subsets. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
}

export interface SessionTokenUsage {
  sessionId: string;
  tokens: TokenCounts | null;
  /** Global Grok logs can rotate independently of session history. */
  partial: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const empty = (): TokenCounts => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 });

function counts(value: unknown, claude = false, grok = false): TokenCounts | null {
  const usage = record(value);
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
    const event = record(value);
    if (event === null) return;
    if (agent === 'claude' && event.type === 'assistant') {
      const message = record(event.message);
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
      const payload = record(event.payload);
      const usage = event.type === 'token_usage_record' ? payload?.thread_token_usage
        : event.type === 'event_msg' && payload?.type === 'token_count' ? record(payload.info)?.total_token_usage : null;
      // Cumulative counters already include cached input and reasoning output. Never sum snapshots.
      this.codex = counts(usage) ?? this.codex;
    } else if (agent === 'grok' && event.msg === 'shell.turn.inference_done' && typeof event.sid === 'string' && typeof event.ts === 'string') {
      const tokens = counts(event.ctx, false, true);
      if (tokens === null) return;
      const messages = this.grok.get(event.sid) ?? new Map<string, TokenCounts>();
      messages.set(`${event.ts}:${record(event.ctx)?.loop_index ?? ''}`, tokens);
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

export class TokenUsageTracker {
  private roots: Roots;
  private cache = new Map<string, { stamp: string; inode: number; size: number; offset: number; data: TokenAccumulator }>();
  private pending: Promise<SessionTokenUsage[]> | null = null;
  private last: { key: string; at: number; result: SessionTokenUsage[] } | null = null;

  constructor(roots: Roots = {
    claude: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    codex: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
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
      // CLI journals are append-only. Reuse counters and read only appended bytes; reset on rotation.
      const append = cached !== undefined && cached.inode === info.ino && info.size > cached.size;
      const data = append ? cached.data : new TokenAccumulator();
      let offset = append ? cached.offset : 0;
      if (info.size > offset) {
        const stream = createReadStream(path, { start: offset, end: info.size - 1 });
        let tail = Buffer.alloc(0);
        const accept = (line: Buffer): void => {
          try { data.accept(agent, JSON.parse(line.toString('utf8'))); } catch { /* Truncated or malformed record. */ }
        };
        try {
          for await (const chunk of stream) {
            tail = Buffer.concat([tail, chunk as Buffer]);
            let start = 0;
            let end: number;
            while ((end = tail.indexOf(10, start)) !== -1) {
              accept(tail.subarray(start, end));
              offset += end - start + 1;
              start = end + 1;
            }
            tail = Buffer.from(tail.subarray(start));
          }
          // A valid last record without a newline is usable. Revisit it after the next append;
          // each provider's accumulator deduplicates it, including streaming Claude messages.
          if (tail.length > 0) accept(tail);
        } finally { stream.destroy(); }
      }
      this.cache.set(path, { stamp, inode: info.ino, size: info.size, offset, data });
      return data;
    } catch { this.cache.delete(path); return null; }
  }

  private async read(sessions: readonly Session[]): Promise<SessionTokenUsage[]> {
    const agents = new Set(sessions.map((s) => s.agent));
    const [claude, codex] = await Promise.all([
      agents.has('claude') ? files(join(this.roots.claude, 'projects'), 1) : [],
      agents.has('codex') ? files(join(this.roots.codex, 'sessions'), 3) : [],
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
