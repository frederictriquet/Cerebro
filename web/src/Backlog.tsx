import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { LaunchSessionDialog } from './Dialog.tsx';
import { STATUS_LABEL, sessionTitle } from './format.ts';
import { href } from './route.ts';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import type { Session, Task } from './types.ts';

export function taskTitle(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? text;
}

const TASK_STATUS_LABEL: Record<Task['status'], string> = {
  todo: 'À faire',
  started: 'En cours',
  done: 'Terminée',
};

// Une tâche lancée suit l'état de sa session : « En cours » tant que l'agent travaille,
// puis « À valider » une fois son tour fini (la clôture reste manuelle).
function taskPill(task: Task, session: Session | undefined): { label: string; className: string } {
  if (task.status !== 'started') return { label: TASK_STATUS_LABEL[task.status], className: task.status };
  switch (session?.status) {
    case 'starting':
    case 'running':
      return { label: 'En cours', className: 'started' };
    case 'waiting':
      return { label: 'En attente', className: 'waiting' };
    default:
      return { label: 'À valider', className: 'review' };
  }
}

export function Backlog({ projectId }: { projectId: string }) {
  const { tasks, sessions, createTask, startTask } = useStore();
  const own = tasks.filter((t) => t.projectId === projectId);
  const open = own.filter((t) => t.status !== 'done');
  const done = own.filter((t) => t.status === 'done');
  const [showDone, setShowDone] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (): Promise<void> => {
    if (busy || draft.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await createTask(projectId, draft);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ajout impossible');
    } finally {
      setBusy(false);
    }
  };

  const shown = showDone ? [...open, ...done] : open;

  return (
    <section className="card backlog">
      <div className="session-table-head">
        <h2>Backlog{open.length > 0 ? ` (${open.length})` : ''}</h2>
        {done.length > 0 ? (
          <button type="button" className="btn" onClick={() => setShowDone((v) => !v)}>
            {showDone ? 'Masquer les terminées' : `Afficher les terminées (${done.length})`}
          </button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p className="empty-hint">
          Aucune tâche. Sélectionnez du texte dans un terminal, ou demandez à l'agent de mettre ses findings dans le backlog.
        </p>
      ) : (
        <ul className="task-list">
          {shown.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              session={sessions.find((s) => s.id === task.sessionId)}
              source={sessions.find((s) => s.id === task.sourceSessionId)}
              onStart={() => setStarting(task)}
              onError={setError}
            />
          ))}
        </ul>
      )}
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
          placeholder="Nouvelle tâche (Ctrl+Entrée pour ajouter)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === 'Enter' && e.ctrlKey) {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button type="submit" className="btn" disabled={busy || draft.trim() === ''}>
          Ajouter
        </button>
      </form>
      {error ? <p className="form-error">{error}</p> : null}
      {starting ? (
        <LaunchSessionDialog
          title={`Traiter : ${taskTitle(starting.text).slice(0, 80)}`}
          projectId={projectId}
          initialPrompt={starting.text}
          onClose={() => setStarting(null)}
          onLaunch={async (agent, mode, prompt) => {
            await startTask(starting.id, agent, mode, prompt);
            setStarting(null);
          }}
        />
      ) : null}
    </section>
  );
}

function TaskRow({
  task,
  session,
  source,
  onStart,
  onError,
}: {
  task: Task;
  session: Session | undefined;
  source: Session | undefined;
  onStart: () => void;
  onError: (message: string) => void;
}) {
  const { updateTask, deleteTask } = useStore();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.text);
  const pill = taskPill(task, session);

  const run = (fn: () => Promise<unknown>, fallback: string): void => {
    void fn().catch((err: unknown) => onError(err instanceof Error ? err.message : fallback));
  };

  const save = (): void => {
    if (draft.trim() === '') return;
    run(async () => {
      await updateTask(task.id, { text: draft });
      setEditing(false);
    }, 'Modification impossible');
  };

  return (
    <li className={`task-row ${task.status}`}>
      <div className="task-row-main">
        <button
          type="button"
          className="task-title"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="task-caret">{expanded ? '▾' : '▸'}</span>
          <span>{taskTitle(task.text)}</span>
        </button>
        <div className="task-row-meta">
          <span className={`pill task-status ${pill.className}`}>{pill.label}</span>
          {session ? (
            <a className="task-session" href={href(`#/s/${session.id}`)} title={STATUS_LABEL[session.status]}>
              <StatusDot status={session.status} title={STATUS_LABEL[session.status]} />
              {sessionTitle(session.title)}
            </a>
          ) : null}
        </div>
      </div>
      <div className="row-actions">
        {task.status !== 'done' ? (
          <button type="button" className="btn primary" onClick={onStart}>
            {task.status === 'started' ? 'Relancer' : 'Traiter'}
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          onClick={() => run(() => updateTask(task.id, { status: task.status === 'done' ? 'todo' : 'done' }), 'Modification impossible')}
        >
          {task.status === 'done' ? 'Rouvrir' : 'Marquer terminée'}
        </button>
        <button
          type="button"
          className="btn danger-ghost"
          onClick={() => {
            if (!window.confirm(`Supprimer « ${taskTitle(task.text).slice(0, 80)} » ?`)) return;
            run(() => deleteTask(task.id), 'Suppression impossible');
          }}
        >
          Supprimer
        </button>
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
                {source ? (
                  <a className="meta" href={href(`#/s/${source.id}`)}>
                    Issue de « {sessionTitle(source.title)} »
                  </a>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}
