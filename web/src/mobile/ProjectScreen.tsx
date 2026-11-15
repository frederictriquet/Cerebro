import { useState } from 'react';
import { useAsyncAction } from '../async-action.ts';
import { isAwaiting } from '../format.ts';
import { PinIcon } from '../PinIcon.tsx';
import { go } from '../route.ts';
import { useStore } from '../store.tsx';
import type { Project, Session } from '../../../shared/types.ts';
import { LaunchForm } from './LaunchForm.tsx';
import { MobileBacklog } from './MobileBacklog.tsx';
import { ProjectGit } from './MobileGit.tsx';
import { SessionCard } from './SessionCard.tsx';

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

/** Épingle et mise en pause du projet. */
function ProjectHeaderActions({ project }: { project: Project }) {
  const { setProjectPinned, setProjectPaused } = useStore();
  const {
    run: runPin,
    busy: pinBusy,
    error: pinError,
  } = useAsyncAction((value: boolean) => setProjectPinned(project.id, value), {
    fallback: 'Modification de l’épingle impossible',
  });
  const {
    run: runPause,
    busy: pauseBusy,
    error: pauseError,
  } = useAsyncAction((value: boolean) => setProjectPaused(project.id, value), {
    fallback: 'Modification de la mise en pause impossible',
  });
  const busy = pinBusy || pauseBusy;
  const error = pinError ?? pauseError;
  return (
    <div className="m-pin">
      <div className="m-project-actions">
        <button
          type="button"
          className={`m-button m-pin-button${project.pinned ? ' active' : ''}`}
          aria-pressed={project.pinned}
          disabled={busy}
          onClick={() => void runPin(!project.pinned)}
        >
          <PinIcon filled={project.pinned} />
          Épingler ce projet
        </button>
        <button
          type="button"
          className={`m-button m-pin-button${project.paused ? ' active' : ''}`}
          disabled={busy}
          onClick={() => {
            const next = !project.paused;
            void runPause(next).then((ok) => {
              if (ok && next) go('#/');
            });
          }}
        >
          {project.paused ? 'Reprendre ce projet' : 'Mettre en pause'}
        </button>
      </div>
      {error === null ? null : (
        <p className="m-form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Page projet `#/p/<id>` : épingle, sessions, Git, lancement et backlog. */
export function ProjectScreen({ projectId }: { projectId: string }) {
  const { projects, sessions, loaded } = useStore();
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

  return (
    <div className="m-content">
      <ProjectHeaderActions project={project} />
      <section className="m-section" aria-labelledby="m-sessions-title">
        <h2 className="m-section-title" id="m-sessions-title">
          Sessions
        </h2>
        {current.length === 0 ? <p className="m-hint">Aucune session active.</p> : <SessionCards sessions={current} />}
        {ended.length === 0 ? null : (
          <button type="button" className="m-button" onClick={() => setShowEnded((shown) => !shown)}>
            {showEnded ? 'Masquer les terminées' : `Afficher les terminées (${ended.length})`}
          </button>
        )}
        {showEnded ? <SessionCards sessions={ended} /> : null}
      </section>
      {/* Remontés à chaque projet. Des clés distinctes entre frères : une clé partagée laissait la section Git du
          projet précédent affichée après un changement de projet. */}
      <ProjectGit key={`git:${project.id}`} project={project} />
      <LaunchForm key={`launch:${project.id}`} project={project} />
      <MobileBacklog project={project} />
    </div>
  );
}
