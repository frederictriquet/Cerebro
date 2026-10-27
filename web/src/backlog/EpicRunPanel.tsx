import { useState } from 'react';
import type { EpicRunRecord, EpicRunView } from '../../../server/epic-runner.ts';
import { controlEpicRun, markEpicRunSeen, RUN_ACTIVE, setEpicRunAutoValidation } from '../epic-runs.ts';
import { EpicWorkspacePicker } from '../EpicWorkspacePicker.tsx';
import { href } from '../route.ts';
import { useStore } from '../store.tsx';

const RUN_STATUS_LABEL: Record<EpicRunRecord['status'], string> = {
  running: 'en cours',
  'waiting-validation': 'en attente de validation',
  blocked: 'bloqué',
  failed: 'en échec',
  stopped: 'arrêté',
  succeeded: 'terminé',
};
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
const RUN_NEEDS_ACTION: EpicRunRecord['status'][] = ['blocked', 'failed', 'waiting-validation'];
const RUN_RESUMABLE: EpicRunRecord['status'][] = ['waiting-validation', 'blocked', 'failed', 'stopped'];

export function EpicRunPanel({
  run,
  taskLabel,
  onChanged,
}: {
  run: EpicRunView;
  taskLabel: (id: string) => string;
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
      .catch((cause: unknown) => setError(String(cause)))
      .finally(() => setPending(false));
  };
  const setAutoValidate = (enabled: boolean): void => {
    if (pending) return;
    perform(() => setEpicRunAutoValidation(run.id, enabled));
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
  const results = Object.entries(run.results);
  return (
    <div className="epic-run">
      <details
        onToggle={(e) => {
          if (e.currentTarget.open) markEpicRunSeen(run);
        }}
      >
        <summary>
          Ordonnanceur : <span className={`epic-run-status ${run.status}`}>{RUN_STATUS_LABEL[run.status]}</span> —{' '}
          {results.length}/{run.order.length} résultat{results.length > 1 ? 's' : ''}
        </summary>
        <p>Étape courante : {run.currentTaskId ? taskLabel(run.currentTaskId) : 'aucune'}</p>
        <p>Espace : {run.contextRoot}</p>
        {!needsAction && run.error ? <p>{run.error}</p> : null}
        {results.length > 0 ? (
          <ul>
            {results.map(([id, result]) => (
              <li key={id}>
                {taskLabel(id)} : {RUN_RESULT_LABEL[result] ?? result}
              </li>
            ))}
          </ul>
        ) : null}
      </details>
      {RUN_ACTIVE.includes(run.status) ? (
        <label className="epic-run-reason task-command-check">
          <input
            type="checkbox"
            checked={run.autoValidate ?? false}
            disabled={pending || run.workspaceConflict}
            onChange={(event) => setAutoValidate(event.target.checked)}
          />
          <span>
            Valider automatiquement — clôt les étapes en attente de validation, y compris l’étape actuelle, et poursuit
            l’epic. Les échecs et les blocages restent à traiter.
          </span>
        </label>
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
      {awaitingTaskId !== null ? (
        <p className="epic-run-reason">
          Étape à valider : {taskLabel(awaitingTaskId)}. Vérifiez le résultat et les critères de la tâche, puis marquez
          cette étape terminée pour poursuivre l’epic. Reprendre et recalculer actualise le plan, sans valider le
          travail.
        </p>
      ) : null}
      {RUN_ACTIVE.includes(run.status) || RUN_RESUMABLE.includes(run.status) ? (
        <div className="row-actions">
          {needsAction && run.sessionId ? (
            <a className="btn" href={href(`#/s/${run.sessionId}`)}>
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
