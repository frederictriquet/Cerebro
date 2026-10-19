import { AGENTS, type Agent, type Session } from './types.ts';
import type { SessionTokenUsage, TokenCounts } from './api.ts';

export type UsagePeriod = '7d' | '30d' | 'all';

export interface AgentStats {
  agent: Agent;
  count: number;
  active: number;
  tokens: TokenCounts | null;
  measured: number;
  partial: boolean;
  models: { model: string | null; count: number }[];
}

/** Count retained Cerebro sessions by creation date, including completed sessions. */
export function llmStats(sessions: readonly Session[], period: UsagePeriod, now: number, usage: readonly SessionTokenUsage[] = []): AgentStats[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (period === '7d' ? 6 : 29));
  const since = period === 'all' ? -Infinity : start.getTime();
  const tokensBySession = new Map(usage.map((u) => [u.sessionId, u.tokens]));
  const partialSessions = new Set(usage.filter((u) => u.partial).map((u) => u.sessionId));
  return AGENTS.map((agent) => {
    const selected = sessions.filter((s) => s.agent === agent && s.createdAt >= since && s.createdAt <= now);
    const models = new Map<string | null, number>();
    for (const session of selected) models.set(session.model, (models.get(session.model) ?? 0) + 1);
    const measured = selected.flatMap((s) => tokensBySession.get(s.id) ?? []);
    const tokens = measured.length === 0 ? null : measured.reduce((sum, t) => ({
      inputTokens: sum.inputTokens + t.inputTokens,
      outputTokens: sum.outputTokens + t.outputTokens,
      cachedInputTokens: sum.cachedInputTokens + t.cachedInputTokens,
      cacheWriteInputTokens: sum.cacheWriteInputTokens + t.cacheWriteInputTokens,
    }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
    return {
      agent,
      count: selected.length,
      active: selected.filter((s) => s.status === 'starting' || s.status === 'running').length,
      tokens,
      measured: measured.length,
      partial: selected.some((s) => partialSessions.has(s.id)),
      models: [...models].map(([model, count]) => ({ model, count }))
        .sort((a, b) => b.count - a.count || (a.model ?? '').localeCompare(b.model ?? '')),
    };
  });
}
