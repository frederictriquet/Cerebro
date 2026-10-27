import { useId, useMemo, useState } from 'react';
import { EpicReviewActions } from './EpicReviewActions.tsx';
import { useEpicRun } from './epic-runs.ts';
import { FindingsLink } from './FindingsLink.tsx';
import { attentionCounts, isAwaiting, plural } from './format.ts';
import { href, parseMachine } from './route.ts';
import { SessionRow } from './SessionRow.tsx';
import { useStoredFlag } from './storage.ts';
import { groupSessions, type SessionGroup } from './session-groups.ts';
import { useStore } from './store.tsx';
import { SessionListContext, useSessionList } from './session-list-context.ts';
import type { Session } from '../../shared/types.ts';
import './session-groups.css';

export function SessionList({
  sessions,
  now,
  showProject = false,
  onError,
}: {
  sessions: Session[];
  now: number;
  showProject?: boolean;
  onError: (message: string) => void;
}) {
  const { tasks, epics } = useStore();
  const scope = useMemo(() => ({ now, showProject, onError }), [now, showProject, onError]);
  return (
    <SessionListContext.Provider value={scope}>
      <ul className="session-table">
        {groupSessions(sessions, tasks, epics).map((group) =>
          group.kind === 'session' ? (
            <SessionRow key={group.session.id} session={group.session} />
          ) : (
            <EpicSessions key={JSON.stringify([group.projectId, group.epic.id])} group={group} />
          ),
        )}
      </ul>
    </SessionListContext.Provider>
  );
}

function EpicSessions({ group }: { group: Extract<SessionGroup, { kind: 'epic' }> }) {
  const { projects } = useStore();
  const { showProject } = useSessionList();
  const project = showProject ? projects.find((item) => item.id === group.projectId) : undefined;
  const listId = useId();
  // Suivi par les événements epic-run, comme dans le backlog.
  const { run } = useEpicRun(group.epic.id);
  const [actionError, setActionError] = useState<string | null>(null);
  const storageKey = `cerebro.sessionEpic.${JSON.stringify([parseMachine(window.location.hash), group.projectId, group.epic.id])}`;
  const [open, setOpen] = useStoredFlag(
    storageKey,
    () =>
      group.sessions.some(
        (session) => session.status !== 'exited' || isAwaiting(session) || session.pendingFindings > 0,
      ),
    ['open', 'closed'],
  );
  const toggle = (): void => setOpen(!open);
  const { total: attention, waiting, pendingFindings } = attentionCounts(group.sessions);
  // Tours terminés pas encore ouverts : comptés « à traiter » comme partout, mais sans rien à répondre.
  const unread = group.sessions.filter((session) => session.attention && session.status !== 'waiting').length;
  const nextReview = group.sessions.find((session) => session.pendingFindings > 0);
  const running = group.sessions.filter(
    (session) => session.status === 'starting' || session.status === 'running',
  ).length;
  return (
    <li className={`session-epic${attention ? ' has-attention' : ''}`}>
      <div className="session-epic-head">
        <button
          type="button"
          className="session-epic-toggle"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`${open ? 'Replier' : 'Déplier'} les sessions de l’epic ${group.epic.title}`}
          onClick={toggle}
        >
          <span className="session-epic-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="session-epic-heading">
            <span className="session-epic-title">
              <span className="epic-badge">Epic</span>
              <span>{group.epic.title}</span>
            </span>
            <span className="session-epic-summary">
              <span>{plural(group.sessions.length, 'session')}</span>
              {running > 0 ? <span className="pill status running">{running} en cours</span> : null}
              {waiting > 0 ? <span className="pill status waiting">{plural(waiting, 'question')}</span> : null}
              {unread > 0 ? (
                <span className="pill status idle" title="Tour terminé depuis la dernière ouverture de la session">
                  {plural(unread, 'tour non lu', 'tours non lus')}
                </span>
              ) : null}
            </span>
          </span>
        </button>
        <div className="session-epic-actions">
          {nextReview ? <FindingsLink sessionId={nextReview.id} count={pendingFindings} /> : null}
          <EpicReviewActions
            epic={{ id: group.epic.id, projectId: group.projectId, title: group.epic.title }}
            run={run}
            onError={setActionError}
          />
        </div>
        {project ? (
          <a className="meta project-jump" href={href(`#/p/${project.id}`)}>
            {project.name}
          </a>
        ) : null}
      </div>
      {actionError ? (
        <p className="form-error session-epic-error" role="alert">
          {actionError}
        </p>
      ) : null}
      <ul id={listId} className="session-epic-children" hidden={!open}>
        {open ? group.sessions.map((session) => <SessionRow key={session.id} session={session} grouped />) : null}
      </ul>
    </li>
  );
}
