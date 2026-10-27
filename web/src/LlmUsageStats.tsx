import { useState } from 'react';
import { AgentLabel } from './AgentLabel.tsx';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import { getSessionTokenUsage, type SessionTokenUsage } from './api.ts';
import { llmStats, type UsagePeriod } from './llm-stats.ts';
import { usePolling } from './polling.tsx';
import type { Session } from './types.ts';
import './llm-stats.css';

const number = new Intl.NumberFormat('fr-FR');
const percent = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });

export function LlmUsageStats({ sessions, now }: { sessions: readonly Session[]; now: number }) {
  const [period, setPeriod] = useState<UsagePeriod>('7d');
  const [tokens, setTokens] = useState<SessionTokenUsage[] | null>(null);
  const [failed, setFailed] = useState(false);
  usePolling(getSessionTokenUsage, 30_000, {
    onData: (result) => { setTokens(result); setFailed(false); },
    onError: () => setFailed(true),
  });
  const stats = llmStats(sessions, period, now, tokens ?? []);
  const total = stats.reduce((sum, row) => sum + row.count, 0);

  return (
    <section className="llm-stats" aria-labelledby="llm-stats-title">
      <div className="llm-stats-head">
        <div>
          <h2 id="llm-stats-title">Utilisation des LLM</h2>
          <p>
            <span className="llm-stats-total" aria-live="polite" aria-atomic="true">
              <b>{number.format(total)}</b> {total === 1 ? 'session' : 'sessions'}
            </span> · Répartition par agent
          </p>
        </div>
        <ChoiceGroup<UsagePeriod>
          label="Période des statistiques LLM"
          value={period}
          onChange={setPeriod}
          compact
          options={[
            { value: '7d', label: '7 jours' },
            { value: '30d', label: '30 jours' },
            { value: 'all', label: 'Tout' },
          ]}
        />
      </div>

      <div className="llm-stats-body">
        <div className="llm-stats-bar" aria-hidden="true">
          {stats.filter((row) => row.count > 0).map((row) => (
            <span key={row.agent} className={`llm-stats-segment llm-tone-${row.agent}`}
              style={{ width: `${row.count / total * 100}%` }} />
          ))}
        </div>

        <ul className="llm-stats-agents">
          {stats.map((row) => (
            <li key={row.agent} className={`llm-stats-agent llm-tone-${row.agent}`}>
              <div className="llm-stats-agent-head">
                <AgentLabel agent={row.agent} />
                <span className="llm-stats-count">
                  <b>{number.format(row.count)}</b>
                  <span>{percent.format(total === 0 ? 0 : row.count / total)}</span>
                </span>
              </div>
              {row.tokens === null ? (
                <div className="llm-stats-tokens meta">{tokens === null && !failed ? 'Chargement des tokens…' : 'Tokens indisponibles'}</div>
              ) : (
                <div className="llm-stats-tokens">
                  <b>{number.format(row.tokens.inputTokens + row.tokens.outputTokens)}</b> tokens
                  <span title={`Entrée : ${number.format(row.tokens.inputTokens)} · Sortie : ${number.format(row.tokens.outputTokens)} · Cache lu : ${number.format(row.tokens.cachedInputTokens)} · Cache écrit : ${number.format(row.tokens.cacheWriteInputTokens)}`}>
                    Entrée {compact.format(row.tokens.inputTokens)} · Sortie {compact.format(row.tokens.outputTokens)}
                    {row.tokens.cachedInputTokens > 0 ? ` · dont ${compact.format(row.tokens.cachedInputTokens)} en cache` : ''}
                  </span>
                  {row.measured < row.count || row.partial ? <span>Relevé partiel · {row.measured}/{row.count} sessions · journaux disponibles</span> : null}
                </div>
              )}
              <div className="llm-stats-detail">
                <span>{row.active} en cours</span>
                {row.models.map(({ model, count }) => (
                  <span key={model === null ? 'default' : `model:${model}`} className="llm-stats-model">
                    {model ?? 'Modèle par défaut'} <b>× {number.format(count)}</b>
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </div>
      {total === 0 ? <p className="llm-stats-empty">Aucune session créée sur cette période.</p> : null}
      {failed ? <p className="llm-stats-empty">Les relevés de tokens ne sont pas actualisés.</p> : null}
      <p className="llm-stats-note">
        Sessions conservées, sélectionnées par date de création. Tokens cumulés des sessions principales, cache inclus.
      </p>
    </section>
  );
}
