import { ActivityStatus } from './ActivityStatus.tsx';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { NewSessionForm } from './NewSessionForm.tsx';
import { useStore } from './store.tsx';
import type { Agent, SessionDefaults } from '../../shared/types.ts';
import { isSubmitShortcut, SUBMIT_HINT } from './keys.ts';
import { apiParsed, clipboardImage, uploadProjectImage } from './api.ts';
import { AttachmentStrip, insertToken, removeToken, useImageAttachments } from './attachments.tsx';
import { parseOptionalWorkspaceContext, type WorkspaceContext } from '../../shared/git.ts';

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
  promptFor,
  submitLabel,
  epicId,
  onLaunch,
  onClose,
}: {
  title: string;
  projectId: string;
  initialPrompt: string;
  promptFor?: (agent: Agent) => string;
  submitLabel?: string;
  epicId?: string | null;
  onLaunch: (spec: SessionDefaults) => Promise<void>;
  onClose: () => void;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceContext | null>(null);
  useEffect(() => {
    let cancelled = false;
    setWorkspace(null);
    if (epicId) void apiParsed(`/api/epics/${epicId}/workspace`, parseOptionalWorkspaceContext).then(value => { if (!cancelled) setWorkspace(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, [epicId]);
  const contextLabel = workspace ? workspace.mode === 'isolated' ? 'Poursuivre dans le worktree de l’epic' : 'Poursuivre dans le dossier d’origine de l’epic' : undefined;
  return (
    <Modal title={title} onClose={onClose}>
      {workspace ? <p className="hint">Dossier conservé pour cet epic : <code>{workspace.path}</code>. Le réglage des nouvelles conversations ne le modifie pas.</p> : null}
      <NewSessionForm
        className="bare"
        projectId={projectId}
        initialPrompt={initialPrompt}
        promptFor={promptFor}
        submitLabel={submitLabel ?? contextLabel}
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
  const images = useImageAttachments((image) => uploadProjectImage(targetId, image));

  const add = async (): Promise<void> => {
    if (busy || images.pending || text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await createTask(targetId, images.expand(text), sourceSessionId);
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
          disabled={busy}
          placeholder="Description de la tâche · Ctrl+V pour joindre une image"
          onChange={(e) => {
            setText(e.target.value);
            images.prune(e.target.value);
          }}
          onPaste={(e) => {
            const image = clipboardImage(e.clipboardData);
            if (image === null) return;
            e.preventDefault();
            if (busy) return;
            const { selectionStart, selectionEnd } = e.currentTarget;
            const token = images.add(image, (failed, message) => {
              setText((current) => removeToken(current, failed));
              setError(`Image non envoyée : ${message}`);
            });
            setText((current) => insertToken(current, selectionStart, selectionEnd, token));
          }}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (isSubmitShortcut(e)) {
              e.preventDefault();
              void add();
            }
          }}
        />
        <AttachmentStrip
          items={images.items}
          onRemove={(item) => {
            if (busy) return;
            images.remove(item.n);
            setText((current) => removeToken(current, item.token));
          }}
        />
        {projects.length > 1 ? (
          <label className="task-form-project">
            Backlog du projet
            <select value={targetId} disabled={busy || images.pending} onChange={(e) => setTargetId(e.target.value)}>
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
          <button type="submit" className="btn primary" disabled={busy || images.pending || text.trim() === ''}>
            <ActivityStatus active={busy || images.pending}>{busy ? 'Ajout…' : images.pending ? 'Envoi des images…' : 'Ajouter'}</ActivityStatus>
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <span className="hint">{SUBMIT_HINT}</span>
        </div>
      </form>
    </Modal>
  );
}
