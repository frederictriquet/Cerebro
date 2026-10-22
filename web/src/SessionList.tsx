import { useId, useState } from 'react';
import { EpicReviewActions, useEpicRun } from './EpicReviewActions.tsx';
import { FindingsLink } from './FindingsLink.tsx';
import { isAwaiting } from './format.ts';
import { href, parseMachine } from './route.ts';
import { SessionRow } from './SessionRow.tsx';
import { groupSessions, type SessionGroup } from './session-groups.ts';
import { useStore } from './store.tsx';
import type { Project, Session } from './types.ts';
import './session-groups.css';

export function SessionList({ sessions, now, showProject = false, onError }: {
  sessions: Session[];
  now: number;
  showProject?: boolean;
  onError: (message: string) => void;
}) {
  const { tasks, epics, projects } = useStore();
  return (
    <ul className="session-table">
      {groupSessions(sessions, tasks, epics).map((group) => group.kind === 'session' ? (
        <SessionRow key={group.session.id} session={group.session} now={now} onError={onError}
          project={showProject ? projects.find((project) => project.id === group.session.projectId) : undefined} />
      ) : (
        <EpicSessions key={JSON.stringify([group.projectId, group.epic.id])} group={group} now={now} onError={onError}
          project={showProject ? projects.find((project) => project.id === group.projectId) : undefined} />
      ))}
    </ul>
  );
}

function EpicSessions({ group, now, project, onError }: {
  group: Extract<SessionGroup, { kind: 'epic' }>;
  now: number;
  project?: Project;
  onError: (message: string) => void;
}) {
  const listId = useId();
  // Plus lent que dans le backlog : la liste peut afficher de nombreux epics, et la review n'a besoin que d'un état d'exécution à peu près à jour.
  const { run } = useEpicRun(group.epic.id, 5000);
  const [actionError, setActionError] = useState<string | null>(null);
  const storageKey = `cerebro.sessionEpic.${JSON.stringify([parseMachine(window.location.hash), group.projectId, group.epic.id])}`;
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) return saved !== 'closed';
    } catch { /* Le repli reste disponible sans stockage local. */ }
    return group.sessions.some((session) => session.status !== 'exited' || isAwaiting(session) || session.pendingFindings > 0);
  });
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(storageKey, next ? 'open' : 'closed'); } catch { /* mode privé / quota */ }
  };
  const attention = group.sessions.filter(session => isAwaiting(session) || session.pendingFindings > 0).length;
  const pendingFindings = group.sessions.reduce((total, session) => total + session.pendingFindings, 0);
  const nextReview = group.sessions.find(session => session.pendingFindings > 0);
  const running = group.sessions.filter((session) => session.status === 'starting' || session.status === 'running').length;
  return (
    <li className={`session-epic${attention ? ' has-attention' : ''}`}>
      <div className="session-epic-head">
        <button type="button" className="session-epic-toggle" aria-expanded={open} aria-controls={listId}
          aria-label={`${open ? 'Replier' : 'Déplier'} les sessions de l’epic ${group.epic.title}`} onClick={toggle}>
          <span className="session-epic-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="session-epic-heading">
            <span className="session-epic-title"><span className="epic-badge">Epic</span><span>{group.epic.title}</span></span>
            <span className="session-epic-summary">
              <span>{group.sessions.length} session{group.sessions.length > 1 ? 's' : ''}</span>
              {running > 0 ? <span className="pill status running">{running} en cours</span> : null}
              {attention > 0 ? <span className="pill status waiting">{attention} à traiter</span> : null}
            </span>
          </span>
        </button>
        <div className="session-epic-actions">
          {nextReview ? <FindingsLink sessionId={nextReview.id} count={pendingFindings} /> : null}
          <EpicReviewActions epic={{ id: group.epic.id, projectId: group.projectId, title: group.epic.title }} run={run} onError={setActionError} />
        </div>
        {project ? <a className="meta project-jump" href={href(`#/p/${project.id}`)}>{project.name}</a> : null}
      </div>
      {actionError ? <p className="form-error session-epic-error" role="alert">{actionError}</p> : null}
      <ul id={listId} className="session-epic-children" hidden={!open}>
        {open ? group.sessions.map((session) => <SessionRow key={session.id} session={session} now={now} grouped onError={onError} />) : null}
      </ul>
    </li>
  );
}
