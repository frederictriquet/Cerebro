import { formatDateTime } from './format.ts';
import type { SessionWorktree } from '../../shared/types.ts';

/** Arrêter ou supprimer une conversation peut retirer sa copie : la reprise devient alors impossible. */
export const RELEASE_HINT = 'Si sa copie de travail ne contient rien à conserver (aucun changement, commits intégrés, aucun fichier ignoré), elle sera nettoyée automatiquement ; la conversation restera consultable mais ne pourra plus être reprise.';

/** Pourquoi une conversation terminée ne peut plus reprendre, ou null si sa copie existe encore. */
export function resumeBlockedReason(worktree: SessionWorktree | null): string | null {
  if (worktree === null || !worktree.removed) return null;
  const when = worktree.removedAt !== null ? ` le ${formatDateTime(worktree.removedAt)}` : '';
  return worktree.removedAutomatically
    ? `Copie de travail nettoyée automatiquement${when}, à la fin de la conversation : elle ne contenait rien à conserver. L’historique reste consultable, mais la conversation ne peut plus être reprise ; elle n’est pas redirigée vers le dossier du projet. Sa branche est conservée.`
    : `Copie de travail retirée${when}. L’historique reste consultable, mais la conversation ne peut plus être reprise dans cette copie. Sa branche est conservée.`;
}

/** Nom du dossier de la copie de travail isolée ; le chemin et la branche restent dans l'infobulle. */
export function WorktreeLabel({ worktree }: { worktree: SessionWorktree | null }) {
  if (worktree === null) return null;
  const branch = worktree.branch?.replace(/^refs\/heads\//, '');
  const title = [`Worktree : ${worktree.path}`, branch ? `Branche : ${branch}` : null, resumeBlockedReason(worktree)]
    .filter(Boolean)
    .join('\n');
  return (
    <>
      <span className={`pill worktree-name${worktree.removed ? ' removed' : ''}`} title={title}>
        {worktree.name}
      </span>
      {/* Hors de la pastille du nom, que l'ellipse tronquerait. */}
      {worktree.removed && worktree.removedAutomatically ? <span className="pill worktree-cleaned" title={title}>copie nettoyée</span> : null}
    </>
  );
}
