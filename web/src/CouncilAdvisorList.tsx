import { useId, useState, type KeyboardEvent } from 'react';
import { AgentLogo } from './AgentLabel.tsx';
import { AGENT_LABEL } from './format.ts';
import { LlmSelector } from './LlmSelector.tsx';
import { useStore } from './store.tsx';
import type { Llm, Persona } from '../../shared/types.ts';
import './council.css';

// Personas présentées en onglets, chacune avec l'agent qui la joue : partagées par le lancement
// d'un council et par ses réglages.
export function CouncilAdvisorList({
  personas,
  checkedIds,
  llmOf,
  defaultsOf,
  disabled,
  byDefault = false,
  onToggle,
  onAssign,
}: {
  personas: readonly Persona[];
  checkedIds: readonly string[];
  llmOf: (personaId: string) => Llm;
  defaultsOf: (personaId: string) => Llm | undefined;
  disabled: boolean;
  // Réglages : la case fixe la participation par défaut et l'agent reste réglable même décoché.
  byDefault?: boolean;
  onToggle: (personaId: string, checked: boolean) => void;
  onAssign: (personaId: string, llm: Llm) => void;
}) {
  const { agents } = useStore();
  const base = useId();
  const [activeId, setActiveId] = useState<string | null>(null);
  // Une persona retirée du catalogue rend la main au premier onglet.
  const active = personas.find((persona) => persona.id === activeId) ?? personas[0];
  const tabId = (personaId: string): string => `${base}-tab-${personaId}`;
  const panelId = (personaId: string): string => `${base}-panel-${personaId}`;

  const onKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = personas.indexOf(active);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? personas.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + personas.length) % personas.length;
    setActiveId(personas[next].id);
    document.getElementById(tabId(personas[next].id))?.focus();
  };

  return (
    <div className="council-advisors">
      <div className="council-advisor-tabs" role="tablist" aria-label="Conseillers">
        {personas.map((persona) => {
          const checked = checkedIds.includes(persona.id);
          const selected = persona === active;
          const status = checked
            ? `Joué par ${AGENT_LABEL[llmOf(persona.id).agent]}`
            : byDefault
              ? 'Ne participe pas par défaut'
              : 'Ne participe pas';
          return (
            <button
              key={persona.id}
              type="button"
              role="tab"
              id={tabId(persona.id)}
              className={`council-advisor-tab${checked ? ' checked' : ''}`}
              aria-selected={selected}
              aria-controls={panelId(persona.id)}
              tabIndex={selected ? 0 : -1}
              title={persona.description ? `${persona.description}\n${status}` : status}
              onClick={() => setActiveId(persona.id)}
              onKeyDown={onKey}
            >
              {checked ? (
                <AgentLogo agent={llmOf(persona.id).agent} />
              ) : (
                <span className="council-advisor-dot" aria-hidden="true" />
              )}
              {persona.name}
            </button>
          );
        })}
      </div>
      {personas.map((persona) => {
        const checked = checkedIds.includes(persona.id);
        return (
          <div
            key={persona.id}
            role="tabpanel"
            id={panelId(persona.id)}
            aria-labelledby={tabId(persona.id)}
            hidden={persona !== active}
            className={`council-advisor${checked ? ' checked' : ''}`}
          >
            <div className="council-advisor-head">
              {persona.description ? <p className="persona-description">{persona.description}</p> : null}
              {/* Le libellé porte l'état, comme les boutons Son et Notif de la barre latérale. */}
              <button
                type="button"
                className={`council-advisor-toggle${checked ? ' on' : ''}`}
                disabled={disabled}
                title={
                  checked
                    ? `Retirer ${persona.name} ${byDefault ? 'des participants par défaut' : 'du council'}`
                    : `Ajouter ${persona.name} ${byDefault ? 'aux participants par défaut' : 'au council'}`
                }
                onClick={() => onToggle(persona.id, !checked)}
              >
                {checked ? 'Participe' : 'Ne participe pas'}
              </button>
            </div>
            {/* Au lancement, l'agent d'une persona écartée reste visible mais figé ; dans les réglages
            il reste modifiable, car il s'applique si la persona est cochée au lancement. */}
            <div className={`council-advisor-llm${checked || byDefault ? '' : ' inactive'}`}>
              <LlmSelector
                agents={agents}
                value={llmOf(persona.id)}
                defaults={defaultsOf(persona.id)}
                disabled={disabled || (!checked && !byDefault)}
                onChange={(llm) => onAssign(persona.id, llm)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
