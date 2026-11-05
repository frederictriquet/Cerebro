import { useEffect, useState, type FormEvent } from 'react';
import { AgentLabel } from '../AgentLabel.tsx';
import { ChoiceGroup } from '../ChoiceGroup.tsx';
import { errorMessage, MODE_CHIP, WORKSPACE_TARGET } from '../format.ts';
import { go } from '../route.ts';
import { useStore } from '../store.tsx';
import { normalizeMode, type Agent, type Project } from '../../../shared/types.ts';
import { launchSpec } from './launch.ts';

/**
 * Lancement d'une session : prompt et agent. Ne reprend pas NewSessionForm, qui enregistre les réglages par défaut
 * du projet à chaque changement de champ : ici, seul le lancement les touche (voir launchSpec).
 */
export function LaunchForm({ project }: { project: Project }) {
  const { agents, createSession, watchAgents } = useStore();
  // Relance la découverte tant qu'aucun agent n'est disponible, comme le sélecteur desktop.
  useEffect(() => watchAgents(), [watchAgents]);
  const available = agents.filter((info) => info.available).map((info) => info.agent);
  const projectAgent = project.sessionDefaults.agent;
  // null : l'agent du projet, ou le premier disponible si celui-ci ne l'est pas.
  const [chosen, setChosen] = useState<Agent | null>(null);
  const agent: Agent | undefined =
    chosen !== null && available.includes(chosen)
      ? chosen
      : available.includes(projectAgent)
        ? projectAgent
        : available[0];
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || agent === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const session = await createSession(project.id, launchSpec(projectAgent, agent, prompt));
      go(`#/s/${session.id}`);
    } catch (err) {
      setError(errorMessage(err, 'Lancement impossible'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="m-section" aria-labelledby="m-launch-title">
      <h2 className="m-section-title" id="m-launch-title">
        Nouvelle session
      </h2>
      <form className="m-form" onSubmit={(event) => void submit(event)}>
        <textarea
          className="m-textarea"
          rows={4}
          value={prompt}
          placeholder="Prompt (facultatif)"
          aria-label="Prompt"
          onChange={(event) => setPrompt(event.target.value)}
        />
        {agent === undefined ? (
          <p className="m-hint">Aucun agent disponible sur cette machine.</p>
        ) : (
          <ChoiceGroup
            label="Agent"
            value={agent}
            options={available.map((value) => ({ value, label: <AgentLabel agent={value} /> }))}
            onChange={setChosen}
            disabled={busy}
          />
        )}
        <p className="m-hint">
          Mode {MODE_CHIP[normalizeMode(project.sessionDefaults.mode)]}
          {agent !== undefined && agent !== projectAgent ? ', modèle et effort par défaut de l’agent' : ''}.
        </p>
        <button type="submit" className="m-button primary" disabled={busy || agent === undefined}>
          {busy ? 'Lancement…' : `Lancer ${WORKSPACE_TARGET[project.workspaceMode]}`}
        </button>
        {error === null ? null : (
          <p className="m-form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
