import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ActivityStatus } from './ActivityStatus.tsx';
import { createPersona, deletePersona, listPersonas, updatePersona } from './api.ts';
import { useAsyncAction } from './async-action.ts';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import { Modal } from './Dialog.tsx';
import { errorMessage } from './format.ts';
import {
  MAX_PERSONA_DESCRIPTION_LENGTH,
  MAX_PERSONA_NAME_LENGTH,
  MAX_PERSONA_PROMPT_LENGTH,
  MIN_PERSONAS,
  type Persona,
} from '../../shared/types.ts';
import './council.css';
import type { PersonaInput } from '../../shared/types.ts';

// id null : nouvelle persona.
type Draft = PersonaInput & { id: string | null };

function Counter({ value, max }: { value: string; max: number }) {
  // Le serveur compte les caractères sans les espaces de début et de fin.
  return (
    <span className="persona-counter">
      {value.trim().length} / {max}
    </span>
  );
}

function PersonaForm({
  draft,
  busy,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  busy: boolean;
  error: string | null;
  onChange: (draft: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const invalid = draft.name.trim() === '' || draft.prompt.trim() === '';
  return (
    <form
      className="persona-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!invalid) onSubmit();
      }}
    >
      <label>
        <span className="persona-field-head">
          Nom <Counter value={draft.name} max={MAX_PERSONA_NAME_LENGTH} />
        </span>
        <input
          autoFocus
          required
          maxLength={MAX_PERSONA_NAME_LENGTH}
          value={draft.name}
          disabled={busy}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </label>
      <label>
        <span className="persona-field-head">
          Description brève <Counter value={draft.description} max={MAX_PERSONA_DESCRIPTION_LENGTH} />
        </span>
        <input
          maxLength={MAX_PERSONA_DESCRIPTION_LENGTH}
          value={draft.description}
          disabled={busy}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
        />
      </label>
      <label>
        <span className="persona-field-head">
          Prompt <Counter value={draft.prompt} max={MAX_PERSONA_PROMPT_LENGTH} />
        </span>
        <textarea
          required
          rows={10}
          maxLength={MAX_PERSONA_PROMPT_LENGTH}
          value={draft.prompt}
          disabled={busy}
          placeholder="Angle de réflexion que le conseiller doit adopter"
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
        />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy || invalid}>
          <ActivityStatus active={busy}>
            {busy ? 'Enregistrement…' : draft.id === null ? 'Créer' : 'Enregistrer'}
          </ActivityStatus>
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

// Catalogue des personas du council : création, modification en place et suppression.
export function PersonasDialog({ onClose, onChange }: { onClose: () => void; onChange?: () => void }) {
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const {
    run: saveDraft,
    busy,
    error: formError,
    setError: setFormError,
  } = useAsyncAction(async (current: Draft) => {
    const input: PersonaInput = {
      name: current.name.trim(),
      description: current.description.trim(),
      prompt: current.prompt.trim(),
    };
    const saved = current.id === null ? await createPersona(input) : await updatePersona(current.id, input);
    setPersonas((list) => {
      const items = list ?? [];
      return items.some((p) => p.id === saved.id)
        ? items.map((p) => (p.id === saved.id ? saved : p))
        : [...items, saved];
    });
    setDraft(null);
    onChange?.();
  });
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setPersonas(await listPersonas());
      setLoadError(null);
    } catch (cause) {
      setLoadError(errorMessage(cause));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const edit = (next: Draft | null): void => {
    setDraft(next);
    setFormError(null);
    setDeleteError(null);
  };

  const save = async (): Promise<void> => {
    if (draft === null) return;
    await saveDraft(draft);
  };

  const remove = async (persona: Persona): Promise<void> => {
    setDeleting(persona.id);
    setDeleteError(null);
    try {
      await deletePersona(persona.id);
      setPersonas((current) => (current ?? []).filter((p) => p.id !== persona.id));
      if (draft?.id === persona.id) setDraft(null);
      onChange?.();
    } catch (cause) {
      setDeleteError(`Suppression de « ${persona.name} » refusée : ${errorMessage(cause)}`);
      // Le catalogue a pu changer ailleurs (autre onglet, Slack).
      void load();
    } finally {
      setDeleting(null);
    }
  };

  const form = (current: Draft) => (
    <PersonaForm
      draft={current}
      busy={busy}
      error={formError}
      onChange={setDraft}
      onSubmit={() => void save()}
      onCancel={() => edit(null)}
    />
  );
  const lastOnes = personas !== null && personas.length <= MIN_PERSONAS;

  return (
    <Modal title="Personas du council" onClose={onClose}>
      <div className="personas">
        <p className="hint">
          Chaque conseiller d’un council joue une persona : un angle de réflexion, indépendant de l’agent choisi pour
          l’incarner. Les personas fournies se modifient et se suppriment comme les autres.
        </p>
        {loadError ? (
          <p className="form-error" role="alert">
            Chargement impossible : {loadError}
          </p>
        ) : null}
        {deleteError ? (
          <p className="form-error" role="alert">
            {deleteError}
          </p>
        ) : null}
        {personas === null && loadError === null ? <ActivityStatus>Chargement…</ActivityStatus> : null}
        {personas !== null ? (
          <ul className="persona-list">
            {personas.map((persona) => (
              <li key={persona.id} className="persona-item">
                {draft?.id === persona.id ? (
                  form(draft)
                ) : (
                  <>
                    <div className="persona-summary">
                      <div className="persona-name">
                        <strong>{persona.name}</strong>
                        {persona.builtin ? (
                          <span className="persona-badge" title="Fournie avec Cerebro">
                            fournie
                          </span>
                        ) : null}
                      </div>
                      {persona.description ? <p className="persona-description">{persona.description}</p> : null}
                    </div>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={busy || deleting !== null}
                        onClick={() =>
                          edit({
                            id: persona.id,
                            name: persona.name,
                            description: persona.description,
                            prompt: persona.prompt,
                          })
                        }
                      >
                        Modifier
                      </button>
                      <DelayedActionButton
                        disabled={busy || deleting !== null || lastOnes}
                        title={
                          lastOnes
                            ? `Le catalogue doit garder au moins ${MIN_PERSONAS} personas`
                            : `Supprime « ${persona.name} » du catalogue ; les rapports existants la conservent`
                        }
                        onAction={() => void remove(persona)}
                      >
                        {deleting === persona.id ? <ActivityStatus>Suppression…</ActivityStatus> : 'Supprimer'}
                      </DelayedActionButton>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {draft !== null && draft.id === null ? <div className="persona-item">{form(draft)}</div> : null}
        <div className="row-actions">
          {draft === null || draft.id !== null ? (
            <button
              type="button"
              className="btn primary"
              disabled={busy || personas === null}
              onClick={() => edit({ id: null, name: '', description: '', prompt: '' })}
            >
              Nouvelle persona
            </button>
          ) : null}
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </Modal>
  );
}
