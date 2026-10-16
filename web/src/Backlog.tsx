import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { DelayedActionButton } from './DelayedActionButton.tsx';
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

// Tâches de `tasks` dont `id` dépend, directement ou non : en dépendre créerait un cycle.
function dependents(id: string, tasks: Task[]): Set<string> {
  const found = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const t of tasks) {
      if (t.dependsOn.includes(current) && !found.has(t.id)) {
        found.add(t.id);
        stack.push(t.id);
      }
    }
  }
  return found;
}

// Une tâche lancée suit l'état de sa session : « En cours » tant que l'agent travaille,
// puis « À valider » une fois son tour fini (la clôture reste manuelle).
function taskPill(task: Task, session: Session | undefined, blocked: boolean): { label: string; className: string } {
  if (task.status === 'todo' && blocked) return { label: 'Bloquée', className: 'blocked' };
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
  const { tasks, sessions, createTask, startTask, deleteTask } = useStore();
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

  const deleteDone = (): void => {
    setError(null);
    void Promise.all(done.map((t) => deleteTask(t.id))).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Suppression impossible'),
    );
  };

  const shown = showDone ? [...open, ...done] : open;

  return (
    <section className="card backlog">
      <div className="session-table-head">
        <h2>Backlog{open.length > 0 ? ` (${open.length})` : ''}</h2>
        {done.length > 0 ? (
          <div className="row-actions">
            {showDone ? (
              <DelayedActionButton onAction={deleteDone}>Supprimer toutes les terminées</DelayedActionButton>
            ) : null}
            <button type="button" className="btn" onClick={() => setShowDone((v) => !v)}>
              {showDone ? 'Masquer les terminées' : `Afficher les terminées (${done.length})`}
            </button>
          </div>
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
              projectTasks={own}
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
          onLaunch={async (spec) => {
            await startTask(starting.id, spec);
            setStarting(null);
          }}
        />
      ) : null}
    </section>
  );
}

function TaskRow({
  task,
  projectTasks,
  session,
  source,
  onStart,
  onError,
}: {
  task: Task;
  projectTasks: Task[];
  session: Session | undefined;
  source: Session | undefined;
  onStart: () => void;
  onError: (message: string) => void;
}) {
  const { updateTask, deleteTask } = useStore();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.text);
  const byId = new Map(projectTasks.map((t) => [t.id, t]));
  const dependencies = task.dependsOn.map((id) => byId.get(id)).filter((t): t is Task => t !== undefined);
  const blockers = dependencies.filter((t) => t.status !== 'done');
  const pill = taskPill(task, session, blockers.length > 0);
  // Relancer pendant que la session tourne en démarrerait une seconde et détacherait la première.
  const sessionActive = task.status === 'started' && session !== undefined && session.status !== 'exited';
  const excluded = dependents(task.id, projectTasks);
  const candidates = projectTasks.filter((t) => t.id !== task.id && !task.dependsOn.includes(t.id) && !excluded.has(t.id));
  const setDependencies = (dependsOn: string[]): void => {
    run(() => updateTask(task.id, { dependsOn }), 'Modification des dépendances impossible');
  };

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
          {blockers.length > 0 && task.status !== 'done' ? (
            <span className="task-blockers">
              Attend : {blockers.map((t) => taskTitle(t.text).slice(0, 60)).join(' · ')}
            </span>
          ) : null}
        </div>
      </div>
      <div className="row-actions">
        {task.status !== 'done' && !sessionActive ? (
          <button
            type="button"
            className="btn primary"
            onClick={onStart}
            disabled={blockers.length > 0}
            title={blockers.length > 0 ? 'Terminez d\'abord les tâches dont celle-ci dépend' : undefined}
          >
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
        <DelayedActionButton onAction={() => run(() => deleteTask(task.id), 'Suppression impossible')}>
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
              <div className="task-deps">
                <span className="meta">Dépend de :</span>
                {dependencies.length === 0 ? <span className="meta">aucune tâche</span> : null}
                {dependencies.map((dep) => (
                  <span key={dep.id} className={`task-dep ${dep.status}`}>
                    {taskTitle(dep.text).slice(0, 60)}
                    <button
                      type="button"
                      className="task-dep-remove"
                      aria-label="Retirer la dépendance"
                      onClick={() => setDependencies(task.dependsOn.filter((id) => id !== dep.id))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {candidates.length > 0 ? (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value !== '') setDependencies([...task.dependsOn, e.target.value]);
                    }}
                  >
                    <option value="">Ajouter une dépendance…</option>
                    {candidates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {taskTitle(t.text).slice(0, 80)}
                        {t.status === 'done' ? ' (terminée)' : ''}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
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
