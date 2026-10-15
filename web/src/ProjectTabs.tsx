import { href, type Route } from './route.ts';
import { useStore } from './store.tsx';

export function ProjectTabs({ route }: { route: Route }) {
  const { projects, sessions } = useStore();

  if (projects.length === 0) return null;

  const activeProjectId =
    route.kind === 'project'
      ? route.projectId
      : route.kind === 'session'
        ? sessions.find((session) => session.id === route.sessionId)?.projectId
        : undefined;

  return (
    <nav className="project-tabs" aria-label="Projets">
      {projects.map((project) => {
        const active = project.id === activeProjectId;
        const projectSessions = sessions.filter((session) => session.projectId === project.id);
        const sessionCount = projectSessions.length;
        const alerts = projectSessions.filter((session) => session.attention);
        const alertTone = alerts.some((session) => session.status === 'waiting') ? 'waiting' : 'idle';
        const alertLabel =
          alerts.length > 0
            ? `${alerts.length} ${alerts.length > 1 ? 'sessions demandent' : 'session demande'} votre attention`
            : undefined;
        return (
          <a
            key={project.id}
            className={`project-tab${active ? ' active' : ''}${alerts.length > 0 ? ` alert ${alertTone}` : ''}`}
            href={href(`#/p/${project.id}`)}
            aria-current={active ? 'page' : undefined}
            title={alertLabel ? `${project.path}\n${alertLabel}` : project.path}
          >
            {alerts.length > 0 ? (
              <span className={`project-tab-alert ${alertTone}`} role="status" aria-label={alertLabel} />
            ) : null}
            <span className="project-tab-name">{project.name}</span>
            <span
              className="project-tab-count"
              aria-label={`${sessionCount} ${sessionCount > 1 ? 'sessions' : 'session'}`}
            >
              {sessionCount}
            </span>
          </a>
        );
      })}
    </nav>
  );
}
