import { ActivityStatus } from './ActivityStatus.tsx';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { NewSessionForm } from './NewSessionForm.tsx';
import { useStore } from './store.tsx';
import type { Agent, LaunchSpec } from './types.ts';
import { isSubmitShortcut, SUBMIT_HINT } from './keys.ts';
import { api, uploadProjectImage } from './api.ts';
import type { WorkspaceContext } from '../../server/provenance.ts';
import { useAsyncAction } from './async-action.ts';
import { AttachmentStrip, useAttachedField } from './attachments.tsx';
import { errorMessage } from './format.ts';

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

/** Charge le périmètre affiché avant un lancement ; `load` doit rester stable entre les rendus. */
export function usePrepared<T>(load: (() => Promise<T>) | null): { value: T | null; error: string | null } {
  const [state, setState] = useState<{ value: T | null; error: string | null }>({ value: null, error: null });
  useEffect(() => {
    let cancelled = false;
    setState({ value: null, error: null });
    if (load) {
      void load().then(
        (value) => { if (!cancelled) setState({ value, error: null }); },
        (cause: unknown) => { if (!cancelled) setState({ value: null, error: errorMessage(cause) }); },
      );
    }
    return () => { cancelled = true; };
  }, [load]);
  return state;
}

type LaunchFormProps = Pick<Parameters<typeof NewSessionForm>[0], 'initialPrompt' | 'promptFor' | 'submitLabel' | 'launchDisabled' | 'autoFocus' | 'onLaunch'>;

/** Modale de lancement : périmètre éventuel (`children`), puis le formulaire de session une fois le périmètre prêt. */
export function LaunchDialog({
  title,
  projectId,
  ready = true,
  error = null,
  children,
  onClose,
  ...form
}: LaunchFormProps & {
  title: string;
  projectId: string;
  ready?: boolean;
  error?: string | null;
  children?: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      {!ready && !error ? <p><ActivityStatus>Préparation du périmètre de review…</ActivityStatus></p> : null}
      {ready ? (
        <>
          {children}
          <NewSessionForm className="bare" projectId={projectId} {...form} onCancel={onClose} />
        </>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </Modal>
  );
}

export function LaunchSessionDialog({
  submitLabel,
  epicId,
  ...props
}: {
  title: string;
  projectId: string;
  initialPrompt: string;
  promptFor?: (agent: Agent) => string;
  submitLabel?: string;
  epicId?: string | null;
  onLaunch: (spec: LaunchSpec) => Promise<void>;
  onClose: () => void;
}) {
  const load = useCallback(() => api<WorkspaceContext | null>(`/api/epics/${epicId}/workspace`), [epicId]);
  // Le dossier de l'epic est facultatif : le formulaire ne l'attend pas, et un échec de chargement reste silencieux.
  const { value: workspace } = usePrepared(epicId ? load : null);
  const contextLabel = workspace ? workspace.mode === 'isolated' ? 'Poursuivre dans le worktree de l’epic' : 'Poursuivre dans le dossier d’origine de l’epic' : undefined;
  return (
    <LaunchDialog {...props} submitLabel={submitLabel ?? contextLabel} autoFocus>
      {workspace ? <p className="hint">Dossier conservé pour cet epic : <code>{workspace.path}</code>. Le réglage des nouvelles conversations ne le modifie pas.</p> : null}
    </LaunchDialog>
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
  const { run: createTargetTask, busy, error, setError } = useAsyncAction(async () => {
    await createTask(targetId, images.expand(text), sourceSessionId);
    onClose();
  }, { fallback: 'Ajout impossible' });
  const { images, fieldProps, stripProps } = useAttachedField({
    upload: (image) => uploadProjectImage(targetId, image),
    text,
    setText,
    onError: (message) => setError(`Image non envoyée : ${message}`),
    disabled: busy,
  });

  const add = async (): Promise<void> => {
    if (busy || images.pending || text.trim() === '') return;
    await createTargetTask();
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
          {...fieldProps}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (isSubmitShortcut(e)) {
              e.preventDefault();
              void add();
            }
          }}
        />
        <AttachmentStrip {...stripProps} />
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
