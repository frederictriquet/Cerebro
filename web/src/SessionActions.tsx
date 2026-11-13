import { DelayedActionButton } from './DelayedActionButton.tsx';
import { ResumeIcon, StopIcon, TrashIcon } from './SessionIcons.tsx';
import { SESSION_PROTECTED_HINT } from './SessionProtection.tsx';
import type { Session } from '../../shared/types.ts';
import { RELEASE_HINT, removedCopyNotice } from './WorktreeLabel.tsx';

/** Arrêter, Reprendre et Supprimer une session : mêmes conditions dans la liste et dans la vue session. */
export function SessionActions({
  session,
  emphasizeResume = false,
  explainDelete = false,
  icons = false,
  onKill,
  onResume,
  onDelete,
}: {
  session: Session;
  emphasizeResume?: boolean;
  // Infobulle de suppression détaillée, même pour une session sans copie isolée.
  explainDelete?: boolean;
  // Pictos de l'en-tête de session (à côté de l'épingle et du cadenas) au lieu des boutons à libellé.
  icons?: boolean;
  onKill: () => void;
  onResume: () => void;
  onDelete: () => void;
}) {
  const isolated = session.worktree !== null && !session.worktree.removed;
  const deleteHint = !explainDelete
    ? undefined
    : isolated
      ? `Supprime la conversation. ${RELEASE_HINT} Sinon, elle reste dans l’inventaire des copies de travail.`
      : 'Supprime la conversation';
  const killTitle = isolated ? `Arrête la conversation. ${RELEASE_HINT}` : undefined;
  const resumeTitle = removedCopyNotice(session.worktree) ?? undefined;
  const canResume = session.status === 'exited' && session.agentSessionId;
  return (
    <>
      {session.status !== 'exited' ? (
        icons ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="Arrêter"
            title={killTitle ? `Arrêter. ${killTitle}` : 'Arrêter la conversation'}
            onClick={onKill}
          >
            <StopIcon />
          </button>
        ) : (
          <button type="button" className="btn" title={killTitle} onClick={onKill}>
            Arrêter
          </button>
        )
      ) : null}
      {canResume ? (
        icons ? (
          <button
            type="button"
            className={emphasizeResume ? 'icon-btn active' : 'icon-btn'}
            aria-label="Reprendre"
            title={resumeTitle ? `Reprendre. ${resumeTitle}` : 'Reprendre la conversation'}
            onClick={onResume}
          >
            <ResumeIcon />
          </button>
        ) : (
          <button
            type="button"
            className={emphasizeResume ? 'btn primary' : 'btn'}
            title={resumeTitle}
            onClick={onResume}
          >
            Reprendre
          </button>
        )
      ) : null}
      {/* Clé : changer de session pendant un délai de suppression ne reporte pas le compte à rebours
          sur la nouvelle ; la suppression demandée part quand même à l'échéance. */}
      <DelayedActionButton
        key={session.id}
        className={icons ? 'icon-btn danger' : undefined}
        iconLabel={icons ? 'Supprimer' : undefined}
        disabled={session.protected}
        title={
          session.protected ? SESSION_PROTECTED_HINT : (deleteHint ?? (icons ? 'Supprimer la conversation' : undefined))
        }
        onAction={onDelete}
      >
        {icons ? <TrashIcon /> : 'Supprimer'}
      </DelayedActionButton>
    </>
  );
}
