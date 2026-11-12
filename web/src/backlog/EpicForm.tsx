import { useState, type FormEvent } from 'react';
import { useAsyncAction } from '../async-action.ts';

export function EpicForm({
  initialTitle = '',
  initialDescription = '',
  initialDueDate = null,
  withDueDate = false,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialTitle?: string;
  initialDescription?: string;
  initialDueDate?: string | null;
  // Propose une échéance : le backlog global n'en a pas.
  withDueDate?: boolean;
  submitLabel: string;
  onSubmit: (title: string, description: string, dueDate: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [dueDate, setDueDate] = useState(initialDueDate ?? '');
  const {
    run: save,
    busy,
    error,
  } = useAsyncAction(() => onSubmit(title, description, dueDate === '' ? null : dueDate), {
    fallback: 'Enregistrement impossible',
  });

  const submit = async (): Promise<void> => {
    if (busy || title.trim() === '') return;
    await save();
  };

  return (
    <form
      className="epic-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        value={title}
        placeholder="Titre de l'epic"
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        rows={3}
        value={description}
        placeholder="Contexte commun aux tâches (facultatif, transmis à la session qui traite l'epic)"
        onChange={(e) => setDescription(e.target.value)}
      />
      {withDueDate ? (
        <label className="epic-form-due">
          <span className="meta">Échéance (facultative)</span>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy || title.trim() === ''}>
          {submitLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}
