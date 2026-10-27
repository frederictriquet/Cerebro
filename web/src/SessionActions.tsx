import { DelayedActionButton } from './DelayedActionButton.tsx';
import { SESSION_PROTECTED_HINT } from './SessionProtection.tsx';
import type { Session } from '../../shared/types.ts';
import { RELEASE_HINT, resumeBlockedReason } from './WorktreeLabel.tsx';

/** Arrêter, Reprendre et Supprimer une session : mêmes conditions dans la liste et dans la vue session. */
export function SessionActions({
  session,
  emphasizeResume = false,
  explainDelete = false,
  onKill,
  onResume,
  onDelete,
}: {
  session: Session;
  emphasizeResume?: boolean;
  // Infobulle de suppression détaillée, même pour une session sans copie isolée.
  explainDelete?: boolean;
  onKill: () => void;
  onResume: () => void;
  onDelete: () => void;
}) {
  const isolated = session.worktree !== null && !session.worktree.removed;
  const resumeBlocked = resumeBlockedReason(session.worktree);
  const deleteHint = !explainDelete
    ? undefined
    : isolated
      ? `Supprime la conversation. ${RELEASE_HINT} Sinon, elle reste dans l’inventaire des copies de travail.`
      : 'Supprime la conversation';
  return (
    <>
      {session.status !== 'exited' ? (
        <button
          type="button"
          className="btn"
          title={isolated ? `Arrête la conversation. ${RELEASE_HINT}` : undefined}
          onClick={onKill}
        >
          Arrêter
        </button>
      ) : null}
      {session.status === 'exited' && session.agentSessionId ? (
        <button
          type="button"
          className={emphasizeResume ? 'btn primary' : 'btn'}
          disabled={resumeBlocked !== null}
          title={resumeBlocked ?? undefined}
          onClick={onResume}
        >
          Reprendre
        </button>
      ) : null}
      <DelayedActionButton
        disabled={session.protected}
        title={session.protected ? SESSION_PROTECTED_HINT : deleteHint}
        onAction={onDelete}
      >
        Supprimer
      </DelayedActionButton>
    </>
  );
}
