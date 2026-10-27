import type { WorktreeView } from '../../../shared/worktrees.ts';
import { branchName, copyTitle, type Journey, type WorktreeActions } from './model.ts';
import { Step } from './Step.tsx';

/** Step 3: merge the copy's commits into the chosen target branch. */
export function IntegrateStep({
  view,
  plan,
  target,
  disabled,
  integrateTitle,
  actions,
}: {
  view: WorktreeView;
  plan: Journey;
  target: string;
  disabled: boolean;
  integrateTitle: string;
  actions: WorktreeActions;
}) {
  return (
    <Step number={3} title={`Intégrer dans ${target}`} state={plan.integrate}>
      <div className="worktree-target">
        <label>
          Branche cible{' '}
          <select
            aria-label={`Cible de ${copyTitle(view)}`}
            value={view.targetBranch ?? ''}
            disabled={disabled}
            onChange={(event) => void actions.chooseTarget(view, event.target.value)}
          >
            {!view.targets.some((target) => target.branch === view.targetBranch) ? (
              <option value={view.targetBranch ?? ''}>
                {view.targetBranch ? `${branchName(view.targetBranch)} (dossier non ouvert)` : 'Choisir une branche'}
              </option>
            ) : null}
            {view.targets.map((target) => (
              <option key={target.branch} value={target.branch}>
                {branchName(target.branch)} — {target.path}
              </option>
            ))}
          </select>
        </label>
      </div>
      {view.integration === 'integrated' && !view.ahead ? (
        <p>Tout le travail commité de la copie est dans {target}.</p>
      ) : view.ahead && view.mergeBlockers.length ? (
        <>
          <p>L’intégration attend :</p>
          <ul>
            {view.mergeBlockers.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </>
      ) : view.ahead ? (
        <p>
          {view.ahead === 1 ? 'Le commit sera intégré' : `Les ${view.ahead} commits seront intégrés`} par un merge dans{' '}
          {view.targetPath}.
        </p>
      ) : (
        <p>Aucun commit à intégrer : enregistrez d’abord le travail (étape 1).</p>
      )}
      {view.ahead ? (
        <button
          type="button"
          className={`btn ${view.mergeBlockers.length || view.integrationConflicts?.length ? '' : 'primary'}`}
          disabled={disabled || view.mergeBlockers.length > 0}
          title={integrateTitle}
          onClick={() => void actions.prepare(view, 'merge')}
        >
          Intégrer dans {target}
        </button>
      ) : null}
    </Step>
  );
}
