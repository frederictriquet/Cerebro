import { SessionActions } from './SessionActions.tsx';
import { attentionTone, SessionAttention, SessionMeta } from './SessionMeta.tsx';
import { SessionProtection } from './SessionProtection.tsx';
import { displayStatus, errorMessage, isAwaiting, relativeTime, sessionTitle, STATUS_LABEL } from './format.ts';
import { go, href } from './route.ts';
import { useSessionPreview } from './ScreenPreview.tsx';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import { groupedSessionTitle } from './session-groups.ts';
import { useSessionList } from './session-list-context.ts';
import type { Session } from '../../shared/types.ts';

// Une session regroupée sous son epic n'affiche pas son projet : l'en-tête du groupe le porte.
export function SessionRow({ session, grouped = false }: { session: Session; grouped?: boolean }) {
  const { projects, killSession, resumeSession, deleteSession, sendSessionInput, markSeen } = useStore();
  const { now, showProject, onError } = useSessionList();
  const project = showProject && !grouped ? projects.find((item) => item.id === session.projectId) : undefined;
  const reportError =
    (fallback: string) =>
    (err: unknown): void => {
      onError(errorMessage(err, fallback));
    };
  const onKill = (): void => {
    void killSession(session.id).catch(reportError('Arrêt impossible'));
  };
  const onResume = (): void => {
    void resumeSession(session.id)
      .then((live) => go(`#/s/${live.id}`))
      .catch(reportError('Reprise impossible'));
  };
  const onDelete = (): void => {
    void deleteSession(session.id).catch(reportError('Suppression impossible'));
  };
  const onInput = (data: string): void => {
    void sendSessionInput(session.id, data).catch(reportError('Envoi impossible'));
  };
  const awaiting = isAwaiting(session);
  const preview = useSessionPreview(session.id);
  const shown = displayStatus(session, now);
  const rowClass = [
    'session-row',
    session.pendingFindings > 0 ? 'has-findings' : '',
    session.attention ? `has-attention ${attentionTone(session)}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li className={rowClass}>
      <div className="session-row-main">
        <a href={href(`#/s/${session.id}`)} className="session-main">
          <span className="session-row-titleline">
            <StatusDot status={shown} title={STATUS_LABEL[shown]} />
            <span className="session-row-title">
              {grouped ? groupedSessionTitle(session) : sessionTitle(session.title)}
            </span>
          </span>
          <span className="session-row-meta">
            <SessionMeta session={session} status={shown}>
              <span className="meta">{relativeTime(session.updatedAt, now)}</span>
            </SessionMeta>
          </span>
        </a>
        <SessionAttention session={session} showReason={awaiting} />
      </div>
      <SessionProtection session={session} onError={onError} />
      <div className="row-actions">
        {project ? (
          <a className="meta project-jump" href={href(`#/p/${project.id}`)}>
            {project.name}
          </a>
        ) : null}
        {awaiting ? (
          <>
            {session.status !== 'exited' ? (
              <>
                <button type="button" className="btn" onClick={() => onInput('\r')}>
                  Entrée
                </button>
                <button type="button" className="btn" onClick={() => onInput('\x1b')}>
                  Échap
                </button>
              </>
            ) : null}
            <a className="btn" href={href(`#/s/${session.id}`)}>
              Ouvrir
            </a>
            {session.attention ? (
              <button
                type="button"
                className="btn"
                title="Acquitter sans ouvrir"
                onClick={() => void markSeen(session.id)}
              >
                Vu
              </button>
            ) : null}
            {preview.button}
          </>
        ) : null}
        <SessionActions session={session} onKill={onKill} onResume={onResume} onDelete={onDelete} />
      </div>
      {awaiting ? preview.popover : null}
    </li>
  );
}
