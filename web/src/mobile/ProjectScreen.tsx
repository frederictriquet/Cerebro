import { useState } from 'react';
import { useAsyncAction } from '../async-action.ts';
import { isAwaiting, plural } from '../format.ts';
import { PinIcon } from '../PinIcon.tsx';
import { go } from '../route.ts';
import { useStore } from '../store.tsx';
import type { Session } from '../../../shared/types.ts';
import { LaunchForm } from './LaunchForm.tsx';
import { MobileBacklog } from './MobileBacklog.tsx';
import { ProjectGit } from './MobileGit.tsx';
import { SessionCard } from './SessionCard.tsx';
import { SwipeTabs, type SwipeTab } from './SwipeTabs.tsx';

export type ProjectTab = 'sessions' | 'launch' | 'backlog' | 'git';

function SessionCards({ sessions }: { sessions: Session[] }) {
  return (
    <ul className="m-list">
      {sessions.map((session) => (
        <li key={session.id}>
          <SessionCard session={session} />
        </li>
      ))}
    </ul>
  );
}

function PauseIcon({ paused }: { paused: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paused ? (
        <path d="M7 5l12 7-12 7z" />
      ) : (
        <>
          <path d="M9 5v14" />
          <path d="M15 5v14" />
        </>
      )}
    </svg>
  );
}

/**
 * Épingle et mise en pause du projet, en boutons à icône dans la barre du haut. [SPEC: vue mobile, page projet]
 * L'échec s'affiche sous la barre, par `onError`.
 */
export function ProjectHeaderActions({
  projectId,
  onError,
}: {
  projectId: string;
  onError: (message: string | null) => void;
}) {
  const { projects, setProjectPinned, setProjectPaused } = useStore();
  const project = projects.find((candidate) => candidate.id === projectId);
  const pin = useAsyncAction((value: boolean) => setProjectPinned(projectId, value), {
    fallback: 'Modification de l’épingle impossible',
    onError,
  });
  const pause = useAsyncAction((value: boolean) => setProjectPaused(projectId, value), {
    fallback: 'Modification de la mise en pause impossible',
    onError,
  });
  if (project === undefined) return null;
  const busy = pin.busy || pause.busy;
  const pinLabel = project.pinned ? 'Désépingler ce projet' : 'Épingler ce projet';
  const pauseLabel = project.paused ? 'Reprendre ce projet' : 'Mettre en pause';
  return (
    <>
      <button
        type="button"
        className={`m-icon-action${project.pinned ? ' active' : ''}`}
        aria-pressed={project.pinned}
        aria-label={pinLabel}
        title={pinLabel}
        disabled={busy}
        onClick={() => void pin.run(!project.pinned)}
      >
        <PinIcon filled={project.pinned} />
      </button>
      <button
        type="button"
        className={`m-icon-action${project.paused ? ' active' : ''}`}
        aria-pressed={project.paused}
        aria-label={pauseLabel}
        title={pauseLabel}
        disabled={busy}
        onClick={() => {
          const next = !project.paused;
          void pause.run(next).then((ok) => {
            if (ok && next) go('#/');
          });
        }}
      >
        <PauseIcon paused={project.paused} />
      </button>
    </>
  );
}

/** Page projet `#/p/<id>` : onglets Sessions, Lancer, Backlog et Git, au tap ou au balayage. [SPEC: vue mobile, page projet] */
export function ProjectScreen({
  projectId,
  tab,
  onTab,
}: {
  projectId: string;
  tab: ProjectTab;
  onTab: (tab: ProjectTab) => void;
}) {
  const { projects, sessions, tasks, projectBehind, loaded } = useStore();
  const [showEnded, setShowEnded] = useState(false);
  const project = projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return (
      <section className="m-content">
        <p className="m-hint">{loaded ? 'Projet introuvable.' : 'Chargement…'}</p>
      </section>
    );
  }
  const own = sessions.filter((session) => session.projectId === projectId);
  // Une session terminée qui réclame encore l'attention reste en tête avec les sessions actives.
  const current = own.filter((session) => session.status !== 'exited' || isAwaiting(session));
  const ended = own.filter((session) => !current.includes(session));
  const awaiting = current.filter(isAwaiting).length;
  const open = tasks.filter((task) => task.projectId === projectId && task.status !== 'done').length;
  const behind = project.paused ? 0 : (projectBehind?.[project.id] ?? 0);

  const tabs: SwipeTab<ProjectTab>[] = [
    {
      id: 'sessions',
      label: 'Sessions',
      badge:
        current.length === 0 ? undefined : (
          <span
            className={`m-tab-count${awaiting > 0 ? ' waiting' : ''}`}
            aria-label={
              awaiting > 0 ? `${awaiting} à traiter` : plural(current.length, 'session active', 'sessions actives')
            }
          >
            {awaiting > 0 ? awaiting : current.length}
          </span>
        ),
      className: 'm-content',
      content: (
        <>
          {current.length === 0 ? (
            <p className="m-hint">Aucune session active.</p>
          ) : (
            <SessionCards sessions={current} />
          )}
          {ended.length === 0 ? null : (
            <button type="button" className="m-button m-wide" onClick={() => setShowEnded((shown) => !shown)}>
              {showEnded ? 'Masquer les terminées' : `Afficher les terminées (${ended.length})`}
            </button>
          )}
          {showEnded ? <SessionCards sessions={ended} /> : null}
        </>
      ),
    },
    {
      id: 'launch',
      label: 'Lancer',
      className: 'm-content',
      // Remonté à chaque projet : le formulaire repart des réglages du projet ouvert.
      content: <LaunchForm key={`launch:${project.id}`} project={project} />,
    },
    {
      id: 'backlog',
      label: 'Backlog',
      badge:
        open === 0 ? undefined : (
          <span className="m-tab-count" aria-label={plural(open, 'tâche ouverte', 'tâches ouvertes')}>
            {open}
          </span>
        ),
      className: 'm-content',
      content: <MobileBacklog project={project} />,
    },
    {
      id: 'git',
      label: 'Git',
      badge:
        behind === 0 ? undefined : (
          <span className="m-tab-pull" aria-label={`${plural(behind, 'commit')} à tirer`}>
            ↓{behind}
          </span>
        ),
      className: 'm-content',
      // Clé distincte par projet : une clé partagée laissait la section Git du projet précédent affichée.
      content: <ProjectGit key={`git:${project.id}`} project={project} />,
    },
  ];
  return <SwipeTabs label="Projet" idPrefix="m-project" tabs={tabs} value={tab} onChange={onTab} />;
}
