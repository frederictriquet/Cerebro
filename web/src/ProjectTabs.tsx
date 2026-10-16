import { useState, type FormEvent } from 'react';
import { Modal } from './Dialog.tsx';
import { PathInput } from './PathInput.tsx';
import { go, href, type Route } from './route.ts';
import { useStore } from './store.tsx';

export function ProjectTabs({ route }: { route: Route }) {
  const { projects, sessions } = useStore();
  const [showNew, setShowNew] = useState(false);

  const activeProjectId =
    route.kind === 'project'
      ? route.projectId
      : route.kind === 'session'
        ? sessions.find((session) => session.id === route.sessionId)?.projectId
        : undefined;

  return (
    <nav className="project-tabs" aria-label="Projets">
      <a
        className={`project-tab project-tab-home${route.kind === 'home' ? ' active' : ''}`}
        href={href('#/')}
        aria-current={route.kind === 'home' ? 'page' : undefined}
        title="Accueil"
        aria-label="Accueil"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M2 7.5 8 2.5l6 5M3.5 6.5V13.5h3.5v-4h2v4h3.5V6.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </a>
      {projects.map((project) => {
        const active = project.id === activeProjectId;
        const projectSessions = sessions.filter((session) => session.projectId === project.id);
        const sessionCount = projectSessions.length;
        const alerts = projectSessions.filter((session) => session.attention);
        const alertTone = alerts.some((session) => session.status === 'waiting') ? 'waiting' : 'idle';
        const questions = alerts.filter((session) => session.status === 'waiting').length;
        const alertLabel =
          alerts.length > 0
            ? `${alerts.length} ${alerts.length > 1 ? 'sessions demandent' : 'session demande'} votre attention` +
              (questions > 0 ? ` (${questions} question${questions > 1 ? 's' : ''})` : '')
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
              <span
                className={`project-tab-alert ${alertTone}${alertTone === 'waiting' ? ' ask-mark' : ''}`}
                role="status"
                aria-label={alertLabel}
              >
                {alertTone === 'waiting' ? '?' : null}
              </span>
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
      <button
        type="button"
        className="project-tab project-tab-add"
        title="Nouveau projet"
        aria-label="Nouveau projet"
        onClick={() => setShowNew(true)}
      >
        +
      </button>
      {showNew ? <NewProjectDialog onClose={() => setShowNew(false)} /> : null}
    </nav>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const { createProject } = useStore();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const project = await createProject(name.trim(), path.trim());
      onClose();
      go(`#/p/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création impossible');
      setBusy(false);
    }
  };

  return (
    <Modal title="Nouveau projet" onClose={onClose}>
      <form className="new-project" onSubmit={(e) => void onCreate(e)}>
        <label>
          Nom
          <input
            required
            autoFocus
            autoComplete="off"
            placeholder="Nom"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block">
          Chemin
          <PathInput required value={path} onChange={setPath} />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="row-actions">
          <button type="submit" className="btn primary" disabled={busy}>
            Créer
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
        </div>
      </form>
    </Modal>
  );
}
