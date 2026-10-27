import { ActivityStatus } from './ActivityStatus.tsx';
import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Modal } from './Dialog.tsx';
import { PathInput } from './PathInput.tsx';
import { go, href, type Route } from './route.ts';
import { useStore } from './store.tsx';

export function ProjectTabs({ route }: { route: Route }) {
  const { projects, sessions, reorderProjects } = useStore();
  const [showNew, setShowNew] = useState(false);
  const draggedId = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearDrag = (): void => {
    draggedId.current = null;
    setDragging(null);
    setDropTarget(null);
  };

  const dropSide = (event: DragEvent<HTMLAnchorElement>): 'before' | 'after' => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  };

  const dropProject = async (event: DragEvent<HTMLAnchorElement>, targetId: string): Promise<void> => {
    const sourceId = draggedId.current;
    if (sourceId === null) return;
    event.preventDefault();
    const side = dropSide(event);
    clearDrag();
    if (saving || sourceId === targetId || !projects.some((project) => project.id === sourceId)) return;
    const ids = projects.map((project) => project.id).filter((id) => id !== sourceId);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex === -1) return;
    ids.splice(targetIndex + (side === 'after' ? 1 : 0), 0, sourceId);
    if (ids.every((id, index) => id === projects[index]?.id)) return;

    setSaving(true);
    try {
      await reorderProjects(ids);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Réordonnancement impossible');
    } finally {
      setSaving(false);
    }
  };

  const activeProjectId =
    route.kind === 'project'
      ? route.projectId
      : route.kind === 'session'
        ? sessions.find((session) => session.id === route.sessionId)?.projectId
        : undefined;

  return (
    <nav
      className="project-tabs"
      aria-label="Projets"
      aria-busy={saving}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
          setDropTarget(null);
      }}
    >
      <a
        className={`project-tab project-tab-home${route.kind === 'home' ? ' active' : ''}`}
        href={href('#/')}
        draggable={false}
        onDragOver={() => setDropTarget(null)}
        aria-current={route.kind === 'home' ? 'page' : undefined}
        title="Accueil"
        aria-label="Accueil"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M2 7.5 8 2.5l6 5M3.5 6.5V13.5h3.5v-4h2v4h3.5V6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
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
            className={`project-tab${active ? ' active' : ''}${alerts.length > 0 ? ` alert ${alertTone}` : ''}${dragging === project.id ? ' dragging' : ''}${dropTarget?.id === project.id ? ` drop-${dropTarget.side}` : ''}`}
            href={href(`#/p/${project.id}`)}
            aria-current={active ? 'page' : undefined}
            title={`${project.path}${alertLabel ? `\n${alertLabel}` : ''}`}
            draggable={false}
            onDragOver={(event) => {
              if (draggedId.current === null || saving) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropTarget(draggedId.current === project.id ? null : { id: project.id, side: dropSide(event) });
            }}
            onDrop={(event) => void dropProject(event, project.id)}
          >
            <span
              className="project-tab-handle"
              title="Glisser pour réordonner"
              draggable={!saving}
              onClick={(event) => event.preventDefault()}
              onDragStart={(event) => {
                if (saving) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.clearData();
                event.dataTransfer.setData('application/x-cerebro-project', project.id);
                const tab = event.currentTarget.parentElement;
                if (tab) {
                  const rect = tab.getBoundingClientRect();
                  event.dataTransfer.setDragImage(tab, event.clientX - rect.left, event.clientY - rect.top);
                }
                draggedId.current = project.id;
                setDragging(project.id);
                setDropTarget(null);
                setError(null);
              }}
              onDragEnd={clearDrag}
            >
              <svg viewBox="0 0 12 16" width="12" height="16" role="img" aria-label="Déplacer le projet">
                <g fill="currentColor">
                  <circle cx="4" cy="3" r="1.2" />
                  <circle cx="8" cy="3" r="1.2" />
                  <circle cx="4" cy="8" r="1.2" />
                  <circle cx="8" cy="8" r="1.2" />
                  <circle cx="4" cy="13" r="1.2" />
                  <circle cx="8" cy="13" r="1.2" />
                </g>
              </svg>
            </span>
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
        onDragOver={() => setDropTarget(null)}
        onClick={() => setShowNew(true)}
      >
        +
      </button>
      {error ? (
        <p className="project-tabs-error form-error" role="alert">
          {error}
        </p>
      ) : null}
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
            <ActivityStatus active={busy}>{busy ? 'Création…' : 'Créer'}</ActivityStatus>
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
        </div>
      </form>
    </Modal>
  );
}
