import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { NewSessionForm } from './NewSessionForm.tsx';
import { useStore } from './store.tsx';
import type { LaunchSpec } from './types.ts';

// Modale native : Échap et un clic hors du contenu la ferment.
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    const onCancel = (event: Event): void => {
      event.preventDefault();
      onCloseRef.current();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="modal"
      onMouseDown={(e) => {
        // Le backdrop et la barre de défilement ont tous deux le <dialog> pour cible :
        // seul un clic hors de son rectangle vient du backdrop.
        const dialog = ref.current;
        if (e.target !== dialog || !dialog) return;
        const r = dialog.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) onClose();
      }}
    >
      <div className="modal-body">
        <h2>{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

export function LaunchSessionDialog({
  title,
  projectId,
  initialPrompt,
  onLaunch,
  onClose,
}: {
  title: string;
  projectId: string;
  initialPrompt: string;
  onLaunch: (spec: LaunchSpec) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <NewSessionForm
        className="bare"
        projectId={projectId}
        initialPrompt={initialPrompt}
        autoFocus
        onLaunch={onLaunch}
        onCancel={onClose}
      />
    </Modal>
  );
}

export function AddTaskDialog({
  projectId,
  initialText,
  sourceSessionId,
  onClose,
}: {
  projectId: string;
  initialText: string;
  sourceSessionId?: string;
  onClose: () => void;
}) {
  const { createTask, projects } = useStore();
  const [text, setText] = useState(initialText);
  // Projet du backlog cible : celui de la session par défaut, mais un constat peut concerner un autre projet.
  const [targetId, setTargetId] = useState(projectId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (): Promise<void> => {
    if (busy || text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await createTask(targetId, text, sourceSessionId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ajout impossible');
      setBusy(false);
    }
  };

  return (
    <Modal title="Ajouter au backlog" onClose={onClose}>
      <form
        className="task-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void add();
        }}
      >
        <textarea
          autoFocus
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === 'Enter' && e.ctrlKey) {
              e.preventDefault();
              void add();
            }
          }}
        />
        {projects.length > 1 ? (
          <label className="task-form-project">
            Backlog du projet
            <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
        <div className="row-actions">
          <button type="submit" className="btn primary" disabled={busy || text.trim() === ''}>
            Ajouter
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <span className="hint">Ctrl+Entrée</span>
        </div>
      </form>
    </Modal>
  );
}
