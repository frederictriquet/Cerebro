import type { ReactNode } from 'react';
import { AgentLabel } from './AgentLabel.tsx';
import { FindingsLink } from './FindingsLink.tsx';
import { STATUS_LABEL, type DisplayStatus } from './format.ts';
import type { Session } from '../../shared/types.ts';
import { WorktreeLabel } from './WorktreeLabel.tsx';

/** Ton d'une session qui demande l'attention : question en attente ou simple inactivité. */
export function attentionTone(session: Session): 'waiting' | 'idle' {
  return session.status === 'waiting' ? 'waiting' : 'idle';
}

/** Pastilles agent, statut et copie de travail ; les emplacements gardent l'ordre propre à chaque vue. */
export function SessionMeta({
  session,
  status,
  beforeStatus,
  afterStatus,
  children,
}: {
  session: Session;
  status: DisplayStatus;
  beforeStatus?: ReactNode;
  afterStatus?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <span className="pill">
        <AgentLabel agent={session.agent} />
      </span>
      {beforeStatus}
      <span className={`pill status ${status}`}>{STATUS_LABEL[status]}</span>
      {afterStatus}
      <WorktreeLabel worktree={session.worktree} />
      {children}
    </>
  );
}

/** Lien vers les findings à traiter et raison de l'attention. */
export function SessionAttention({
  session,
  showReason = true,
  onNavigate,
}: {
  session: Session;
  showReason?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <>
      <FindingsLink sessionId={session.id} count={session.pendingFindings} onNavigate={onNavigate} />
      {showReason && session.attentionReason ? (
        <p className={`reason-line ${attentionTone(session)}`}>{session.attentionReason}</p>
      ) : null}
    </>
  );
}
