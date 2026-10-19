import type { SessionWorktree } from './types.ts';

/** Nom du dossier de la copie de travail isolée ; le chemin et la branche restent dans l'infobulle. */
export function WorktreeLabel({ worktree }: { worktree: SessionWorktree | null }) {
  if (worktree === null) return null;
  const branch = worktree.branch?.replace(/^refs\/heads\//, '');
  const title = [`Worktree : ${worktree.path}`, branch ? `Branche : ${branch}` : null, worktree.removed ? 'Copie retirée' : null]
    .filter(Boolean)
    .join('\n');
  return (
    <span className={`pill worktree-name${worktree.removed ? ' removed' : ''}`} title={title}>
      {worktree.name}
    </span>
  );
}
