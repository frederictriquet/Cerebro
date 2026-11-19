import { useState } from 'react';
import type { EpicRun } from '../../../shared/backlog.ts';
import {
  controlEpicRun,
  markEpicRunSeen,
  RUN_ACTIVE,
  setEpicRunAutoValidation,
  setEpicRunSingleSession,
} from '../epic-runs.ts';
import { EpicWorkspacePicker } from '../EpicWorkspacePicker.tsx';
import { EPIC_RUN_STATUS_LABEL, errorMessage, pluralize } from '../format.ts';
import { href } from '../route.ts';
import { useStore } from '../store.tsx';

const RUN_RESULT_LABEL: Record<string, string> = {
  'declared-done': 'déclarée terminée',
  validated: 'validée',
  'auto-validated': 'validée automatiquement',
  'criterion-exit-zero': 'commande réussie',
  'execution-succeeded': 'exécution réussie',
  'waiting-validation': 'en attente de validation',
  blocked: 'bloquée',
  failed: 'en échec',
};
// États où l'exécution attend l'utilisateur : sa raison et ses actions restent visibles sans rien déplier.
const RUN_NEEDS_ACTION: EpicRun['status'][] = ['blocked', 'failed', 'waiting-validation'];
const RUN_RESUMABLE: EpicRun['status'][] = ['waiting-validation', 'blocked', 'failed', 'stopped'];

export function EpicRunPanel({
  run,
  labelOf,
  onChanged,
}: {
  run: EpicRun;
  labelOf: (id: string) => string;
  onChanged: () => Promise<void>;
}) {
  const { updateTask } = useStore();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const perform = (operation: () => Promise<unknown>): void => {
    setPending(true);
    void operation()
      .then(() => {
        setError(null);
        return onChanged();
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setPending(false));
  };
  const setAutoValidate = (enabled: boolean): void => {
    if (pending) return;
    perform(() => setEpicRunAutoValidation(run.id, enabled));
  };
  const setSingleSession = (enabled: boolean): void => {
    if (pending) return;
    perform(() => setEpicRunSingleSession(run.id, enabled));
  };
  const action = (name: 'stop' | 'resume' | 'validate'): void => {
    if (pending) return;
    if (name !== 'validate') {
      perform(() => controlEpicRun(run, name));
      return;
    }
    const taskId = run.currentTaskId;
    if (taskId) perform(() => updateTask(taskId, { status: 'done' }));
  };
  const needsAction = RUN_NEEDS_ACTION.includes(run.status);
  const awaitingTaskId = run.status === 'waiting-validation' ? run.currentTaskId : null;
  const awaitingValidation = awaitingTaskId !== null;
  const activeSessionId = run.sessionId ?? (run.blockReason === 'session-waiting' ? (run.epicSessionId ?? null) : null);
  // Champs absents des machines distantes antérieures.
  const results = Object.entries(run.results ?? {});
  return (
    <div className="epic-run">
      <details
        onToggle={(e) => {
          if (e.currentTarget.open) markEpicRunSeen(run);
        }}
      >
        <summary>
          Ordonnanceur : <span className={`epic-run-status ${run.status}`}>{EPIC_RUN_STATUS_LABEL[run.status]}</span> —{' '}
          {results.length}/{run.order?.length ?? 0} {pluralize(results.length, 'résultat')}
        </summary>
        <p>Étape courante : {run.currentTaskId ? labelOf(run.currentTaskId) : 'aucune'}</p>
        <p>Sessions LLM : {run.singleSession ? 'une seule session (hors review)' : 'une par étape'}</p>
        <p>Espace : {run.contextRoot}</p>
        {!needsAction && run.error ? <p>{run.error}</p> : null}
        {results.length > 0 ? (
          <ul>
            {results.map(([id, result]) => (
              <li key={id}>
                {labelOf(id)} : {RUN_RESULT_LABEL[result] ?? result}
              </li>
            ))}
          </ul>
        ) : null}
      </details>
      {RUN_ACTIVE.includes(run.status) ? (
        <>
          <label className="epic-run-reason task-command-check">
            <input
              type="checkbox"
              checked={run.autoValidate ?? false}
              disabled={pending || run.workspaceConflict}
              onChange={(event) => setAutoValidate(event.target.checked)}
            />
            <span>
              Valider automatiquement — clôt les étapes en attente de validation et poursuit l’epic. Une étape déclarée
              terminée par l’agent déclenche l’étape suivante quel que soit ce réglage.
            </span>
          </label>
          <label className="epic-run-reason task-command-check">
            <input
              type="checkbox"
              checked={run.singleSession ?? false}
              disabled={pending || run.workspaceConflict}
              onChange={(event) => setSingleSession(event.target.checked)}
            />
            <span>
              Même session LLM — conserve la même conversation d’une étape à l’autre (l’éventuelle étape de review reste
              dans une session dédiée).
            </span>
          </label>
        </>
      ) : null}
      {run.workspaceConflict ? (
        <EpicWorkspacePicker
          epicId={run.epicId}
          onResolved={async () => {
            setError(null);
            await onChanged();
          }}
        />
      ) : null}
      {needsAction && run.error && !run.workspaceConflict ? <p className="epic-run-reason">{run.error}</p> : null}
      {run.workspaceError && !run.workspaceConflict && run.workspaceError !== run.error ? (
        <p className="epic-run-reason">{run.workspaceError}</p>
      ) : null}
      {awaitingTaskId !== null ? (
        <p className="epic-run-reason">
          Étape à valider : {labelOf(awaitingTaskId)}. Vérifiez le résultat et les critères de la tâche, puis marquez
          cette étape terminée pour poursuivre l’epic. Le plan suit seul les modifications de l’epic ; reprendre ne
          valide pas le travail.
        </p>
      ) : null}
      {RUN_RESUMABLE.includes(run.status) ? (
        <p className="epic-run-reason">
          Reprendre et recalculer réutilise le modèle de cette exécution.
          {RUN_ACTIVE.includes(run.status)
            ? ' Pour changer de modèle, arrêtez l’epic puis relancez-le depuis son en-tête.'
            : null}
        </p>
      ) : null}
      {RUN_ACTIVE.includes(run.status) || RUN_RESUMABLE.includes(run.status) ? (
        <div className="row-actions">
          {needsAction && activeSessionId ? (
            <a className="btn" href={href(`#/s/${activeSessionId}`)}>
              Ouvrir la session de l’étape
            </a>
          ) : null}
          {awaitingValidation ? (
            <button type="button" className="btn primary" disabled={pending} onClick={() => action('validate')}>
              Valider l’étape et poursuivre
            </button>
          ) : null}
          {RUN_RESUMABLE.includes(run.status) ? (
            <button
              type="button"
              className={`btn ${needsAction && !awaitingValidation ? 'primary' : ''}`}
              disabled={pending || run.workspaceConflict}
              onClick={() => action('resume')}
            >
              Reprendre et recalculer
            </button>
          ) : null}
          {RUN_ACTIVE.includes(run.status) ? (
            <button type="button" className="btn" disabled={pending} onClick={() => action('stop')}>
              Arrêter l’epic
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
