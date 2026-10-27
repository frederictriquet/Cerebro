import { useState } from 'react';
import { DelayedActionButton } from '../DelayedActionButton.tsx';
import { STATUS_LABEL, sessionTitle } from '../format.ts';
import { href } from '../route.ts';
import { StatusDot } from '../StatusDot.tsx';
import { useStore } from '../store.tsx';
import type { Task } from '../types.ts';
import { CommandRunView } from './CommandRunView.tsx';
import { useBacklog } from './context.ts';
import { dependents, errorMessage, taskPill, taskTitle } from './tasks.ts';

export function TaskRow({
  task,
  index,
}: {
  task: Task;
  // Rang dans l'ordre de traitement de son epic.
  index?: number;
}) {
  const { sessions, updateTask, deleteTask } = useStore();
  const { projectTasks, epics, launching, startTask, reportError } = useBacklog();
  const session = sessions.find((s) => s.id === task.sessionId);
  const source = sessions.find((s) => s.id === task.sourceSessionId);
  const isLaunching = launching.has(task.id);
  const [expanded, setExpanded] = useState(false);
  const [commandActive, setCommandActive] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.text);
  const byId = new Map(projectTasks.map((t) => [t.id, t]));
  const dependencies = task.dependsOn.map((id) => byId.get(id)).filter((t): t is Task => t !== undefined);
  const blockers = dependencies.filter((t) => t.status !== 'done');
  const pill = taskPill(task, session, blockers.length > 0);
  // Relancer pendant que la session tourne en démarrerait une seconde et détacherait la première.
  const sessionActive = task.status === 'started' && session !== undefined && session.status !== 'exited';
  const excluded = dependents(task.id, projectTasks);
  const candidates = projectTasks.filter(
    (t) => t.id !== task.id && !task.dependsOn.includes(t.id) && !excluded.has(t.id),
  );
  const setDependencies = (dependsOn: string[]): void => {
    run(() => updateTask(task.id, { dependsOn }), 'Modification des dépendances impossible');
  };

  const run = (fn: () => Promise<unknown>, fallback: string): void => {
    void fn().catch((err: unknown) => reportError(errorMessage(err, fallback)));
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
        <button type="button" className="task-title" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          <span className="task-caret">{expanded ? '▾' : '▸'}</span>
          {index !== undefined ? <span className="task-index">{index}.</span> : null}
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
        {task.status !== 'done' && !sessionActive && !commandActive ? (
          <button
            type="button"
            className="btn primary"
            onClick={() => startTask(task)}
            disabled={isLaunching || blockers.length > 0}
            title={blockers.length > 0 ? "Terminez d'abord les tâches dont celle-ci dépend" : undefined}
          >
            {isLaunching ? 'Lancement…' : task.status === 'started' ? 'Relancer' : 'Traiter'}
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          onClick={() =>
            run(
              () => updateTask(task.id, { status: task.status === 'done' ? 'todo' : 'done' }),
              'Modification impossible',
            )
          }
        >
          {task.status === 'done' ? 'Rouvrir' : 'Marquer terminée'}
        </button>
        <DelayedActionButton onAction={() => run(() => deleteTask(task.id), 'Suppression impossible')}>
          Supprimer
        </DelayedActionButton>
      </div>
      {task.execution?.type === 'command' ? <CommandRunView task={task} onActive={setCommandActive} /> : null}
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
              {epics.length > 0 ? (
                <div className="task-deps">
                  <span className="meta">Epic :</span>
                  <select
                    value={task.epicId ?? ''}
                    onChange={(e) =>
                      run(
                        () => updateTask(task.id, { epicId: e.target.value === '' ? null : e.target.value }),
                        "Changement d'epic impossible",
                      )
                    }
                  >
                    <option value="">Sans epic</option>
                    {epics.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title.slice(0, 80)}
                      </option>
                    ))}
                  </select>
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
