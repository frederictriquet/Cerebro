import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { clipboardImage, uploadProjectImage } from '../api.ts';
import { AttachmentStrip, insertToken, removeToken, useImageAttachments } from '../attachments.tsx';
import { isSubmitShortcut, SUBMIT_HINT } from '../keys.ts';
import { useStore } from '../store.tsx';
import { CommandTasks } from './CommandTasks.tsx';
import { useBacklog } from './context.ts';
import { EpicForm } from './EpicForm.tsx';
import { EpicSelect } from './EpicSelect.tsx';
import { errorMessage } from './tasks.ts';

// Ajout d'une tâche, confiée à un agent ou à une commande du projet, et création d'un epic.
export function TaskComposer() {
  const { createTask, createEpic } = useStore();
  const { projectId, epics, reportError } = useBacklog();
  const epicIds = new Set(epics.map((e) => e.id));
  const [draft, setDraft] = useState('');
  const [draftEpic, setDraftEpic] = useState('');
  const [creatingEpic, setCreatingEpic] = useState(false);
  const [busy, setBusy] = useState(false);
  const images = useImageAttachments((image) => uploadProjectImage(projectId, image));
  const [composer, setComposer] = useState<'llm' | 'command'>('llm');
  const llmTab = useRef<HTMLButtonElement>(null);
  const commandTab = useRef<HTMLButtonElement>(null);

  const add = async (): Promise<void> => {
    if (busy || images.pending || draft.trim() === '') return;
    setBusy(true);
    reportError(null);
    try {
      await createTask(projectId, images.expand(draft), { epicId: epicIds.has(draftEpic) ? draftEpic : null });
      setDraft('');
      images.reset();
    } catch (err) {
      reportError(errorMessage(err, 'Ajout impossible'));
    } finally {
      setBusy(false);
    }
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
            onChange={(e) => {
              setDraft(e.target.value);
              images.prune(e.target.value);
            }}
            onPaste={(e) => {
              const image = clipboardImage(e.clipboardData);
              if (image === null) return;
              e.preventDefault();
              if (busy) return;
              const { selectionStart, selectionEnd } = e.currentTarget;
              const token = images.add(image, (failed, message) => {
                setDraft((current) => removeToken(current, failed));
                reportError(`Image non envoyée : ${message}`);
              });
              setDraft((current) => insertToken(current, selectionStart, selectionEnd, token));
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
              setDraft((current) => removeToken(current, item.token));
            }}
          />
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
