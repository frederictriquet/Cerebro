import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { uploadProjectImage } from '../api.ts';
import { useAsyncAction } from '../async-action.ts';
import { AttachmentStrip, restoredAttachment, useAttachedField } from '../attachments.tsx';
import { readDraft, writeDraft } from '../drafts.ts';
import { isSubmitShortcut, SUBMIT_HINT } from '../keys.ts';
import { useStore } from '../store.tsx';
import { CommandTasks } from './CommandTasks.tsx';
import { useBacklog } from './context.ts';
import { EpicForm } from './EpicForm.tsx';
import { EpicSelect } from './EpicSelect.tsx';

// Ajout d'une tâche, confiée à un agent ou à une commande du projet, et création d'un epic.
// Le texte non ajouté et ses images sont conservés dans le navigateur, comme les brouillons de session.
export function TaskComposer() {
  const { createTask, createEpic } = useStore();
  const { projectId, epics, reportError } = useBacklog();
  const draftKey = `backlog.${projectId}`;
  const epicIds = new Set(epics.map((e) => e.id));
  const [stored] = useState(() => readDraft(draftKey));
  const [draft, setDraft] = useState(stored?.prompt ?? '');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftEpic, setDraftEpic] = useState('');
  const [creatingEpic, setCreatingEpic] = useState(false);
  const { run: addTask, busy } = useAsyncAction(
    async () => {
      await createTask(projectId, images.expand(draft), { epicId: epicIds.has(draftEpic) ? draftEpic : null });
      // Effacé ici aussi : le composant peut avoir été démonté pendant la création.
      setDraftError(writeDraft(draftKey, { prompt: '', images: [] }));
      setDraft('');
      images.reset();
    },
    { fallback: 'Ajout impossible', onError: reportError },
  );
  // Collage ou dépôt d'une image : « [Image #N] » au curseur, retiré du texte si l'envoi échoue.
  const { images, fieldProps, stripProps } = useAttachedField({
    upload: (image) => uploadProjectImage(projectId, image),
    initial: stored?.images.map((i) => restoredAttachment(i.n, i.token, i.path)),
    text: draft,
    setText: setDraft,
    onError: (message) => reportError(`Image non envoyée : ${message}`),
    disabled: busy,
  });
  useEffect(() => {
    const uploaded = images.items.flatMap((i) => (i.path === null ? [] : [{ n: i.n, token: i.token, path: i.path }]));
    setDraftError(writeDraft(draftKey, { prompt: draft, images: uploaded }));
  }, [draftKey, draft, images.items]);
  const [composer, setComposer] = useState<'llm' | 'command'>('llm');
  const llmTab = useRef<HTMLButtonElement>(null);
  const commandTab = useRef<HTMLButtonElement>(null);

  const add = async (): Promise<void> => {
    if (busy || images.pending || draft.trim() === '') return;
    await addTask();
  };

  const selectedEpic = epicIds.has(draftEpic) ? draftEpic : '';
  const onComposerKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const order = ['llm', 'command'] as const;
    const index = order.indexOf(composer);
    const next =
      event.key === 'Home'
        ? 'llm'
        : event.key === 'End'
          ? 'command'
          : order[(index + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length];
    setComposer(next);
    (next === 'llm' ? llmTab : commandTab).current?.focus();
  };

  return (
    <>
      <div className="task-composer">
        <div className="task-composer-tabs" role="tablist" aria-label="Création de tâche">
          <button
            ref={llmTab}
            type="button"
            role="tab"
            id={`task-tab-llm-${projectId}`}
            aria-selected={composer === 'llm'}
            aria-controls={`task-panel-llm-${projectId}`}
            tabIndex={composer === 'llm' ? 0 : -1}
            onClick={() => setComposer('llm')}
            onKeyDown={onComposerKey}
          >
            Avec agent
          </button>
          <button
            ref={commandTab}
            type="button"
            role="tab"
            id={`task-tab-command-${projectId}`}
            aria-selected={composer === 'command'}
            aria-controls={`task-panel-command-${projectId}`}
            tabIndex={composer === 'command' ? 0 : -1}
            onClick={() => setComposer('command')}
            onKeyDown={onComposerKey}
          >
            Commande
          </button>
        </div>
        <form
          id={`task-panel-llm-${projectId}`}
          role="tabpanel"
          aria-labelledby={`task-tab-llm-${projectId}`}
          hidden={composer !== 'llm'}
          className="task-add"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void add();
          }}
        >
          <textarea
            id={`task-draft-${projectId}`}
            rows={2}
            value={draft}
            disabled={busy}
            placeholder={`Nouvelle tâche (${SUBMIT_HINT} pour ajouter) · Ctrl+V pour joindre une image`}
            {...fieldProps}
            onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
              if (isSubmitShortcut(e)) {
                e.preventDefault();
                void add();
              }
            }}
          />
          <AttachmentStrip {...stripProps} />
          {draftError ? <p className="form-error">Brouillon non sauvegardé : {draftError}</p> : null}
          <div className="task-add-actions">
            <EpicSelect epics={epics} value={selectedEpic} onChange={setDraftEpic} />
            <button type="submit" className="btn primary" disabled={busy || images.pending || draft.trim() === ''}>
              Ajouter
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setCreatingEpic((v) => !v)}
              aria-expanded={creatingEpic}
            >
              Nouvel epic
            </button>
            {draft.trim() !== '' && draftError === null ? (
              <span className="hint" title="La tâche est conservée dans ce navigateur jusqu'à son ajout">
                Brouillon enregistré
              </span>
            ) : null}
          </div>
        </form>
        <CommandTasks
          key={projectId}
          projectId={projectId}
          hidden={composer !== 'command'}
          panelId={`task-panel-command-${projectId}`}
          labelledBy={`task-tab-command-${projectId}`}
          epicId={selectedEpic}
          epics={epics}
          onEpicChange={setDraftEpic}
          creatingEpic={creatingEpic}
          onCreateEpic={() => setCreatingEpic((v) => !v)}
        />
      </div>
      {creatingEpic ? (
        <EpicForm
          submitLabel="Créer l'epic"
          onCancel={() => setCreatingEpic(false)}
          onSubmit={async (title, description) => {
            const epic = await createEpic(projectId, title, description);
            setDraftEpic(epic.id);
            setCreatingEpic(false);
          }}
        />
      ) : null}
    </>
  );
}
