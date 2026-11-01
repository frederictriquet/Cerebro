import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ActivityStatus } from './ActivityStatus.tsx';
import { getCouncilSettings, getEffectiveCouncilSettings, listPersonas, putCouncilSettings } from './api.ts';
import { useAsyncAction } from './async-action.ts';
import { CouncilAdvisorList } from './CouncilAdvisorList.tsx';
import { Modal } from './Dialog.tsx';
import { LlmSelector } from './LlmSelector.tsx';
import { PersonasDialog } from './PersonasDialog.tsx';
import { useStore } from './store.tsx';
import {
  MAX_ADVISORS,
  MAX_COMPOSITION_NAME_LENGTH,
  MAX_COUNCIL_COMPOSITIONS,
  MIN_ADVISORS,
  type CouncilComposition,
  type CouncilSettings,
  type Llm,
  type Persona,
} from '../../shared/types.ts';
import { errorMessage, plural } from './format.ts';
import './council.css';

// global : réglages de l'accueil ; projectId : surcharge propre au projet.
export type CouncilSettingsScope = 'global' | { projectId: string };

// Sans assignation, le serveur fait jouer la persona par l'agent du chairman.
export function assignmentOf(settings: CouncilSettings, personaId: string): Llm {
  return settings.assignments[personaId] ?? { agent: settings.chairman.agent, model: null, effort: null };
}

// Retire les personas supprimées du catalogue, que le serveur refuserait ou ne compterait pas.
function forCatalog(settings: CouncilSettings, personas: readonly Persona[]): CouncilSettings {
  const known = new Set(personas.map((persona) => persona.id));
  return {
    ...settings,
    assignments: Object.fromEntries(personas.map((persona) => [persona.id, assignmentOf(settings, persona.id)])),
    defaultPersonaIds: settings.defaultPersonaIds.filter((id) => known.has(id)),
    compositions: settings.compositions.map((composition) => ({
      ...composition,
      personaIds: composition.personaIds.filter((id) => known.has(id)),
    })),
  };
}

// Mêmes règles que la validation du serveur ; null : composition valide.
function compositionError(compositions: readonly CouncilComposition[], index: number): string | null {
  const { name, personaIds } = compositions[index]!;
  const key = name.trim().toLocaleLowerCase();
  if (key === '') return 'Nommez la composition.';
  if (compositions.slice(0, index).some((other) => other.name.trim().toLocaleLowerCase() === key))
    return 'Une autre composition porte déjà ce nom.';
  if (personaIds.length < MIN_ADVISORS) return `Choisissez au moins ${MIN_ADVISORS} personas.`;
  if (personaIds.length > MAX_ADVISORS) return `Une composition compte au plus ${MAX_ADVISORS} personas.`;
  return null;
}

// Compositions proposées au lancement : nom et personas de chacune, modifiés en place.
function CouncilCompositions({
  personas,
  compositions,
  errors,
  disabled,
  onChange,
}: {
  personas: readonly Persona[];
  // Réduites au catalogue.
  compositions: readonly CouncilComposition[];
  errors: readonly (string | null)[];
  disabled: boolean;
  onChange: (index: number, composition: CouncilComposition | null) => void;
}) {
  if (compositions.length === 0) return <p className="empty-hint">Aucune composition.</p>;
  return (
    <ul className="council-compositions">
      {compositions.map((composition, index) => {
        const error = errors[index];
        const count = composition.personaIds.length;
        return (
          // Index : le nom change à la frappe.
          <li key={index} className="council-composition-item">
            <div className="council-composition-head">
              <input
                aria-label="Nom de la composition"
                placeholder="Nom, par exemple Juridique"
                // Seule une composition ajoutée arrive sans nom.
                autoFocus={composition.name === ''}
                maxLength={MAX_COMPOSITION_NAME_LENGTH}
                value={composition.name}
                disabled={disabled}
                onChange={(event) => onChange(index, { ...composition, name: event.target.value })}
              />
              <button
                type="button"
                className="btn"
                disabled={disabled}
                title="Retire cette composition des réglages à l’enregistrement"
                onClick={() => onChange(index, null)}
              >
                Supprimer
              </button>
            </div>
            <div
              className="council-composition-personas"
              role="group"
              aria-label={`Personas de la composition ${composition.name.trim() || 'sans nom'}`}
            >
              {personas.map((persona) => {
                const included = composition.personaIds.includes(persona.id);
                return (
                  <button
                    key={persona.id}
                    type="button"
                    className={`council-composition-persona${included ? ' on' : ''}`}
                    aria-pressed={included}
                    disabled={disabled}
                    title={persona.description || undefined}
                    onClick={() =>
                      onChange(index, {
                        ...composition,
                        personaIds: included
                          ? composition.personaIds.filter((id) => id !== persona.id)
                          : [...composition.personaIds, persona.id],
                      })
                    }
                  >
                    {persona.name}
                  </button>
                );
              })}
            </div>
            <p className={error ? 'form-error' : 'hint'} role={error ? 'alert' : undefined}>
              {error ?? `${plural(count, 'persona')} · ${2 * count + 1} appels LLM`}
            </p>
          </li>
        );
      })}
    </ul>
  );
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

  const normalized = settings !== null && personas !== null ? forCatalog(settings, personas) : null;
  const selected = normalized?.defaultPersonaIds.length ?? 0;
  const countError =
    selected < MIN_ADVISORS
      ? `Cochez au moins ${MIN_ADVISORS} participants par défaut.`
      : selected > MAX_ADVISORS
        ? `Un council compte au plus ${MAX_ADVISORS} conseillers.`
        : null;
  const compositionErrors = (normalized?.compositions ?? []).map((_, index, all) => compositionError(all, index));
  const invalid = countError !== null || compositionErrors.some((message) => message !== null);
  const compositionsFull = (settings?.compositions.length ?? 0) >= MAX_COUNCIL_COMPOSITIONS;
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
  // Une nouvelle composition part des participants cochés par défaut.
  const addComposition = (): void => {
    setSettings((current) =>
      current === null
        ? current
        : {
            ...current,
            compositions: [...current.compositions, { name: '', personaIds: [...current.defaultPersonaIds] }],
          },
    );
  };
  // null : supprime la composition.
  const changeComposition = (index: number, composition: CouncilComposition | null): void => {
    setSettings((current) =>
      current === null
        ? current
        : {
            ...current,
            compositions:
              composition === null
                ? current.compositions.filter((_, i) => i !== index)
                : current.compositions.map((item, i) => (i === index ? composition : item)),
          },
    );
  };

  const save = async (): Promise<void> => {
    if (settings === null || personas === null || invalid) return;
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
                <div className="council-settings-head">
                  <h3>Compositions</h3>
                  <button
                    type="button"
                    className="btn"
                    disabled={disabled || compositionsFull}
                    title={
                      compositionsFull
                        ? `${MAX_COUNCIL_COMPOSITIONS} compositions au plus`
                        : 'Part des participants cochés par défaut'
                    }
                    onClick={addComposition}
                  >
                    Nouvelle composition
                  </button>
                </div>
                <p className="hint">
                  Proposées au lancement selon le type de question : en choisir une coche ses personas, que l’on ajuste
                  ensuite. Chacune compte de {MIN_ADVISORS} à {MAX_ADVISORS} personas.
                </p>
                <CouncilCompositions
                  personas={personas}
                  compositions={normalized?.compositions ?? []}
                  errors={compositionErrors}
                  disabled={disabled}
                  onChange={changeComposition}
                />
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
              disabled={disabled || settings === null || personas === null || invalid}
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
