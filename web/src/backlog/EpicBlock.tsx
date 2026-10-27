import { useState } from 'react';
import { DelayedActionButton } from '../DelayedActionButton.tsx';
import { EpicReviewActions } from '../EpicReviewActions.tsx';
import { RUN_ACTIVE, useEpicRun } from '../epic-runs.ts';
import { STATUS_LABEL, WORKSPACE_TARGET, sessionTitle } from '../format.ts';
import { href } from '../route.ts';
import { StatusDot } from '../StatusDot.tsx';
import { useStore } from '../store.tsx';
import type { Epic, Task } from '../types.ts';
import { useBacklog } from './context.ts';
import { EpicForm } from './EpicForm.tsx';
import { EpicRunPanel } from './EpicRunPanel.tsx';
import { dependencyOrder, epicPrompt, errorMessage, taskTitle } from './tasks.ts';
import { TaskRow } from './TaskRow.tsx';

function useCollapsed(key: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      if (next) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    } catch {
      /* quota / mode privé : le repli reste utilisable sans persistance */
    }
  };
  return [collapsed, toggle];
}

export function EpicBlock({ epic, showDone }: { epic: Epic; showDone: boolean }) {
  const { projects, sessions, updateEpic, deleteEpic } = useStore();
  const { projectTasks, launching, startEpic, reportError } = useBacklog();
  const project = projects.find((p) => p.id === epic.projectId);
  const workspaceMode = project?.workspaceMode ?? 'isolated';
  const [collapsed, toggleCollapsed] = useCollapsed(`cerebro.epicCollapsed.${epic.id}`);
  const [editing, setEditing] = useState(false);
  const { run, refresh: refreshRun } = useEpicRun(epic.id);
  const members = projectTasks.filter((t) => t.epicId === epic.id);
  const ordered = dependencyOrder(members);
  const open = ordered.filter((t) => t.status !== 'done');
  const doneCount = members.length - open.length;
  const byId = new Map(projectTasks.map((t) => [t.id, t]));
  const outsideBlockers = open
    .flatMap((t) => t.dependsOn)
    .map((id) => byId.get(id))
    .filter((t): t is Task => t !== undefined && t.epicId !== epic.id && t.status !== 'done');
  const activeSession = open
    .map((t) => (t.status === 'started' ? sessions.find((s) => s.id === t.sessionId) : undefined))
    .find((s) => s !== undefined && s.status !== 'exited');
  const position = new Map(open.map((t, i) => [t.id, i + 1]));
  const continuedWorkspace = run?.workspace ?? null;
  const continuesEpic = continuedWorkspace !== null;
  const continuesWorktree = continuedWorkspace?.mode === 'isolated';
  // Le serveur refuse une nouvelle exécution tant qu'une autre est active ; une exécution en échec se reprend
  // par « Reprendre » dans son panneau.
  const runHoldsEpic = run !== null && (RUN_ACTIVE.includes(run.status) || run.status === 'failed');
  const isLaunching = launching.has(epic.id);
  const taskLabel = (id: string): string => {
    const task = byId.get(id);
    return task ? taskTitle(task.text).slice(0, 80) : id;
  };
  // Affichées dans l'ordre de création ; le numéro donne le rang de traitement (ordre des dépendances).
  const shown = showDone ? members : members.filter((t) => t.status !== 'done');
  const startHint =
    open.length === 0
      ? 'Aucune tâche ouverte dans cet epic'
      : outsideBlockers.length > 0
        ? `Attend des tâches hors de l'epic : ${outsideBlockers.map((t) => taskTitle(t.text).slice(0, 60)).join(' · ')}`
        : activeSession !== undefined
          ? 'Une session traite déjà cet epic'
          : `Le serveur ordonnance les ${open.length} tâche(s) selon leurs dépendances${continuedWorkspace ? `, dans ${continuedWorkspace.path}` : ''}`;

  return (
    <div className="epic">
      <div className="epic-head">
        <button type="button" className="epic-title" aria-expanded={!collapsed} onClick={toggleCollapsed}>
          <span className="task-caret">{collapsed ? '▸' : '▾'}</span>
          <span className="epic-badge">Epic</span>
          <span>{epic.title}</span>
        </button>
        <div className="task-row-meta">
          <span className={`pill task-status ${members.length > 0 && open.length === 0 ? 'done' : ''}`}>
            {doneCount}/{members.length} terminée{doneCount > 1 ? 's' : ''}
          </span>
          <span className="epic-progress" aria-hidden="true">
            <span style={{ width: members.length === 0 ? 0 : `${(doneCount / members.length) * 100}%` }} />
          </span>
          {activeSession ? (
            <a
              className="task-session"
              href={href(`#/s/${activeSession.id}`)}
              title={STATUS_LABEL[activeSession.status]}
            >
              <StatusDot status={activeSession.status} title={STATUS_LABEL[activeSession.status]} />
              {sessionTitle(activeSession.title)}
            </a>
          ) : null}
        </div>
        <div className="row-actions">
          {runHoldsEpic ? null : (
            <button
              type="button"
              className="btn primary"
              disabled={isLaunching || open.length === 0 || outsideBlockers.length > 0 || activeSession !== undefined}
              title={startHint}
              onClick={() => startEpic(epic, epicPrompt(epic))}
            >
              {isLaunching
                ? 'Lancement…'
                : continuesWorktree
                  ? 'Poursuivre l’epic dans son worktree'
                  : continuesEpic
                    ? 'Poursuivre l’epic dans son dossier d’origine'
                    : open.every((t) => t.execution?.type === 'command')
                      ? "Traiter l'epic"
                      : `Traiter l'epic ${WORKSPACE_TARGET[workspaceMode]}`}
            </button>
          )}
          <EpicReviewActions epic={epic} run={run} onError={reportError} />
          <button type="button" className="btn" onClick={() => setEditing((v) => !v)}>
            Éditer
          </button>
          <DelayedActionButton
            onAction={() =>
              void deleteEpic(epic.id).catch((err: unknown) => reportError(errorMessage(err, 'Suppression impossible')))
            }
          >
            Supprimer l'epic
          </DelayedActionButton>
        </div>
      </div>
      {run ? <EpicRunPanel run={run} taskLabel={taskLabel} onChanged={refreshRun} /> : null}
      {editing ? (
        <EpicForm
          initialTitle={epic.title}
          initialDescription={epic.description}
          submitLabel="Enregistrer"
          onCancel={() => setEditing(false)}
          onSubmit={async (title, description) => {
            await updateEpic(epic.id, { title, description });
            setEditing(false);
          }}
        />
      ) : epic.description !== '' && !collapsed ? (
        <p className="epic-description">{epic.description}</p>
      ) : null}
      {collapsed ? null : shown.length === 0 ? (
        <p className="empty-hint">
          {members.length === 0
            ? "Epic vide : rangez-y des tâches (menu « Epic » d'une tâche, ou sélecteur sous le champ d'ajout)."
            : 'Toutes les tâches sont terminées.'}
        </p>
      ) : (
        <ul className="task-list">
          {shown.map((task) => (
            <TaskRow key={task.id} task={task} index={position.get(task.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}
