import { useState } from 'react';
import type { Epic, Task } from '../../../shared/types.ts';
import { DelayedActionButton } from '../DelayedActionButton.tsx';
import { LaunchSessionDialog } from '../Dialog.tsx';
import { errorMessage } from '../format.ts';
import { useStore } from '../store.tsx';
import { BacklogContext, type BacklogScope } from './context.ts';
import { EpicBlock } from './EpicBlock.tsx';
import { taskLabel } from './tasks.ts';
import { TaskComposer } from './TaskComposer.tsx';
import { TaskRow } from './TaskRow.tsx';

export function Backlog({ projectId }: { projectId: string }) {
  const { tasks, epics, startTask, startCommandTask, startEpic, deleteCompletedBacklog } = useStore();
  const projectTasks = tasks.filter((t) => t.projectId === projectId);
  const ownEpics = epics.filter((e) => e.projectId === projectId);
  const epicIds = new Set(ownEpics.map((e) => e.id));
  const open = projectTasks.filter((t) => t.status !== 'done');
  const done = projectTasks.filter((t) => t.status === 'done');
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<Task | null>(null);
  const [startingEpic, setStartingEpic] = useState<{ epic: Epic; prompt: string } | null>(null);
  const [launching, setLaunching] = useState<Set<string>>(() => new Set());

  // La modale se ferme à la validation ; le backlog garde le suivi du lancement.
  const launch = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    setError(null);
    setLaunching((current) => new Set(current).add(id));
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err, 'Lancement impossible'));
      throw err;
    } finally {
      setLaunching((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const deleteDone = (): void => {
    setError(null);
    void deleteCompletedBacklog(projectId).catch((err: unknown) =>
      setError(errorMessage(err, 'Suppression impossible')),
    );
  };

  const scope: BacklogScope = {
    projectId,
    projectTasks,
    epics: ownEpics,
    launching,
    // Une commande s'exécute sans session : rien à régler avant le lancement. Son démarrage passe par launch(),
    // qui affiche « Lancement… » et ignore un second clic tant que le premier n'a pas abouti.
    startTask: (task) => {
      if (task.execution?.type !== 'command') setStarting(task);
      else if (!launching.has(task.id)) void launch(task.id, () => startCommandTask(task.id)).catch(() => {});
    },
    // Un epic fait uniquement de commandes démarre sans réglages de session.
    startEpic: (epic, prompt) => {
      const members = projectTasks.filter((t) => t.epicId === epic.id && t.status !== 'done');
      if (!members.every((t) => t.execution?.type === 'command')) setStartingEpic({ epic, prompt });
      else if (!launching.has(epic.id)) void launch(epic.id, () => startEpic(epic.id)).catch(() => {});
    },
    reportError: setError,
  };

  const visible = (t: Task): boolean => showDone || t.status !== 'done';
  const tasksWithoutEpic = projectTasks.filter((t) => (t.epicId === null || !epicIds.has(t.epicId)) && visible(t));
  // Un epic entièrement terminé se range avec les tâches terminées.
  const shownEpics = ownEpics.filter((e) => {
    const members = projectTasks.filter((t) => t.epicId === e.id);
    return showDone || members.length === 0 || members.some((t) => t.status !== 'done');
  });

  return (
    <BacklogContext.Provider value={scope}>
      <section className="card project-panel backlog">
        <div className="project-panel-head">
          <h2>
            Backlog{' '}
            <span className="pill project-panel-count" title="Tâches ouvertes">
              {open.length}
            </span>
          </h2>
          <div className="row-actions">
            {done.length > 0 && showDone ? (
              <DelayedActionButton onAction={deleteDone}>Supprimer toutes les terminées</DelayedActionButton>
            ) : null}
            {done.length > 0 ? (
              <button type="button" className="btn" onClick={() => setShowDone((v) => !v)}>
                {showDone ? 'Masquer les terminées' : `Afficher les terminées (${done.length})`}
              </button>
            ) : null}
          </div>
        </div>
        <TaskComposer />
        {shownEpics.map((epic) => (
          <EpicBlock key={epic.id} epic={epic} showDone={showDone} />
        ))}
        {shownEpics.length > 0 && tasksWithoutEpic.length > 0 ? <h3 className="backlog-loose">Sans epic</h3> : null}
        {tasksWithoutEpic.length === 0 && shownEpics.length === 0 ? (
          <p className="empty-hint">
            Aucune tâche. Sélectionnez du texte dans un terminal, ou demandez à l'agent de mettre ses findings dans le
            backlog.
          </p>
        ) : tasksWithoutEpic.length > 0 ? (
          <ul className="task-list">
            {tasksWithoutEpic.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
        {starting ? (
          <LaunchSessionDialog
            title={`Traiter : ${taskLabel(starting, 80)}`}
            projectId={projectId}
            epicId={starting.epicId}
            initialPrompt={starting.text}
            onClose={() => setStarting(null)}
            onLaunch={async (spec) => {
              setStarting(null);
              await launch(starting.id, () => startTask(starting.id, spec));
            }}
          />
        ) : null}
        {startingEpic ? (
          <LaunchSessionDialog
            title={`Traiter l'epic : ${startingEpic.epic.title.slice(0, 80)}`}
            projectId={projectId}
            epicId={startingEpic.epic.id}
            initialPrompt={startingEpic.prompt}
            onClose={() => setStartingEpic(null)}
            onLaunch={async (spec) => {
              setStartingEpic(null);
              await launch(startingEpic.epic.id, () => startEpic(startingEpic.epic.id, spec));
            }}
          />
        ) : null}
      </section>
    </BacklogContext.Provider>
  );
}
