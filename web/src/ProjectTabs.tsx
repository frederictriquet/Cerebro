import { useState, type FormEvent } from 'react';
import { Modal } from './Dialog.tsx';
import { PathInput } from './PathInput.tsx';
import { go, type Route } from './route.ts';
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
            href={`#/p/${project.id}`}
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
