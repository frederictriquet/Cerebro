import { useCallback, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { GlobalBacklog as GlobalBacklogData, GlobalEpic, GlobalTask } from '../../../shared/backlog.ts';
import {
  createGlobalEpic,
  createGlobalTask,
  deleteGlobalEpic,
  deleteGlobalTask,
  dispatchGlobalItem,
  getGlobalBacklog,
  updateGlobalEpic,
  updateGlobalTask,
} from '../api.ts';
import { DelayedActionButton } from '../DelayedActionButton.tsx';
import { errorMessage } from '../format.ts';
import { isSubmitShortcut, SUBMIT_HINT } from '../keys.ts';
import { usePolling } from '../polling.tsx';
import { readStored, writeStored } from '../storage.ts';
import { useStore } from '../store.tsx';
import { EpicForm } from './EpicForm.tsx';
import { taskTitle } from './tasks.ts';

const TARGET_KEY = 'cerebro.global-backlog-target';
const REFRESH_MS = 15_000;

type Act = (fn: () => Promise<unknown>, fallback: string) => void;

function EpicChoice({
  epics,
  value,
  onChange,
}: {
  epics: GlobalEpic[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (epics.length === 0) return null;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Epic de la tâche">
      <option value="">Sans epic</option>
      {epics.map((epic) => (
        <option key={epic.id} value={epic.id}>
          {epic.title.slice(0, 60)}
        </option>
      ))}
    </select>
  );
}

function GlobalTaskRow({
  task,
  epics,
  target,
  act,
}: {
  task: GlobalTask;
  epics: GlobalEpic[];
  target: string;
  act: Act;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.text);
  const save = (): void => {
    if (draft.trim() === '') return;
    act(async () => {
      await updateGlobalTask(task.id, { text: draft });
      setEditing(false);
    }, 'Modification impossible');
  };
  return (
    <li className="task-row todo">
      <div className="task-row-main">
        <button type="button" className="task-title" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          <span className="task-caret">{expanded ? '▾' : '▸'}</span>
          <span>{taskTitle(task.text)}</span>
        </button>
      </div>
      <div className="row-actions">
        <button
          type="button"
          className="btn primary"
          disabled={target === ''}
          title={target === '' ? 'Choisissez un projet cible' : undefined}
          onClick={() => act(() => dispatchGlobalItem('tasks', task.id, target), 'Dispatch impossible')}
        >
          Dispatcher
        </button>
        <DelayedActionButton onAction={() => act(() => deleteGlobalTask(task.id), 'Suppression impossible')}>
          Supprimer
        </DelayedActionButton>
      </div>
      {expanded ? (
        <div className="task-detail">
          {editing ? (
            <>
              <textarea rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
              <div className="row-actions">
                <button type="button" className="btn primary" disabled={draft.trim() === ''} onClick={save}>
                  Enregistrer
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setDraft(task.text);
                    setEditing(false);
                  }}
                >
                  Annuler
                </button>
              </div>
            </>
          ) : (
            <>
              <pre className="task-text">{task.text}</pre>
              {epics.length > 0 ? (
                <div className="task-deps">
                  <span className="meta">Epic :</span>
                  <EpicChoice
                    epics={epics}
                    value={task.epicId ?? ''}
                    onChange={(id) =>
                      act(
                        () => updateGlobalTask(task.id, { epicId: id === '' ? null : id }),
                        "Changement d'epic impossible",
                      )
                    }
                  />
                </div>
              ) : null}
              <div className="row-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setDraft(task.text);
                    setEditing(true);
                  }}
                >
                  Éditer
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

function GlobalEpicBlock({
  epic,
  tasks,
  epics,
  target,
  act,
}: {
  epic: GlobalEpic;
  tasks: GlobalTask[];
  epics: GlobalEpic[];
  target: string;
  act: Act;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="epic">
      <div className="epic-head">
        <div className="epic-title">
          <span className="epic-badge">Epic</span>
          <span>{epic.title}</span>
        </div>
        <div className="task-row-meta">
          <span className="pill task-status">{tasks.length} tâche(s)</span>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn primary"
            disabled={target === ''}
            title={target === '' ? 'Choisissez un projet cible' : "Déplace l'epic et ses tâches dans le projet"}
            onClick={() => act(() => dispatchGlobalItem('epics', epic.id, target), 'Dispatch impossible')}
          >
            Dispatcher l'epic
          </button>
          <button type="button" className="btn" onClick={() => setEditing((v) => !v)}>
            Éditer
          </button>
          <DelayedActionButton onAction={() => act(() => deleteGlobalEpic(epic.id), 'Suppression impossible')}>
            Supprimer l'epic
          </DelayedActionButton>
        </div>
      </div>
      {editing ? (
        <EpicForm
          initialTitle={epic.title}
          initialDescription={epic.description}
          submitLabel="Enregistrer"
          onCancel={() => setEditing(false)}
          onSubmit={async (title, description) => {
            await updateGlobalEpic(epic.id, { title, description });
            setEditing(false);
          }}
        />
      ) : epic.description !== '' ? (
        <p className="epic-description">{epic.description}</p>
      ) : null}
      {tasks.length === 0 ? (
        <p className="empty-hint">
          Epic vide : rangez-y des tâches (menu « Epic » d'une tâche, ou sélecteur du champ d'ajout).
        </p>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => (
            <GlobalTaskRow key={task.id} task={task} epics={epics} target={target} act={act} />
          ))}
        </ul>
      )}
    </div>
  );
}

// Backlog sans projet : on y note des idées, puis on les dispatche dans le projet de son choix, où elles
// deviennent tâches (ou epic avec ses tâches) du backlog de ce projet.
export function GlobalBacklog() {
  const { projects } = useStore();
  const [data, setData] = useState<GlobalBacklogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storedTarget, setStoredTarget] = useState(() => readStored(TARGET_KEY) ?? '');
  const [draft, setDraft] = useState('');
  const [draftEpic, setDraftEpic] = useState('');
  const [creatingEpic, setCreatingEpic] = useState(false);
  const [adding, setAdding] = useState(false);

  const fetchBacklog = useCallback(() => getGlobalBacklog(), []);
  const reload = usePolling(fetchBacklog, REFRESH_MS, {
    onData: (value) => {
      setData(value);
      setError(null);
    },
    onError: (err) => setError(errorMessage(err, 'Chargement impossible')),
  });

  const act: Act = (fn, fallback) => {
    setError(null);
    void fn()
      .then(reload)
      .catch((err: unknown) => setError(errorMessage(err, fallback)));
  };

  const target = projects.some((p) => p.id === storedTarget) ? storedTarget : '';
  const epics = data?.epics ?? [];
  const tasks = data?.tasks ?? [];
  const epicIds = new Set(epics.map((e) => e.id));
  const loose = tasks.filter((t) => t.epicId === null || !epicIds.has(t.epicId));
  const selectedEpic = epicIds.has(draftEpic) ? draftEpic : '';

  const add = async (): Promise<void> => {
    if (adding || draft.trim() === '') return;
    setAdding(true);
    setError(null);
    try {
      await createGlobalTask(draft, selectedEpic === '' ? null : selectedEpic);
      setDraft('');
      await reload();
    } catch (err) {
      setError(errorMessage(err, 'Ajout impossible'));
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className="card project-panel backlog" aria-label="Backlog global">
      <div className="project-panel-head">
        <h2>
          Backlog global{' '}
          <span className="pill project-panel-count" title="Tâches en attente de dispatch">
            {tasks.length}
          </span>
        </h2>
        <label className="row-actions">
          <span className="meta">Projet cible</span>
          <select
            value={target}
            onChange={(e) => {
              setStoredTarget(e.target.value);
              writeStored(TARGET_KEY, e.target.value);
            }}
          >
            <option value="">Choisir un projet…</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <form
        className="task-add"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void add();
        }}
      >
        <textarea
          rows={2}
          value={draft}
          disabled={adding}
          placeholder={`Nouvelle tâche (${SUBMIT_HINT} pour ajouter)`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (isSubmitShortcut(e)) {
              e.preventDefault();
              void add();
            }
          }}
        />
        <div className="task-add-actions">
          <EpicChoice epics={epics} value={selectedEpic} onChange={setDraftEpic} />
          <button type="submit" className="btn primary" disabled={adding || draft.trim() === ''}>
            Ajouter
          </button>
          <button type="button" className="btn" onClick={() => setCreatingEpic((v) => !v)} aria-expanded={creatingEpic}>
            Nouvel epic
          </button>
        </div>
      </form>
      {creatingEpic ? (
        <EpicForm
          submitLabel="Créer l'epic"
          onCancel={() => setCreatingEpic(false)}
          onSubmit={async (title, description) => {
            await createGlobalEpic(title, description);
            setCreatingEpic(false);
            await reload();
          }}
        />
      ) : null}
      {epics.map((epic) => (
        <GlobalEpicBlock
          key={epic.id}
          epic={epic}
          tasks={tasks.filter((t) => t.epicId === epic.id)}
          epics={epics}
          target={target}
          act={act}
        />
      ))}
      {epics.length > 0 && loose.length > 0 ? <h3 className="backlog-loose">Sans epic</h3> : null}
      {data !== null && tasks.length === 0 && epics.length === 0 ? (
        <p className="empty-hint">
          Aucune idée en attente. Notez-les ici, puis dispatchez-les dans le projet qui doit les traiter.
        </p>
      ) : loose.length > 0 ? (
        <ul className="task-list">
          {loose.map((task) => (
            <GlobalTaskRow key={task.id} task={task} epics={epics} target={target} act={act} />
          ))}
        </ul>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </section>
  );
}
