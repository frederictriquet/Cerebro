import { useState, type FormEvent } from 'react';

export function EpicForm({
  initialTitle = '',
  initialDescription = '',
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialTitle?: string;
  initialDescription?: string;
  submitLabel: string;
  onSubmit: (title: string, description: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (busy || title.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(title, description);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enregistrement impossible');
      setBusy(false);
    }
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
