import { useState } from 'react';
import { isAwaiting, plural } from '../format.ts';
import { href } from '../route.ts';
import { useStore } from '../store.tsx';
import type { Project } from '../../../shared/types.ts';

/** Onglet « Projets » : un tap ouvre la page du projet (sessions, lancement, backlog). */
export function ProjectList() {
  const { projects, sessions, tasks, hasData, projectBehind } = useStore();
  const [showPaused, setShowPaused] = useState(false);
  if (!hasData) return <p className="m-hint">Chargement…</p>;
  if (projects.length === 0) return <p className="m-hint">Aucun projet : créez-le depuis la version complète.</p>;

  const activeProjects = projects.filter((project) => !project.paused);
  const pausedProjects = projects.filter((project) => project.paused);

  const renderCards = (items: Project[]) => (
    <ul className="m-list">
      {items.map((project) => {
        const own = sessions.filter((session) => session.projectId === project.id);
        const running = own.filter((session) => session.status !== 'exited').length;
        const awaiting = own.filter(isAwaiting).length;
        const open = tasks.filter((task) => task.projectId === project.id && task.status !== 'done').length;
        const behind = project.paused ? 0 : (projectBehind?.[project.id] ?? 0);
        return (
          <li key={project.id}>
            <a className="m-card" href={href(`#/p/${project.id}`)}>
              <span className="m-card-title">{project.name}</span>
              <span className="m-card-meta">
                <span>{plural(running, 'session active', 'sessions actives')}</span>
                {awaiting > 0 ? <span className="m-awaiting">{awaiting} à traiter</span> : null}
                {behind > 0 ? <span className="m-pull-needed">↓ {plural(behind, 'commit')} à tirer</span> : null}
                <span>{plural(open, 'tâche ouverte', 'tâches ouvertes')}</span>
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      {activeProjects.length === 0 ? <p className="m-hint">Aucun projet actif.</p> : renderCards(activeProjects)}
      {pausedProjects.length > 0 ? (
        <div className="m-paused-section">
          <button
            type="button"
            className="m-button"
            aria-expanded={showPaused}
            onClick={() => setShowPaused((shown) => !shown)}
          >
            {showPaused
              ? `Masquer les projets en pause (${pausedProjects.length})`
              : `Projets en pause (${pausedProjects.length})`}
          </button>
          {showPaused ? renderCards(pausedProjects) : null}
        </div>
      ) : null}
    </>
  );
}
