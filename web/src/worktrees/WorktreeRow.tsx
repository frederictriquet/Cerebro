import type { StartingContentDiscard, WorktreeView } from '../../../shared/worktrees.ts';
import { formatDateTime, plural } from '../format.ts';
import { href } from '../route.ts';
import { IntegrateStep } from './IntegrateStep.tsx';
import {
  branchName,
  copyTitle,
  createdLabel,
  finished,
  journey,
  removalBlockers,
  startingContentGroups,
  type Resolver,
  type WorktreeActions,
} from './model.ts';
import { SaveStep } from './SaveStep.tsx';
import { Step } from './Step.tsx';
import { UpdateStep } from './UpdateStep.tsx';

/** One conversation copy: its status and next action, then the detailed steps towards the project. */
export function WorktreeRow({
  view,
  showProject,
  locked,
  showDetails,
  result,
  resolver,
  actions,
}: {
  view: WorktreeView;
  showProject: boolean;
  /** Another Git action of the panel is running. */
  locked: boolean;
  showDetails: boolean;
  result: StartingContentDiscard | undefined;
  resolver: Resolver | undefined;
  actions: WorktreeActions;
}) {
  const operationBusy = view.operation?.status === 'running';
  const disabled = locked || operationBusy;
  const changes = view.changesSinceCreation;
  const plan = journey(view);
  const target = branchName(view.targetBranch);
  const commitBlocked =
    disabled ||
    !!view.error ||
    view.mergeInProgress ||
    view.activeSessions.some((session) => session.status !== 'idle');
  const { removable } = startingContentGroups(plan);
  const removeBlocked = removalBlockers(view);
  // Ignored files to keep do not block: the confirmation lists them for an explicit deletion.
  const remove = (
    <button
      type="button"
      className="btn danger-ghost"
      disabled={disabled || removeBlocked.length > 0}
      title={
        removeBlocked.join('\n') ||
        (view.ignored ? `${view.ignored} fichier(s) ignoré(s) à confirmer avant suppression` : 'Retirer la copie')
      }
      onClick={() => void actions.prepare(view, 'remove', !!view.ignored)}
    >
      Retirer la copie
    </button>
  );
  const startDiscard = (): void => actions.discard(view);
  const integrateTitle =
    view.mergeBlockers.join('\n') ||
    (view.integrationConflicts?.length
      ? `Conflits prévus : ${view.integrationConflicts.join(', ')}`
      : `Intégrer dans ${target}`);
  // The next action, also offered in the overview so the usual path needs no expansion.
  const primary = view.error ? null : view.mergeInProgress ? (
    <button type="button" className="btn primary" onClick={() => actions.open(view.id)}>
      Résoudre les conflits
    </button>
  ) : view.dirty && removable ? (
    <button type="button" className="btn primary" disabled={commitBlocked} onClick={startDiscard}>
      Retirer le contenu de départ
    </button>
  ) : view.dirty && plan.ownWork ? (
    <button type="button" className="btn primary" disabled={commitBlocked} onClick={() => actions.commit(view)}>
      Créer le commit
    </button>
  ) : view.dirty && changes?.count !== 0 ? (
    <button type="button" className="btn primary" onClick={() => actions.open(view.id)}>
      Examiner
    </button>
  ) : view.ahead && view.integrationConflicts?.length ? (
    <button
      type="button"
      className="btn primary"
      disabled={commitBlocked}
      onClick={() => void actions.act(view, 'update-from-target')}
    >
      Mettre à jour avec {target}
    </button>
  ) : view.ahead ? (
    <button
      type="button"
      className={`btn ${view.mergeBlockers.length ? '' : 'primary'}`}
      disabled={disabled || view.mergeBlockers.length > 0}
      title={integrateTitle}
      onClick={() => void actions.prepare(view, 'merge')}
    >
      Intégrer dans {target}
    </button>
  ) : finished(view) ? (
    remove
  ) : null;
  return (
    <li className="worktree-row">
      <div className="worktree-overview">
        <div className="worktree-identity">
          <div className="worktree-title">
            <strong title={copyTitle(view)}>
              {view.session ? <a href={href(`#/s/${view.session.id}`)}>{copyTitle(view)}</a> : copyTitle(view)}
            </strong>
            <span
              className={`pill ${plan.status !== 'Intégré au projet' && plan.status !== 'Publié' && plan.status !== 'Copie de départ' ? 'worktree-pending' : ''}`}
            >
              {plan.status}
            </span>
          </div>
          <div className="worktree-meta">
            {showProject ? (
              <span className="worktree-context">
                {view.projectName}
                {view.projectExists ? '' : ' (projet retiré)'}
              </span>
            ) : null}
            <span>
              {view.session
                ? 'Conversation conservée'
                : view.sessionTitle
                  ? 'Conversation supprimée'
                  : 'Titre d’origine indisponible'}
            </span>
            <span className="worktree-destination">Cible : {target}</span>
          </div>
          {plan.next ? <p className="worktree-guidance">{plan.next}</p> : null}
        </div>
        <div className="worktree-counts">
          {view.dirty && !view.mergeInProgress ? (
            <span title="Fichiers modifiés et non commités dans la copie, contenu de départ compris.">
              {plural(view.dirty, 'fichier non commité', 'fichiers non commités')}
            </span>
          ) : null}
          {view.ahead ? <span>{plural(view.ahead, 'commit')} à intégrer</span> : null}
        </div>
        <div className="worktree-actions">
          {primary}
          <button
            type="button"
            className="btn worktree-toggle"
            aria-expanded={showDetails}
            aria-controls={`worktree-details-${view.id}`}
            onClick={() => actions.toggle(view.id)}
          >
            {showDetails ? 'Réduire' : 'Étapes'}
          </button>
        </div>
      </div>
      {/* A failed merge finished by hand (conflict resolved in the project) no longer needs attention. */}
      {view.operation &&
      !(
        view.operation.kind === 'merge' &&
        view.operation.status !== 'running' &&
        view.integration === 'integrated' &&
        view.operation.sourceHead === view.head
      ) ? (
        <div
          className={`worktree-operation-status ${view.operation.status === 'failed' || view.operation.status === 'interrupted' ? 'worktree-operation-error' : ''}`}
          role="status"
        >
          {view.operation.kind === 'merge' ? 'Intégration' : 'Retrait de la copie'}{' '}
          {
            { running: 'en cours…', succeeded: 'terminé', failed: 'échoué', interrupted: 'interrompu' }[
              view.operation.status
            ]
          }
          {view.operation.error ? <span> · {view.operation.error}</span> : null}
        </div>
      ) : null}
      <div className="worktree-detail" id={`worktree-details-${view.id}`} hidden={!showDetails}>
        <p className="path">{view.path}</p>
        <p className="meta">
          Branche : {branchName(view.branch ?? view.expectedBranch)} · Créée le {createdLabel(view)}
        </p>
        {view.error ? <p className="form-error">{view.error}</p> : null}
        <ol className="worktree-steps">
          <SaveStep
            view={view}
            plan={plan}
            target={target}
            result={result}
            resolver={resolver}
            commitBlocked={commitBlocked}
            showDetails={showDetails}
            actions={actions}
          />
          <UpdateStep
            view={view}
            plan={plan}
            target={target}
            disabled={disabled}
            commitBlocked={commitBlocked}
            actions={actions}
          />
          <IntegrateStep
            view={view}
            plan={plan}
            target={target}
            disabled={disabled}
            integrateTitle={integrateTitle}
            actions={actions}
          />
          <Step
            number={4}
            title="Publier"
            state={view.integration === 'integrated' && !view.ahead ? (view.published ? 'done' : 'todo') : 'waiting'}
          >
            {view.integration === 'integrated' && view.published ? (
              <p>Tout le travail de la copie est sur le dépôt distant de {target}.</p>
            ) : (
              <p>
                L’intégration reste locale à cette machine. Pour envoyer le travail vers le dépôt distant, utilisez «
                Push » dans l’en-tête du projet ({target}).
              </p>
            )}
          </Step>
        </ol>
        {view.operation?.output ? (
          <details>
            <summary>Résultat Git</summary>
            <pre>{view.operation.output}</pre>
          </details>
        ) : null}
        <details className="worktree-cleanup">
          <summary>Retirer cette copie</summary>
          <p>
            Le retrait est distinct de la suppression de la conversation. Il est disponible uniquement quand les
            changements sont intégrés. Il a lieu automatiquement à l’arrêt ou à la suppression de la conversation quand
            aucune donnée locale ne risque d’être effacée.
          </p>
          {view.autoCleanup && view.autoCleanup.status !== 'removed' ? (
            <p>
              Nettoyage automatique {view.autoCleanup.status === 'failed' ? 'échoué' : 'non effectué'} le{' '}
              {formatDateTime(view.autoCleanup.at)} : {view.autoCleanup.reasons.join(' ')}
            </p>
          ) : null}
          {view.ignored ? (
            <p>
              {view.ignored} fichier(s) ignoré(s) par Git sont présents (par exemple dépendances ou configuration
              locale). Ce ne sont pas des changements à intégrer. Ils empêchent le nettoyage automatique ; le retrait
              les liste et ne les supprime qu’après confirmation. Un chemin qu’une compilation recrée peut être déclaré
              régénérable (« Éditer » le projet).
            </p>
          ) : null}
          {removeBlocked.length ? (
            <ul>
              {removeBlocked.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          {remove}
        </details>
      </div>
    </li>
  );
}
