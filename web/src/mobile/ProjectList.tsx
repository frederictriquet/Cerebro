import { isAwaiting, plural } from '../format.ts';
import { href } from '../route.ts';
import { useStore } from '../store.tsx';

/** Onglet « Projets » : un tap ouvre la page du projet (sessions, lancement, backlog). */
export function ProjectList() {
  const { projects, sessions, tasks, hasData } = useStore();
  if (!hasData) return <p className="m-hint">Chargement…</p>;
  if (projects.length === 0) return <p className="m-hint">Aucun projet : créez-le depuis la version complète.</p>;
  return (
    <ul className="m-list">
      {projects.map((project) => {
        const own = sessions.filter((session) => session.projectId === project.id);
        const running = own.filter((session) => session.status !== 'exited').length;
        const awaiting = own.filter(isAwaiting).length;
        const open = tasks.filter((task) => task.projectId === project.id && task.status !== 'done').length;
        return (
          <li key={project.id}>
            <a className="m-card" href={href(`#/p/${project.id}`)}>
              <span className="m-card-title">{project.name}</span>
              <span className="m-card-meta">
                <span>{plural(running, 'session active', 'sessions actives')}</span>
                {awaiting > 0 ? <span className="m-awaiting">{awaiting} à traiter</span> : null}
                <span>{plural(open, 'tâche ouverte', 'tâches ouvertes')}</span>
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
