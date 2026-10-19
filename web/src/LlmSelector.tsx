import type { ReactNode } from 'react';
import { AgentLabel } from './AgentLabel.tsx';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import type { AgentInfo, Effort, LaunchSpec } from './types.ts';

export type LlmSelection = Pick<LaunchSpec, 'agent' | 'model' | 'effort'>;

export function llmChoices(agents: AgentInfo[], value: LlmSelection) {
  const info = agents.find(item => item.agent === value.agent);
  const models = info?.models ?? [];
  const efforts = (value.model === null ? info?.efforts : models.find(model => model.value === value.model)?.efforts) ?? [];
  return { info, models, efforts };
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
  const available = agents.filter(item => item.available);
  const { info, models, efforts } = llmChoices(agents, value);
  const missingModel = value.model !== null && !models.some(model => model.value === value.model);
  const missingEffort = value.effort !== null && !efforts.includes(value.effort);
  return <div className="tuning-row">
    <div className="tuning">
      <span className="field-label">Agent</span>
      {available.length === 0 ? <span className="muted">Aucun agent disponible</span> : <ChoiceGroup
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
        value={value.model ?? ''}
        disabled={disabled}
        options={[
          { value: '', label: 'défaut', title: "Modèle configuré pour l'agent" },
          ...(missingModel ? [{ value: value.model!, label: value.model!, title: 'Modèle hors catalogue', disabled: true }] : []),
          ...models.map(model => ({ value: model.value, label: model.label, title: model.description || undefined })),
        ]}
        onChange={selected => {
          const model = selected || null;
          const supported = (model === null ? info?.efforts : models.find(item => item.value === model)?.efforts) ?? [];
          onChange({ ...value, model, effort: value.effort !== null && supported.includes(value.effort) ? value.effort : null });
        }}
      />
    </div> : null}
    {efforts.length > 0 || missingEffort ? <div className="tuning">
      <span className="field-label">Effort</span>
      <ChoiceGroup<Effort | ''>
        compact
        label="Effort"
        value={value.effort ?? ''}
        disabled={disabled}
        options={[
          { value: '', label: 'défaut', title: "Effort configuré pour l'agent" },
          ...(missingEffort ? [{ value: value.effort!, label: value.effort!, title: 'Effort hors catalogue', disabled: true }] : []),
          ...efforts.map(effort => ({ value: effort, label: effort })),
        ]}
        onChange={effort => onChange({ ...value, effort: effort || null })}
      />
    </div> : null}
    {children}
  </div>;
}
