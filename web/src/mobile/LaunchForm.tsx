import { useEffect, useState, type FormEvent } from 'react';
import { ChoiceGroup } from '../ChoiceGroup.tsx';
import { ExtensionLaunchPicker } from '../ExtensionControls.tsx';
import { errorMessage, MODE_CHIP, MODE_DESCRIPTION, WORKSPACE_TARGET } from '../format.ts';
import { LlmSelector, type LlmSelection } from '../LlmSelector.tsx';
import { go } from '../route.ts';
import { useStore } from '../store.tsx';
import { WorkspaceModeControl } from '../WorkspaceModeControl.tsx';
import { MODE_CHOICES, normalizeMode, type Mode, type Project } from '../../../shared/types.ts';
import { launchSpec } from './launch.ts';

/**
 * Lancement d'une session : agent, modèle, effort, mode, dossier et prompt, comme au bureau. Les choix ne sont
 * enregistrés qu'au lancement (voir launchSpec) ; le dossier de travail est un réglage du projet, enregistré au clic.
 */
export function LaunchForm({ project }: { project: Project }) {
  const { agents, extensions, createSession } = useStore();
  const defaults = project.sessionDefaults;
  const [selection, setSelection] = useState<LlmSelection>({
    agent: defaults.agent,
    model: defaults.model,
    effort: defaults.effort,
  });
  const [mode, setMode] = useState<Mode>(normalizeMode(defaults.mode));
  const [extensionIds, setExtensionIds] = useState<string[]>(project.extensionIds);
  const [extensionsEdited, setExtensionsEdited] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = agents.some((info) => info.available && info.agent === selection.agent);
  // Un autre projet ouvert : ses réglages remplacent ceux du précédent.
  useEffect(() => {
    setSelection({ agent: defaults.agent, model: defaults.model, effort: defaults.effort });
    setMode(normalizeMode(defaults.mode));
    setExtensionsEdited(false);
    setExtensionIds(project.extensionIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seul le changement de projet réinitialise le formulaire.
  }, [project.id]);

  const projectExtensionKey = project.extensionIds.join('\0');
  useEffect(() => {
    if (!extensionsEdited && !busy) setExtensionIds(project.extensionIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- suit le défaut du projet tant que non modifié ici.
  }, [projectExtensionKey, extensionsEdited, busy]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !available) return;
    setBusy(true);
    setError(null);
    try {
      const knownIds = new Set(extensions.map((ext) => ext.id));
      const activeIds = extensionIds.filter((id) => knownIds.has(id));
      const session = await createSession(project.id, launchSpec({ ...selection, mode }, prompt, activeIds));
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
      <form className="m-form m-launch" onSubmit={(event) => void submit(event)}>
        <LlmSelector agents={agents} value={selection} disabled={busy} onChange={setSelection}>
          <div className="tuning">
            <span className="field-label">Mode</span>
            <ChoiceGroup
              compact
              label="Mode"
              value={mode}
              disabled={busy}
              options={MODE_CHOICES.map((m) => ({
                value: m,
                label: MODE_CHIP[m],
                title: MODE_DESCRIPTION[m],
                danger: m === 'bypass',
              }))}
              onChange={setMode}
            />
          </div>
          <div className="tuning">
            <span className="field-label">Dossier</span>
            <WorkspaceModeControl project={project} />
          </div>
          <ExtensionLaunchPicker
            projectExtensionIds={project.extensionIds}
            value={extensionIds}
            disabled={busy}
            onChange={(next) => {
              setExtensionsEdited(true);
              setExtensionIds(next);
            }}
          />
        </LlmSelector>
        <textarea
          className="m-textarea"
          rows={3}
          value={prompt}
          placeholder="Prompt (facultatif)"
          aria-label="Prompt"
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button type="submit" className="m-button primary" disabled={busy || !available}>
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
