import { useState, type FormEvent } from 'react';
import { ActivityStatus } from './ActivityStatus.tsx';
import { useAsyncAction } from './async-action.ts';
import { PathInput } from './PathInput.tsx';
import { go } from './route.ts';
import { useStore } from './store.tsx';

/** Nom et chemin d'un nouveau projet, puis ouverture de sa page. */
export function NewProjectForm({
  className,
  heading,
  submitLabel,
  autoFocus = false,
  onCreated,
  onCancel,
  onError,
}: {
  className: string;
  heading?: string;
  submitLabel: string;
  autoFocus?: boolean;
  onCreated?: () => void;
  onCancel?: () => void;
  // Sans ce rappel, l'erreur s'affiche dans le formulaire.
  onError?: (message: string | null) => void;
}) {
  const { createProject } = useStore();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const { run: create, busy, error: ownError } = useAsyncAction(async () => {
    const project = await createProject(name.trim(), path.trim());
    setName('');
    setPath('');
    onCreated?.();
    go(`#/p/${project.id}`);
  }, { fallback: 'Création impossible', onError });

  const onCreate = (e: FormEvent): void => {
    e.preventDefault();
    void create();
  };

  const submit = (
    <button type="submit" className="btn primary" disabled={busy}>
      <ActivityStatus active={busy}>{busy ? 'Création…' : submitLabel}</ActivityStatus>
    </button>
  );
  return (
    <form className={className} onSubmit={onCreate}>
      {heading ? <h2>{heading}</h2> : null}
      <label>
        Nom
        <input
          required
          autoFocus={autoFocus}
          autoComplete="off"
          placeholder="Nom"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="block">
        Chemin
        <PathInput required value={path} onChange={setPath} />
      </label>
      {ownError ? <p className="form-error">{ownError}</p> : null}
      {onCancel ? (
        <div className="row-actions">
          {submit}
          <button type="button" className="btn" onClick={onCancel}>
            Annuler
          </button>
        </div>
      ) : (
        submit
      )}
    </form>
  );
}
