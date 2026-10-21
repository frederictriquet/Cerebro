import { useRef } from 'react';
import { AgentLabel } from './AgentLabel.tsx';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import { SessionProtection, SESSION_PROTECTED_HINT } from './SessionProtection.tsx';
import { displayStatus, isAwaiting, relativeTime, sessionTitle, STATUS_LABEL } from './format.ts';
import { go, href } from './route.ts';
import { PreviewButton, ScreenPopover, usePreviewController } from './ScreenPreview.tsx';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import type { Project, Session } from './types.ts';
import { RELEASE_HINT, WorktreeLabel, resumeBlockedReason } from './WorktreeLabel.tsx';

export function SessionRow({
  session,
  now,
  project,
  onError,
}: {
  session: Session;
  now: number;
  project?: Pick<Project, 'id' | 'name'>;
  onError: (message: string) => void;
}) {
  const { killSession, resumeSession, deleteSession, sendSessionInput } = useStore();
  const reportError = (fallback: string) => (err: unknown): void => {
    onError(err instanceof Error ? err.message : fallback);
  };
  const onKill = (): void => {
    void killSession(session.id).catch(reportError('Arrêt impossible'));
  };
  const onResume = (): void => {
    void resumeSession(session.id).then((live) => go(`#/s/${live.id}`)).catch(reportError('Reprise impossible'));
  };
  const onDelete = (): void => {
    void deleteSession(session.id).catch(reportError('Suppression impossible'));
  };
  const onInput = (data: string): void => {
    void sendSessionInput(session.id, data).catch(reportError('Envoi impossible'));
  };
  const awaiting = isAwaiting(session);
  const preview = usePreviewController();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tone = session.status === 'waiting' ? 'waiting' : 'idle';
  const shown = displayStatus(session, now);
  const resumeBlocked = resumeBlockedReason(session.worktree);

  return (
    <li className="session-row">
      <div className="session-row-main">
        <a href={href(`#/s/${session.id}`)} className="session-main">
          <span className="session-row-titleline">
            <StatusDot status={shown} title={STATUS_LABEL[shown]} />
            <span className="session-row-title">{sessionTitle(session.title)}</span>
          </span>
          <span className="session-row-meta">
            <span className="pill"><AgentLabel agent={session.agent} /></span>
            <span className={`pill status ${shown}`}>{STATUS_LABEL[shown]}</span>
            <WorktreeLabel worktree={session.worktree} />
            <span className="meta">{relativeTime(session.updatedAt, now)}</span>
          </span>
        </a>
        {awaiting && session.attentionReason ? (
          <p className={`reason-line ${tone}`}>{session.attentionReason}</p>
        ) : null}
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
            <PreviewButton pressed={preview.open} onToggle={preview.toggle} anchorRef={anchorRef} />
          </>
        ) : null}
        {session.status !== 'exited' ? (
          <button type="button" className="btn" title={session.worktree !== null && !session.worktree.removed ? `Arrête la conversation. ${RELEASE_HINT}` : undefined} onClick={onKill}>
            Arrêter
          </button>
        ) : null}
        {session.status === 'exited' && session.agentSessionId ? (
          <button type="button" className="btn" disabled={resumeBlocked !== null} title={resumeBlocked ?? undefined} onClick={onResume}>
            Reprendre
          </button>
        ) : null}
        <DelayedActionButton disabled={session.protected} title={session.protected ? SESSION_PROTECTED_HINT : undefined} onAction={onDelete}>Supprimer</DelayedActionButton>
      </div>
      {awaiting && preview.open ? <ScreenPopover sessionId={session.id} anchorRef={anchorRef} /> : null}
    </li>
  );
}
