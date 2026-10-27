import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AgentLabel } from './AgentLabel.tsx';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import { useStore } from './store.tsx';
import type { AgentInfo, Effort, SessionDefaults } from '../../shared/types.ts';

export type LlmSelection = Pick<SessionDefaults, 'agent' | 'model' | 'effort'>;

// Effort used when none is chosen: `high` when offered, otherwise the first level. Mirror of `defaultEffort` (server/catalog.ts).
export function defaultEffort(efforts: Effort[]): Effort | null {
  return efforts.includes('high') ? 'high' : (efforts[0] ?? null);
}

// Model and effort actually shown and launched: null resolves like `parseTuning` on the server.
export function llmChoices(agents: AgentInfo[], value: LlmSelection) {
  const info = agents.find(item => item.agent === value.agent);
  const models = info?.models ?? [];
  const model = value.model ?? info?.defaultModel ?? null;
  const efforts = (model === null ? info?.efforts : models.find(item => item.value === model)?.efforts) ?? [];
  const effort = value.effort ?? defaultEffort(efforts);
  return { info, models, efforts, model, effort };
}

/** Shared layout and model/effort transitions; each form owns its persistence. */
export function LlmSelector({ agents, value, defaults, onChange, disabled = false, children }: {
  agents: AgentInfo[];
  value: LlmSelection;
  defaults?: LlmSelection;
  onChange: (selection: LlmSelection) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const { refreshAgents } = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const available = agents.filter(item => item.available);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await refreshAgents();
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }, [refreshAgents]);
  useEffect(() => {
    if (available.length > 0 || refreshing) return;
    const timer = window.setTimeout(() => void refresh(), 5000);
    return () => window.clearTimeout(timer);
  }, [available.length, refreshing, refresh]);
  // [SPEC UI web › Vue projet] No default choice: the shown model and effort are always explicit.
  const { info, models, efforts, model, effort } = llmChoices(agents, value);
  const missingModel = value.model !== null && !models.some(item => item.value === value.model);
  const missingEffort = value.effort !== null && !efforts.includes(value.effort);
  return <div className="tuning-row">
    <div className="tuning">
      <span className="field-label">Agent</span>
      {available.length === 0 ? <span className="tuning-empty">
        <span className="muted">Aucun agent disponible</span>
        <button type="button" className="btn" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Rafraîchissement…' : 'Rafraîchir'}</button>
        {refreshError ? <span className="form-error">{refreshError}</span> : null}
      </span> : <ChoiceGroup
        compact
        label="Agent"
        value={value.agent}
        disabled={disabled}
        options={[
          ...(!available.some(item => item.agent === value.agent) ? [{ value: value.agent, label: <AgentLabel agent={value.agent} />, title: 'Agent indisponible', disabled: true }] : []),
          ...available.map(item => ({ value: item.agent, label: <AgentLabel agent={item.agent} /> })),
        ]}
        onChange={agent => {
          if (agent === value.agent) return;
          onChange({ agent, model: agent === defaults?.agent ? defaults.model : null, effort: agent === defaults?.agent ? defaults.effort : null });
        }}
      />}
    </div>
    {models.length > 0 || missingModel ? <div className="tuning">
      <span className="field-label">Modèle</span>
      <ChoiceGroup
        compact
        label="Modèle"
        value={model ?? ''}
        disabled={disabled}
        options={[
          ...(missingModel ? [{ value: value.model!, label: value.model!, title: 'Modèle hors catalogue', disabled: true }] : []),
          ...models.map(item => ({ value: item.value, label: item.label, title: item.description || undefined })),
        ]}
        onChange={selected => {
          const supported = models.find(item => item.value === selected)?.efforts ?? [];
          onChange({ ...value, model: selected, effort: effort !== null && supported.includes(effort) ? effort : defaultEffort(supported) });
        }}
      />
    </div> : null}
    {efforts.length > 0 || missingEffort ? <div className="tuning">
      <span className="field-label">Effort</span>
      <ChoiceGroup<Effort | ''>
        compact
        label="Effort"
        value={effort ?? ''}
        disabled={disabled}
        options={[
          ...(missingEffort ? [{ value: value.effort!, label: value.effort!, title: 'Effort hors catalogue', disabled: true }] : []),
          ...efforts.map(item => ({ value: item, label: item })),
        ]}
        onChange={selected => onChange({ ...value, model, effort: selected || null })}
      />
    </div> : null}
    {children}
  </div>;
}
