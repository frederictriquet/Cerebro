import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Modal } from './Dialog.tsx';
import { attentionCounts, plural } from './format.ts';
import { NewProjectForm } from './NewProjectForm.tsx';
import { go, href, type Route } from './route.ts';
import { useStore } from './store.tsx';
import { useAsyncAction } from './async-action.ts';

function PauseGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <rect x="3.5" y="2.5" width="3" height="11" rx="0.8" fill="currentColor" />
      <rect x="9.5" y="2.5" width="3" height="11" rx="0.8" fill="currentColor" />
    </svg>
  );
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M4.5 2.8 13 8l-8.5 5.2Z" fill="currentColor" />
    </svg>
  );
}

function navigateHome(): void {
  if (typeof go === 'function') go('#/');
  else if (typeof window !== 'undefined') window.location.hash = href('#/');
}

export function ProjectTabs({ route }: { route: Route }) {
  const { projects, sessions, tasks, reorderProjects, setProjectPaused, projectBehind } = useStore();
  const [showNew, setShowNew] = useState(false);
  const [showPaused, setShowPaused] = useState(false);
  const [alignPausedRight, setAlignPausedRight] = useState(false);
  const [pausedFilter, setPausedFilter] = useState('');
  const [pauseDrop, setPauseDrop] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
  const draggedId = useRef<string | null>(null);
  const pausedWrapRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' } | null>(null);
  const {
    run: reorder,
    busy: reordering,
    error: reorderError,
    setError: setReorderError,
  } = useAsyncAction(reorderProjects, { fallback: 'Réordonnancement impossible' });
  const {
    run: changePaused,
    busy: pausing,
    error: pauseError,
    setError: setPauseError,
  } = useAsyncAction(({ id, paused }: { id: string; paused: boolean }) => setProjectPaused(id, paused), {
    fallback: 'Modification de la mise en pause impossible',
  });
  const saving = reordering || pausing;
  const error = reorderError ?? pauseError;

  const clearDrag = (): void => {
    draggedId.current = null;
    setDragging(null);
    setDropTarget(null);
    setPauseDrop(false);
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
    await reorder(ids);
  };

  const activeProjectId =
    route.kind === 'project'
      ? route.projectId
      : route.kind === 'session'
        ? sessions.find((session) => session.id === route.sessionId)?.projectId
        : undefined;

  const pausedProjects = projects.filter((project) => project.paused);
  const visibleProjects = projects.filter((project) => !project.paused || project.id === activeProjectId);
  const pausedIds = new Set(pausedProjects.map((project) => project.id));
  const pausedSessions = sessions.filter((session) => pausedIds.has(session.projectId));
  const { total: pausedAlerts, waiting: pausedQuestions } = attentionCounts(pausedSessions);
  const pausedAlertTone = pausedQuestions > 0 ? 'waiting' : 'idle';
  const pausedAlertLabel =
    pausedAlerts > 0
      ? `${plural(pausedAlerts, 'session demande', 'sessions demandent')} votre attention dans les projets en pause` +
        (pausedQuestions > 0 ? ` (${plural(pausedQuestions, 'question')})` : '')
      : undefined;

  const menuOpen = showPaused && pausedProjects.length > 0;

  useEffect(() => {
    if (!menuOpen && contextMenu === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setShowPaused(false);
        setContextMenu(null);
      }
    };
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuOpen && pausedWrapRef.current && !pausedWrapRef.current.contains(target)) {
        setShowPaused(false);
      }
      if (contextMenu !== null && contextMenuRef.current && !contextMenuRef.current.contains(target)) {
        setContextMenu(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [menuOpen, contextMenu]);

  const pauseProject = async (id: string): Promise<void> => {
    setPauseError(null);
    const ok = await changePaused({ id, paused: true });
    if (ok && id === activeProjectId) navigateHome();
  };

  const resumeProject = async (id: string): Promise<void> => {
    setPauseError(null);
    if (pausedProjects.length <= 1) setShowPaused(false);
    await changePaused({ id, paused: false });
  };

  const dropToPause = async (event: DragEvent<HTMLButtonElement>): Promise<void> => {
    const sourceId = draggedId.current;
    if (sourceId === null) return;
    event.preventDefault();
    clearDrag();
    const source = projects.find((project) => project.id === sourceId);
    if (saving || !source || source.paused) return;
    await pauseProject(sourceId);
  };

  const togglePausedMenu = (): void => {
    if (pausedProjects.length === 0) return;
    setContextMenu(null);
    setPausedFilter('');
    if (!menuOpen && pausedWrapRef.current && typeof window !== 'undefined') {
      const rect = pausedWrapRef.current.getBoundingClientRect();
      setAlignPausedRight(rect.left + 320 > window.innerWidth);
    }
    setShowPaused(!menuOpen);
  };

  const normalizedFilter = pausedFilter.trim().toLowerCase();
  const filteredPaused =
    normalizedFilter === ''
      ? pausedProjects
      : pausedProjects.filter(
          (project) =>
            project.name.toLowerCase().includes(normalizedFilter) ||
            project.path.toLowerCase().includes(normalizedFilter),
        );

  const contextProject =
    contextMenu === null ? undefined : projects.find((project) => project.id === contextMenu.projectId);

  return (
    <nav
      className="project-tabs"
      aria-label="Projets"
      aria-busy={saving}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setDropTarget(null);
          setPauseDrop(false);
        }
      }}
    >
      <a
        className={`project-tab project-tab-home${route.kind === 'home' ? ' active' : ''}`}
        href={href('#/')}
        draggable={false}
        onDragOver={() => {
          setDropTarget(null);
          setPauseDrop(false);
        }}
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
      {visibleProjects.map((project) => {
        const active = project.id === activeProjectId;
        const projectSessions = sessions.filter((session) => session.projectId === project.id);
        const sessionCount = projectSessions.length;
        const { total: alerts, waiting: questions } = attentionCounts(projectSessions);
        const alertTone = questions > 0 ? 'waiting' : 'idle';
        const alertLabel =
          alerts > 0
            ? `${plural(alerts, 'session demande', 'sessions demandent')} votre attention` +
              (questions > 0 ? ` (${plural(questions, 'question')})` : '')
            : undefined;
        const behind = project.paused ? 0 : (projectBehind?.[project.id] ?? 0);
        const pullLabel = behind > 0 ? `${plural(behind, 'commit')} à tirer` : undefined;
        return (
          <a
            key={project.id}
            className={`project-tab${project.color ? ' colored' : ''}${project.paused ? ' paused' : ''}${active ? ' active' : ''}${alerts > 0 ? ` alert ${alertTone}` : ''}${dragging === project.id ? ' dragging' : ''}${dropTarget?.id === project.id ? ` drop-${dropTarget.side}` : ''}`}
            style={project.color ? ({ '--project-color': project.color } as CSSProperties) : undefined}
            href={href(`#/p/${project.id}`)}
            aria-current={active ? 'page' : undefined}
            title={[project.path, project.paused ? 'Projet en pause' : undefined, alertLabel, pullLabel]
              .filter(Boolean)
              .join('\n')}
            draggable={false}
            onContextMenu={(event) => {
              event.preventDefault();
              setShowPaused(false);
              const maxX =
                typeof window === 'undefined' ? event.clientX : Math.min(event.clientX, window.innerWidth - 200);
              setContextMenu({ projectId: project.id, x: Math.max(8, maxX), y: event.clientY });
            }}
            onDragOver={(event) => {
              if (draggedId.current === null || saving || project.paused) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setPauseDrop(false);
              const side = draggedId.current === project.id ? null : dropSide(event);
              setDropTarget((current) =>
                side === null
                  ? null
                  : current?.id === project.id && current.side === side
                    ? current
                    : { id: project.id, side },
              );
            }}
            onDrop={(event) => void dropProject(event, project.id)}
          >
            <span
              className="project-tab-handle"
              title={project.paused ? 'Projet en pause' : 'Glisser pour réordonner ou déposer sur Pause'}
              draggable={!saving && !project.paused}
              onClick={(event) => event.preventDefault()}
              onDragStart={(event) => {
                if (saving || project.paused) {
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
                setPauseDrop(false);
                setShowPaused(false);
                setContextMenu(null);
                setReorderError(null);
                setPauseError(null);
              }}
              onDragEnd={clearDrag}
            >
              {project.paused ? (
                <PauseGlyph />
              ) : (
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
              )}
            </span>
            {alerts > 0 ? (
              <span
                className={`project-tab-alert ${alertTone}${alertTone === 'waiting' ? ' ask-mark' : ''}`}
                role="status"
                aria-label={alertLabel}
              >
                {alertTone === 'waiting' ? '?' : null}
              </span>
            ) : null}
            <span className="project-tab-name">{project.name}</span>
            {behind > 0 ? (
              <span className="project-tab-pull" role="status" aria-label={pullLabel}>
                ↓{behind}
              </span>
            ) : null}
            <span
              className="project-tab-count"
              aria-label={`${sessionCount} ${sessionCount > 1 ? 'sessions' : 'session'}`}
            >
              {sessionCount}
            </span>
          </a>
        );
      })}
      {pausedProjects.length > 0 || dragging !== null ? (
        <div className="paused-projects-wrap" ref={pausedWrapRef}>
          <button
            type="button"
            className={`project-tab project-tab-paused-btn${menuOpen ? ' open' : ''}${pauseDrop ? ' drop-pause' : ''}${pausedAlerts > 0 ? ` alert ${pausedAlertTone}` : ''}`}
            aria-expanded={pausedProjects.length > 0 ? menuOpen : undefined}
            aria-haspopup={pausedProjects.length > 0 ? 'dialog' : undefined}
            title={
              dragging !== null
                ? 'Glisser ici pour mettre le projet en pause'
                : [`${plural(pausedProjects.length, 'projet')} en pause`, pausedAlertLabel].filter(Boolean).join('\n')
            }
            aria-label={
              pausedProjects.length > 0
                ? `Projets en pause (${pausedProjects.length})`
                : 'Glisser ici pour mettre en pause'
            }
            onClick={togglePausedMenu}
            onDragOver={(event) => {
              if (draggedId.current === null || saving) return;
              const source = projects.find((project) => project.id === draggedId.current);
              if (!source || source.paused) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropTarget(null);
              setPauseDrop(true);
            }}
            onDragLeave={() => setPauseDrop(false)}
            onDrop={(event) => void dropToPause(event)}
          >
            {pausedAlerts > 0 ? (
              <span
                className={`project-tab-alert ${pausedAlertTone}${pausedAlertTone === 'waiting' ? ' ask-mark' : ''}`}
                role="status"
                aria-label={pausedAlertLabel}
              >
                {pausedAlertTone === 'waiting' ? '?' : null}
              </span>
            ) : null}
            <PauseGlyph />
            {pausedProjects.length > 0 ? <span className="project-tab-count">{pausedProjects.length}</span> : null}
          </button>
          {menuOpen ? (
            <div
              className={`paused-projects-menu${alignPausedRight ? ' align-right' : ''}`}
              role="dialog"
              aria-label="Projets en pause"
            >
              {pausedProjects.length > 5 ? (
                <input
                  type="search"
                  className="paused-projects-search"
                  placeholder="Rechercher un projet en pause…"
                  aria-label="Rechercher un projet en pause"
                  value={pausedFilter}
                  autoFocus
                  onChange={(event) => setPausedFilter(event.target.value)}
                />
              ) : null}
              {filteredPaused.length === 0 ? (
                <p className="empty-hint paused-projects-empty">Aucun projet correspondant.</p>
              ) : (
                <ul className="paused-projects-list">
                  {filteredPaused.map((project) => {
                    const projectSessions = sessions.filter((session) => session.projectId === project.id);
                    const openTasks = (tasks ?? []).filter(
                      (task) => task.projectId === project.id && task.status !== 'done',
                    ).length;
                    const { total: alerts, waiting: questions } = attentionCounts(projectSessions);
                    const alertTone = questions > 0 ? 'waiting' : 'idle';
                    return (
                      <li key={project.id} className="paused-project-row">
                        <a
                          className="paused-project-link"
                          href={href(`#/p/${project.id}`)}
                          title={project.path}
                          onClick={() => setShowPaused(false)}
                        >
                          <span
                            className={`paused-project-dot${project.color ? '' : ' none'}`}
                            style={project.color ? { background: project.color } : undefined}
                            aria-hidden="true"
                          />
                          {alerts > 0 ? (
                            <span
                              className={`project-tab-alert ${alertTone}${alertTone === 'waiting' ? ' ask-mark' : ''}`}
                              aria-hidden="true"
                            >
                              {alertTone === 'waiting' ? '?' : null}
                            </span>
                          ) : null}
                          <span className="paused-project-info">
                            <span className="paused-project-name">{project.name}</span>
                            <span className="paused-project-meta">
                              {plural(openTasks, 'tâche')} · {plural(projectSessions.length, 'session')}
                            </span>
                          </span>
                        </a>
                        <button
                          type="button"
                          className="btn paused-project-resume"
                          disabled={saving}
                          title="Remettre ce projet dans les onglets actifs"
                          aria-label={`Reprendre ${project.name}`}
                          onClick={() => void resumeProject(project.id)}
                        >
                          <PlayGlyph />
                          Reprendre
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className="project-tab project-tab-add"
        title="Nouveau projet"
        aria-label="Nouveau projet"
        onDragOver={() => {
          setDropTarget(null);
          setPauseDrop(false);
        }}
        onClick={() => setShowNew(true)}
      >
        +
      </button>
      {contextMenu !== null && contextProject !== undefined ? (
        <div
          ref={contextMenuRef}
          className="project-tab-context-menu"
          role="menu"
          aria-label={`Actions pour ${contextProject.name}`}
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          {contextProject.paused ? (
            <button
              type="button"
              role="menuitem"
              className="project-tab-menu-item"
              disabled={saving}
              onClick={() => {
                setContextMenu(null);
                void resumeProject(contextProject.id);
              }}
            >
              <PlayGlyph />
              Reprendre le projet
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="project-tab-menu-item"
              disabled={saving}
              onClick={() => {
                setContextMenu(null);
                void pauseProject(contextProject.id);
              }}
            >
              <PauseGlyph />
              Mettre en pause
            </button>
          )}
        </div>
      ) : null}
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
  return (
    <Modal title="Nouveau projet" onClose={onClose}>
      <NewProjectForm className="new-project" submitLabel="Créer" autoFocus onCreated={onClose} onCancel={onClose} />
    </Modal>
  );
}
