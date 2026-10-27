import type { WorktreeView } from '../../../shared/worktrees.ts';
import { branchName } from './model.ts';
import { WorktreeDiffs } from './WorktreeDiffs.tsx';

/** The project's main folder and the Git copies Cerebro cannot attribute to a conversation. */
export function OtherWorktrees({
  other,
  showProject,
  onCommit,
}: {
  other: WorktreeView[];
  showProject: boolean;
  onCommit: (view: WorktreeView) => void;
}) {
  return (
    <details className="worktrees-other">
      <summary>Dossier principal et autres copies Git ({other.length})</summary>
      <p className="meta">
        Le dossier principal se traite avec « Commit / push du projet ». Les copies non associées restent visibles ici
        pour retrouver leur contenu.
      </p>
      {other.map((view) => (
        <details className="worktree-other" key={view.id}>
          <summary>
            {view.primary ? 'Dossier principal du projet' : 'Copie sans conversation identifiée'}
            {showProject ? ` · ${view.projectName}` : ''} · {view.dirty ?? '?'} fichier(s) modifié(s)
          </summary>
          <p className="path">{view.path}</p>
          <p className="meta">Branche : {branchName(view.branch ?? view.expectedBranch)}</p>
          <p>
            {view.primary
              ? 'C’est le dossier utilisé par le projet et les conversations historiques. Il n’a pas à être intégré dans lui-même.'
              : 'Les données de création de cette copie ne sont pas disponibles. Cerebro ne peut ni attribuer son contenu à une conversation, ni la retirer automatiquement.'}
          </p>
          {view.error ? <p className="form-error">{view.error}</p> : null}
          {!view.primary ? <WorktreeDiffs view={view} /> : null}
          {view.primary && view.projectExists && view.projectId ? (
            <button type="button" className="btn" onClick={() => onCommit(view)}>
              Commit / push du projet
            </button>
          ) : null}
        </details>
      ))}
    </details>
  );
}
