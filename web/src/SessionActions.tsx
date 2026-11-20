import { DelayedActionButton } from './DelayedActionButton.tsx';
import { ResumeIcon, StopIcon, TrashIcon } from './SessionIcons.tsx';
import { SESSION_PROTECTED_HINT } from './SessionProtection.tsx';
import { plural } from './format.ts';
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
  // Même refus que le serveur : rien à supprimer tant qu'une sous-tâche reste à faire, en cours ou bloquée.
  const deleteBlocked = session.protected
    ? SESSION_PROTECTED_HINT
    : session.openSubtasks > 0
      ? openSubtasksHint(session.openSubtasks)
      : null;
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
        disabled={deleteBlocked !== null}
        title={deleteBlocked ?? deleteHint ?? (icons ? 'Supprimer la conversation' : undefined)}
        onAction={onDelete}
      >
        {icons ? <TrashIcon /> : 'Supprimer'}
      </DelayedActionButton>
    </>
  );
}

export function openSubtasksHint(count: number): string {
  return `${plural(count, 'sous-tâche non terminée', 'sous-tâches non terminées')}. Passez-${count > 1 ? 'les' : 'la'} à « Terminée » ou « Annulée » avant de supprimer la session.`;
}
