import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ActivityStatus } from './ActivityStatus.tsx';
import { getCouncilSettings, getEffectiveCouncilSettings, listPersonas, putCouncilSettings } from './api.ts';
import { useAsyncAction } from './async-action.ts';
import { CouncilAdvisorList } from './CouncilAdvisorList.tsx';
import { Modal } from './Dialog.tsx';
import { LlmSelector } from './LlmSelector.tsx';
import { PersonasDialog } from './PersonasDialog.tsx';
import { useStore } from './store.tsx';
import { MAX_ADVISORS, MIN_ADVISORS, type CouncilSettings, type Llm, type Persona } from '../../shared/types.ts';
import { errorMessage, plural } from './format.ts';
import './council.css';

// global : réglages de l'accueil ; projectId : surcharge propre au projet.
export type CouncilSettingsScope = 'global' | { projectId: string };

// Sans assignation, le serveur fait jouer la persona par l'agent du chairman.
export function assignmentOf(settings: CouncilSettings, personaId: string): Llm {
  return settings.assignments[personaId] ?? { agent: settings.chairman.agent, model: null, effort: null };
}

// Retire les personas supprimées du catalogue, que le serveur refuserait.
function forCatalog(settings: CouncilSettings, personas: readonly Persona[]): CouncilSettings {
  const known = new Set(personas.map((persona) => persona.id));
  return {
    ...settings,
    assignments: Object.fromEntries(personas.map((persona) => [persona.id, assignmentOf(settings, persona.id)])),
    defaultPersonaIds: settings.defaultPersonaIds.filter((id) => known.has(id)),
  };
}

export function CouncilSettingsDialog({
  scope,
  onClose,
  onChange,
}: {
  scope: CouncilSettingsScope;
  onClose: () => void;
  // Signale une sauvegarde effective, y compris le retour immédiat aux réglages globaux,
  // ou une modification du catalogue de personas, qui peut réparer les réglages côté serveur.
  onChange?: () => void;
}) {
  const { agents, projects, updateProject } = useStore();
  const projectId = scope === 'global' ? null : scope.projectId;
  const project = projectId === null ? null : (projects.find((item) => item.id === projectId) ?? null);
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [settings, setSettings] = useState<CouncilSettings | null>(null);
  // Dernière version enregistrée : sert de défaut à chaque LlmSelector.
  const [saved, setSaved] = useState<CouncilSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saving = useAsyncAction(
    async (next: CouncilSettings) => {
      if (projectId === null) await putCouncilSettings(next);
      else await updateProject(projectId, { councilSettings: next });
      onChange?.();
      onClose();
    },
    { onError: setError },
  );
  const resetting = useAsyncAction(
    async (id: string) => {
      await updateProject(id, { councilSettings: null });
      onChange?.();
      await loadSettings();
    },
    { onError: setError },
  );
  const busy = saving.busy ? 'save' : resetting.busy ? 'reset' : null;
  const [personasOpen, setPersonasOpen] = useState(false);

  const loadSettings = useCallback(async (): Promise<void> => {
    const loaded = projectId === null ? await getCouncilSettings() : await getEffectiveCouncilSettings(projectId);
    setSettings(loaded);
    setSaved(loaded);
  }, [projectId]);
  const loadPersonas = useCallback(async (): Promise<void> => {
    try {
      setPersonas(await listPersonas());
      setLoadError(null);
    } catch (cause) {
      setLoadError(errorMessage(cause));
    }
  }, []);
  useEffect(() => {
    void Promise.all([loadPersonas(), loadSettings()]).catch((cause) => setLoadError(errorMessage(cause)));
  }, [loadPersonas, loadSettings]);

  const selected = settings !== null && personas !== null ? forCatalog(settings, personas).defaultPersonaIds.length : 0;
  const countError =
    selected < MIN_ADVISORS
      ? `Cochez au moins ${MIN_ADVISORS} participants par défaut.`
      : selected > MAX_ADVISORS
        ? `Un council compte au plus ${MAX_ADVISORS} conseillers.`
        : null;
  const inherits = project !== null && project.councilSettings === null;
  const disabled = busy !== null;

  const toggle = (personaId: string, checked: boolean): void => {
    setSettings((current) =>
      current === null
        ? current
        : {
            ...current,
            defaultPersonaIds: checked
              ? [...current.defaultPersonaIds.filter((id) => id !== personaId), personaId]
              : current.defaultPersonaIds.filter((id) => id !== personaId),
          },
    );
  };
  const assign = (personaId: string, llm: Llm): void => {
    setSettings((current) =>
      current === null ? current : { ...current, assignments: { ...current.assignments, [personaId]: llm } },
    );
  };

  const save = async (): Promise<void> => {
    if (settings === null || personas === null || countError !== null) return;
    await saving.run(forCatalog(settings, personas));
  };

  const reset = async (): Promise<void> => {
    if (projectId === null) return;
    await resetting.run(projectId);
  };

  return (
    <>
      <Modal
        title={project === null ? 'Réglages du council' : `Réglages du council · ${project.name}`}
        onClose={onClose}
      >
        <form
          className="council-settings"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void save();
          }}
        >
          {projectId === null ? (
            <p className="hint">
              Réglages par défaut des councils lancés depuis l’accueil, Slack et les projets sans réglages propres.
            </p>
          ) : (
            <p className={`council-scope${inherits ? '' : ' own'}`} role="status">
              {inherits
                ? 'Ce projet suit les réglages globaux du council. Enregistrer crée des réglages propres à ce projet.'
                : 'Ce projet a ses propres réglages du council ; les réglages globaux ne s’y appliquent pas.'}
            </p>
          )}
          {loadError ? (
            <p className="form-error" role="alert">
              Chargement impossible : {loadError}
            </p>
          ) : null}
          {(settings === null || personas === null) && loadError === null ? (
            <ActivityStatus>Chargement…</ActivityStatus>
          ) : null}
          {settings !== null && personas !== null ? (
            <>
              <section className="council-settings-section">
                <div className="council-settings-head">
                  <h3>Conseillers</h3>
                  <button type="button" className="btn" disabled={disabled} onClick={() => setPersonasOpen(true)}>
                    Gérer les personas
                  </button>
                </div>
                <p className="hint">
                  Les personas cochées participent par défaut ; chacune est jouée par l’agent choisi ici, modifiable au
                  lancement.
                </p>
                <CouncilAdvisorList
                  personas={personas}
                  checkedIds={settings.defaultPersonaIds}
                  llmOf={(id) => assignmentOf(settings, id)}
                  defaultsOf={(id) => (saved === null ? undefined : assignmentOf(saved, id))}
                  disabled={disabled}
                  byDefault
                  onToggle={toggle}
                  onAssign={assign}
                />
                <p className={countError ? 'form-error' : 'hint'} role={countError ? 'alert' : undefined}>
                  {countError ?? `${plural(selected, 'participant')} par défaut.`}
                </p>
              </section>
              <section className="council-settings-section">
                <h3>Chairman</h3>
                <p className="hint">Rédige la synthèse à partir des avis et des relectures croisées.</p>
                <LlmSelector
                  agents={agents}
                  value={settings.chairman}
                  defaults={saved?.chairman}
                  disabled={disabled}
                  onChange={(chairman) => setSettings({ ...settings, chairman })}
                />
              </section>
              <label className="council-read-project">
                <input
                  type="checkbox"
                  checked={settings.readProject}
                  disabled={disabled}
                  onChange={(event) => setSettings({ ...settings, readProject: event.target.checked })}
                />
                <span>
                  Lire le projet par défaut
                  <span className="hint">
                    {' '}
                    : les conseillers d’un council lancé depuis un projet peuvent consulter son dépôt en lecture seule.
                  </span>
                </span>
              </label>
            </>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="row-actions">
            <button
              type="submit"
              className="btn primary"
              disabled={disabled || settings === null || personas === null || countError !== null}
            >
              <ActivityStatus active={busy === 'save'}>
                {busy === 'save' ? 'Enregistrement…' : 'Enregistrer'}
              </ActivityStatus>
            </button>
            {projectId !== null && !inherits ? (
              <button
                type="button"
                className="btn"
                disabled={disabled}
                title="Supprime les réglages propres à ce projet"
                onClick={() => void reset()}
              >
                <ActivityStatus active={busy === 'reset'}>
                  {busy === 'reset' ? 'Retour aux réglages globaux…' : 'Revenir aux réglages globaux'}
                </ActivityStatus>
              </button>
            ) : null}
            <button type="button" className="btn" disabled={disabled} onClick={onClose}>
              Annuler
            </button>
          </div>
        </form>
      </Modal>
      {/* Hors du formulaire : PersonasDialog contient ses propres formulaires. */}
      {personasOpen ? (
        <PersonasDialog
          onChange={() => {
            void loadPersonas();
            onChange?.();
          }}
          onClose={() => {
            setPersonasOpen(false);
            void loadPersonas();
          }}
        />
      ) : null}
    </>
  );
}
