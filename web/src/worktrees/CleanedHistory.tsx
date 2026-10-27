import { useState } from 'react';
import type { WorktreeInventory } from '../../../server/worktrees.ts';
import { DelayedActionButton } from '../DelayedActionButton.tsx';
import { sessionTitle } from '../format.ts';
import { href } from '../route.ts';
import { branchName, dateLabel } from './model.ts';

/** Copies already cleaned up: nothing to do, the entries can only be forgotten. */
export function CleanedHistory({
  cleaned,
  historyOnly,
  showProject,
  forget,
}: {
  cleaned: NonNullable<WorktreeInventory['cleaned']>;
  historyOnly: boolean;
  showProject: boolean;
  forget: (ids: string[]) => Promise<void>;
}) {
  const [historyBusy, setHistoryBusy] = useState<Set<string>>(() => new Set());
  const deleteHistory = async (ids: string[], actionKey: string): Promise<void> => {
    // Only disable the action being executed: disabling another delayed button cancels its timer.
    setHistoryBusy((current) => new Set(current).add(actionKey));
    try {
      await forget(ids);
    } finally {
      setHistoryBusy((current) => {
        const next = new Set(current);
        next.delete(actionKey);
        return next;
      });
    }
  };
  return (
    <details className={`worktrees-history${historyOnly ? ' worktrees-history-only' : ''}`}>
      <summary>Historique des copies nettoyées ({cleaned.length}) · Aucune action requise</summary>
      <p className="meta">
        Ces anciens dossiers de travail ont déjà été supprimés. Les branches Git et les conversations encore présentes
        sont conservées. Supprimer une entrée retire uniquement sa trace de cet historique.
      </p>
      <DelayedActionButton
        disabled={historyBusy.has('all')}
        title="Retire uniquement les entrées affichées de l’historique ; branches et conversations conservées."
        onAction={() =>
          void deleteHistory(
            cleaned.map((copy) => copy.id),
            'all',
          )
        }
      >
        Effacer {cleaned.length === 1 ? 'l’entrée affichée' : `les ${cleaned.length} entrées affichées`}
      </DelayedActionButton>
      <ul className="worktree-list">
        {cleaned.map((copy) => (
          <li className="worktree-cleaned-row" key={copy.id}>
            <div className="worktree-history-heading">
              <strong>
                {copy.session ? (
                  <a href={href(`#/s/${copy.session.id}`)}>{sessionTitle(copy.session.title)}</a>
                ) : (
                  sessionTitle(copy.sessionTitle ?? 'Conversation supprimée')
                )}
              </strong>
              <DelayedActionButton
                disabled={historyBusy.has(copy.id)}
                title={`Supprimer de l’historique : ${sessionTitle(copy.session?.title ?? copy.sessionTitle ?? 'Conversation supprimée')}. Branche et conversation conservées.`}
                onAction={() => void deleteHistory([copy.id], copy.id)}
              >
                Supprimer
              </DelayedActionButton>
            </div>
            {showProject ? <span className="meta"> · {copy.projectName}</span> : null}
            <p className="meta">Nettoyée le {dateLabel(copy.removedAt)}</p>
            <details className="worktree-history-details">
              <summary>Détails techniques</summary>
              <p className="meta">Branche conservée : {branchName(copy.branch)}</p>
              <p className="path">Ancien dossier supprimé : {copy.path}</p>
            </details>
          </li>
        ))}
      </ul>
    </details>
  );
}
