import { useState } from 'react';
import { dependencyOrder, openBlockers, taskLabel, taskPill, taskTitle } from '../backlog/tasks.ts';
import { errorMessage } from '../format.ts';
import { go, href } from '../route.ts';
import { useStore } from '../store.tsx';
import type { Project, Session, Task } from '../../../shared/types.ts';

/**
 * Tâches ouvertes du projet groupées par epic, dans l'ordre de traitement. « Démarrer » lance la tâche avec les
 * réglages du projet, comme le desktop, puis ouvre la session. Création, édition et lancement d'epic restent
 * sur la version complète.
 */
export function MobileBacklog({ project }: { project: Project }) {
  const { tasks, epics, sessions, startTask } = useStore();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [launching, setLaunching] = useState<string | null>(null);
  // Affichée dans la tâche tapée : en tête du backlog, elle tomberait hors de l'écran.
  const [error, setError] = useState<{ taskId: string; message: string } | null>(null);
  const projectTasks = tasks.filter((task) => task.projectId === project.id);
  const open = projectTasks.filter((task) => task.status !== 'done');
  const ownEpics = epics.filter((epic) => epic.projectId === project.id);
  const epicIds = new Set(ownEpics.map((epic) => epic.id));
  const groups = [
    ...ownEpics.map((epic) => ({
      key: epic.id,
      title: epic.title,
      tasks: dependencyOrder(open.filter((task) => task.epicId === epic.id)),
    })),
    {
      key: '',
      title: 'Sans epic',
      tasks: open.filter((task) => task.epicId === null || !epicIds.has(task.epicId)),
    },
  ].filter((group) => group.tasks.length > 0);

  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const start = async (task: Task): Promise<void> => {
    if (launching !== null) return;
    setLaunching(task.id);
    setError(null);
    try {
      const session = await startTask(task.id, { ...project.sessionDefaults, prompt: task.text });
      go(`#/s/${session.id}`);
    } catch (err) {
      setError({ taskId: task.id, message: errorMessage(err, 'Lancement impossible') });
    } finally {
      setLaunching(null);
    }
  };

  return (
    <section className="m-section" aria-labelledby="m-backlog-title">
      <h2 className="m-section-title" id="m-backlog-title">
        Backlog ({open.length})
      </h2>
      {groups.length === 0 ? <p className="m-hint">Aucune tâche ouverte.</p> : null}
      {groups.map((group) => (
        <div key={group.key} className="m-epic">
          <h3 className="m-epic-title">{group.key === '' ? group.title : `Epic : ${group.title}`}</h3>
          <ul className="m-list">
            {group.tasks.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                blockers={openBlockers(task, projectTasks)}
                session={sessions.find((session) => session.id === task.sessionId)}
                expanded={expanded.has(task.id)}
                launching={launching}
                error={error?.taskId === task.id ? error.message : null}
                onToggle={() => toggle(task.id)}
                onStart={() => void start(task)}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function TaskItem({
  task,
  blockers,
  session,
  expanded,
  launching,
  error,
  onToggle,
  onStart,
}: {
  task: Task;
  blockers: Task[];
  session: Session | undefined;
  expanded: boolean;
  launching: string | null;
  error: string | null;
  onToggle: () => void;
  onStart: () => void;
}) {
  const pill = taskPill(task, session, blockers.length > 0);
  const command = task.execution?.type === 'command';
  // Règles de TaskRow : pas de lancement tant qu'une dépendance est ouverte ni pendant que sa session tourne
  // (le serveur refuserait). Une commande ne crée pas de session : elle se lance depuis la version complète.
  const sessionActive = task.status === 'started' && session !== undefined && session.status !== 'exited';
  const startable = blockers.length === 0 && !sessionActive && !command;
  return (
    <li className="m-task">
      <button type="button" className="m-task-title" aria-expanded={expanded} onClick={onToggle}>
        <span className="m-task-caret" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span>{taskTitle(task.text)}</span>
      </button>
      <div className="m-card-meta">
        <span className={`pill task-status ${pill.className}`}>{pill.label}</span>
        {command ? <span>Commande : version complète</span> : null}
        {session ? <a href={href(`#/s/${session.id}`)}>Voir la session</a> : null}
      </div>
      {blockers.length > 0 ? (
        <p className="m-task-blockers">Attend : {blockers.map((blocker) => taskLabel(blocker, 60)).join(' · ')}</p>
      ) : null}
      {expanded ? <pre className="m-task-text">{task.text}</pre> : null}
      {startable ? (
        <button type="button" className="m-button primary" disabled={launching !== null} onClick={onStart}>
          {launching === task.id ? 'Lancement…' : task.status === 'started' ? 'Relancer' : 'Démarrer'}
        </button>
      ) : null}
      {error === null ? null : (
        <p className="m-form-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
