import { useState } from 'react';
import { isAwaiting } from '../format.ts';
import { useStore } from '../store.tsx';
import type { Session } from '../../../shared/types.ts';
import { LaunchForm } from './LaunchForm.tsx';
import { MobileBacklog } from './MobileBacklog.tsx';
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

/** Page projet `#/p/<id>` : sessions, lancement et backlog. */
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
      <LaunchForm key={project.id} project={project} />
      <MobileBacklog project={project} />
    </div>
  );
}
