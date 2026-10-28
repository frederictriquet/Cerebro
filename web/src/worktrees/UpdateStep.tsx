import { useState } from 'react';
import { parseSession } from '../../../shared/types.ts';
import type { WorktreeView } from '../../../shared/worktrees.ts';
import { ActivityStatus } from '../ActivityStatus.tsx';
import { ApiError, apiParsed } from '../api.ts';
import { useAsyncAction } from '../async-action.ts';
import { plural, sessionTitle, STATUS_LABEL } from '../format.ts';
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
  // Files already staged with markers left in them are no longer in conflict, but would be committed as they are.
  const files = [...view.conflicts, ...view.remainingMarkers.filter((file) => !view.conflicts.includes(file))];
  return (
    <Step number={2} title={`Régler les conflits avec ${target}`} state={plan.update}>
      {view.mergeInProgress ? (
        <>
          {files.length ? (
            <>
              <p>
                Mise à jour en cours : {files.length === 1 ? 'ce fichier est' : 'ces fichiers sont'} en conflit dans la
                copie.
              </p>
              <ul className="worktree-files">
                {files.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                    {view.remainingMarkers.includes(file) ? (
                      <span className="pill marked">marqueurs restants</span>
                    ) : (
                      <span className="pill resolved">résolu</span>
                    )}
                  </li>
                ))}
              </ul>
              {!view.resolver ? (
                <p className="meta">
                  Résolvez-les dans le dossier de la copie, vous-même, en le demandant à la conversation
                  {view.session ? (
                    <>
                      {' '}
                      (<a href={href(`#/s/${view.session.id}`)}>ouvrir la conversation</a>)
                    </>
                  ) : null}{' '}
                  ou avec une session de résolution, puis terminez la mise à jour.
                </p>
              ) : null}
            </>
          ) : (
            <p>Les conflits sont résolus : terminez la mise à jour pour créer le commit de merge.</p>
          )}
          <ConflictResolution view={view} disabled={disabled} actions={actions} />
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

/** The session resolving the conflicts of the merge in progress, or the button launching it; finishing stays manual. */
function ConflictResolution({
  view,
  disabled,
  actions,
}: {
  view: WorktreeView;
  disabled: boolean;
  actions: WorktreeActions;
}) {
  // Session named by the server when it refuses a second resolver for the same merge.
  const [existing, setExisting] = useState<string | null>(null);
  const launch = useAsyncAction(async () => {
    setExisting(null);
    try {
      await apiParsed(`/api/worktrees/${view.id}/resolve-conflicts`, parseSession, { method: 'POST' });
    } catch (cause) {
      const body = cause instanceof ApiError && cause.status === 409 ? cause.body : null;
      if (typeof body === 'object' && body !== null && 'sessionId' in body && typeof body.sessionId === 'string')
        setExisting(body.sessionId);
      throw cause;
    }
    actions.resolving(view);
  });
  const resolver = view.resolver;
  const marked = view.remainingMarkers.length;
  const status = Object.entries(STATUS_LABEL).find(([key]) => key === resolver?.status)?.[1] ?? resolver?.status;
  // A finished session no longer holds the merge: another one can take over.
  const launchable = view.conflicts.length > 0 && (!resolver || resolver.status === 'exited');
  return (
    <>
      {resolver ? (
        <p className="worktree-notice" role="status">
          Session de résolution : <a href={href(`#/s/${resolver.sessionId}`)}>{sessionTitle(resolver.title)}</a> (
          {status?.toLowerCase()}).{' '}
          {resolver.status === 'waiting'
            ? 'Elle attend une réponse : ouvrez la session.'
            : resolver.status !== 'idle' && resolver.status !== 'exited'
              ? 'En cours : attendez la fin de son tour avant de terminer la mise à jour.'
              : !marked
                ? 'Tous les conflits sont résolus : relisez puis terminez la mise à jour.'
                : `Il reste des marqueurs dans ${plural(marked, 'fichier')} : ouvrez la session pour l’aider, ou terminez-les vous-même.`}
        </p>
      ) : null}
      {launchable ? (
        <>
          <p className="meta">
            Une session reçoit les fichiers en conflit, les commits des deux côtés et l’intention de la conversation ;
            elle ne commite rien.
          </p>
          <div className="row-actions">
            <button type="button" className="btn" disabled={disabled || launch.busy} onClick={() => void launch.run()}>
              <ActivityStatus active={launch.busy}>
                {launch.busy ? 'Lancement de la session…' : 'Résoudre avec l’IA'}
              </ActivityStatus>
            </button>
          </div>
        </>
      ) : null}
      {launch.error ? (
        <p className="form-error" role="alert">
          {launch.error}
          {existing ? (
            <>
              {' '}
              <a href={href(`#/s/${existing}`)}>Ouvrir cette session</a>
            </>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
