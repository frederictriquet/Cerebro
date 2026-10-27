import type { WorktreeView } from '../../../shared/worktrees.ts';
import { ActivityStatus } from '../ActivityStatus.tsx';
import { plural } from '../format.ts';
import { href } from '../route.ts';
import { type Journey, type WorktreeActions } from './model.ts';
import { Step } from './Step.tsx';

/** Step 2: bring the target's new commits into the copy, so conflicts are settled there. */
export function UpdateStep({
  view,
  plan,
  target,
  disabled,
  commitBlocked,
  actions,
}: {
  view: WorktreeView;
  plan: Journey;
  target: string;
  disabled: boolean;
  commitBlocked: boolean;
  actions: WorktreeActions;
}) {
  return (
    <Step number={2} title={`Régler les conflits avec ${target}`} state={plan.update}>
      {view.mergeInProgress ? (
        <>
          {view.conflicts.length ? (
            <>
              <p>
                Mise à jour en cours : {view.conflicts.length === 1 ? 'ce fichier est' : 'ces fichiers sont'} en conflit
                dans la copie.
              </p>
              <ul className="worktree-files">
                {view.conflicts.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
              <p className="meta">
                Résolvez-les dans le dossier de la copie, vous-même ou en le demandant à la conversation
                {view.session ? (
                  <>
                    {' '}
                    (<a href={href(`#/s/${view.session.id}`)}>ouvrir la conversation</a>)
                  </>
                ) : null}
                , puis terminez la mise à jour.
              </p>
            </>
          ) : (
            <p>Les conflits sont résolus : terminez la mise à jour pour créer le commit de merge.</p>
          )}
          <div className="row-actions">
            <button
              type="button"
              className="btn primary"
              disabled={disabled}
              onClick={() => void actions.act(view, 'update-from-target/finish')}
            >
              Terminer la mise à jour
            </button>
            <button
              type="button"
              className="btn danger-ghost"
              disabled={disabled}
              onClick={() => void actions.act(view, 'update-from-target/abort')}
            >
              Annuler la mise à jour
            </button>
          </div>
        </>
      ) : !view.ahead ? (
        <p>
          {view.integration === 'integrated'
            ? 'Rien à régler : tout le travail commité est déjà dans la cible.'
            : 'Rien à intégrer pour l’instant.'}
        </p>
      ) : !view.behind ? (
        <p>La copie contient déjà tous les commits de {target} : aucun conflit possible.</p>
      ) : view.integrationConflicts === null ? (
        <p>
          <ActivityStatus active>Recherche des conflits avec {target}…</ActivityStatus>
        </p>
      ) : view.integrationConflicts.length === 0 ? (
        <p>
          Aucun conflit prévu avec {target}, qui a reçu {plural(view.behind, 'commit')} depuis la création de la copie.
        </p>
      ) : (
        <>
          <p>
            Les commits de la copie et ceux de {target} modifient les mêmes lignes de{' '}
            {plural(view.integrationConflicts.length, 'fichier')} :
          </p>
          <ul className="worktree-files">
            {view.integrationConflicts.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
          <p className="meta">
            Mettez d’abord la copie à jour avec {target} : les conflits se résolvent alors dans la copie, sans toucher
            au dossier du projet.
          </p>
          {view.dirty ? (
            <p className="worktree-warning">Terminez d’abord l’étape 1 : la copie doit être entièrement commitée.</p>
          ) : null}
          <button
            type="button"
            className="btn primary"
            disabled={commitBlocked || !!view.dirty}
            onClick={() => void actions.act(view, 'update-from-target')}
          >
            Mettre à jour avec {target}
          </button>
        </>
      )}
      {!view.mergeInProgress && view.integrationConflicts && view.integrationNote ? (
        <p className="meta">{view.integrationNote}</p>
      ) : null}
    </Step>
  );
}
