import { ActivityStatus } from './ActivityStatus.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiParsed, markOperationSeen } from './api.ts';
import { Modal } from './Dialog.tsx';
import type { CommitSettings } from '../../shared/types.ts';
import { errorMessage, plural } from './format.ts';
import { usePolling } from './polling.tsx';
import './automatic-commits.css';
import { parseAutomaticCommit, type AutomaticCommit } from '../../shared/git.ts';

const PHASE_LABEL: Record<AutomaticCommit['phase'], string> = {
  collecting: 'Vérification des changements…',
  drafting: 'Rédaction du message par l’IA…',
  committing: 'Création du commit…',
  pushing: 'Push vers les remotes…',
  finished: 'Terminé',
};
interface CommitDialogProps {
  projectId: string;
  endpoint?: string;
  push?: boolean;
  strategy?: CommitSettings['strategy'];
  onClose: () => void;
  scopeLabel?: string;
  reviewed?: { snapshotId: string; paths: string[] };
}
export function AutomaticCommitDialog(props: CommitDialogProps) {
  const [useProject, setUseProject] = useState(false);
  return (
    <AutomaticCommitRun
      key={useProject ? 'project' : 'initial'}
      {...props}
      endpoint={useProject ? undefined : props.endpoint}
      reviewed={useProject ? undefined : props.reviewed}
      scopeLabel={useProject ? 'Tous les changements du dossier partagé du projet' : props.scopeLabel}
      onUseProject={() => setUseProject(true)}
    />
  );
}
function AutomaticCommitRun({
  projectId,
  endpoint,
  push = true,
  strategy,
  onClose,
  scopeLabel,
  reviewed,
  onUseProject,
}: CommitDialogProps & { onUseProject: () => void }) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [review] = useState(reviewed);
  const [operation, setOperation] = useState<AutomaticCommit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [openedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  const start = useRef<Promise<AutomaticCommit> | null>(null);
  const path = endpoint ?? `/api/projects/${projectId}/git`;
  const show = useCallback((value: AutomaticCommit): void => {
    setOperation(value);
    setError(null);
    if (value.finishedAt) markOperationSeen(`auto-commit:${value.id}`);
  }, []);
  useEffect(() => {
    let disposed = false;
    // Reuse the same request in React StrictMode. Reopening also attaches to an active server operation.
    start.current ??= apiParsed(`${path}/auto-commit`, parseAutomaticCommit, {
      method: 'POST',
      body: JSON.stringify({ requestId, push, strategy, ...(review ? { reviewed: review } : {}) }),
    });
    void start.current
      .then((value) => {
        if (!disposed) show(value);
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause));
      });
    return () => {
      disposed = true;
    };
  }, [path, requestId, push, strategy, review, show]);
  const operationId = operation?.id ?? null;
  const load = useCallback(
    () => apiParsed(`/api/git/auto-commits/${operationId}`, parseAutomaticCommit),
    [operationId],
  );
  usePolling(load, 300, {
    enabled: operation !== null && !operation.finishedAt,
    onData: show,
    onError: (cause) => setError(errorMessage(cause)),
  });
  const cancel = async (): Promise<void> => {
    if (!operation) return;
    setCancelling(true);
    try {
      await api(`/api/git/auto-commits/${operation.id}/cancel`, { method: 'POST' });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCancelling(false);
    }
  };
  const active = operation ? operation.status === 'running' : !error;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const phase = operation?.phase ?? 'collecting';
  const steps = [
    ['collecting', 'Vérifier les fichiers'],
    ['drafting', 'Rédiger le message'],
    ['committing', 'Créer le commit'],
    ...(push ? [['pushing', 'Envoyer les commits']] : []),
  ];
  return (
    <Modal title={push ? 'Commit et push automatiques' : 'Commit automatique'} onClose={onClose}>
      <div className="automatic-commit">
        <p className="automatic-commit-status">
          <ActivityStatus active={active}>
            {operation?.status === 'succeeded'
              ? operation.push
                ? operation.commits.length
                  ? 'Commit et push terminés.'
                  : 'Push terminé.'
                : operation.commits.length
                  ? 'Commit créé.'
                  : 'Aucun changement à commiter.'
              : operation?.needsProjectScope
                ? 'Cette conversation utilise le dossier partagé du projet.'
                : operation?.status === 'cancelled'
                  ? 'Opération annulée.'
                  : operation && operation.status !== 'running'
                    ? 'L’opération s’est arrêtée.'
                    : !operation && error
                      ? 'L’opération n’a pas pu démarrer.'
                      : PHASE_LABEL[operation?.phase ?? 'collecting']}
          </ActivityStatus>
        </p>
        {active ? (
          <div className="automatic-commit-progress">
            <ol aria-label="Étapes de l’opération">
              {steps.map(([key, label]) => (
                <li
                  key={key}
                  aria-current={phase === key ? 'step' : undefined}
                  className={phase === key ? 'current' : undefined}
                >
                  {label}
                </li>
              ))}
            </ol>
            <p className="meta">
              {Math.max(0, Math.floor((now - (operation?.startedAt ?? openedAt)) / 1000))} s écoulées
            </p>
            <p>
              {phase === 'collecting'
                ? 'Lecture des changements Git en cours.'
                : phase === 'drafting'
                  ? 'L’IA analyse les changements pour rédiger le message. Cette étape peut prendre du temps ; aucun commit n’a encore été créé.'
                  : phase === 'committing'
                    ? 'Git enregistre les changements. Cette étape ne peut plus être annulée.'
                    : 'Git envoie les commits aux dépôts distants. Cette étape ne peut plus être annulée.'}
            </p>
            {operation?.files.length ? (
              <p className="meta">{plural(operation.files.length, 'fichier')} à commiter</p>
            ) : null}
          </div>
        ) : null}
        <p className="meta">
          {scopeLabel ?? (endpoint ? 'Changements de cette copie de travail' : 'Changements du projet')}
          {operation?.path ? ` · ${operation.path}` : ''}
        </p>
        {operation && operation.phase === 'drafting' ? (
          <p className="meta">
            {operation.settings.agent} · {operation.settings.model ?? 'modèle par défaut'} · effort{' '}
            {operation.settings.effort ?? 'par défaut'}
          </p>
        ) : null}
        {operation?.commits.map((commit) => (
          <p className="automatic-commit-result" key={commit.hash}>
            <code>{commit.hash.slice(0, 8)}</code> {commit.title}
          </p>
        ))}
        {operation?.needsProjectScope ? (
          <p>
            Ses changements ne peuvent pas être séparés de ceux des autres conversations. Vous pouvez commiter et
            pousser les changements du projet entier depuis ici.
          </p>
        ) : operation?.error ? (
          <p className="form-error" role="alert">
            {operation.error}
          </p>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {operation?.pushOperation?.remotes.map((remote) => (
          <p className={remote.status === 'failed' ? 'form-error' : 'meta'} key={remote.remote}>
            {remote.remote} :{' '}
            {{ pending: 'en attente', running: 'push en cours…', succeeded: 'envoyé', failed: 'échec' }[remote.status]}
          </p>
        ))}
        {!operation?.needsProjectScope && operation?.exclusions.length ? (
          <details>
            <summary>
              {plural(operation.exclusions.length, 'fichier écarté, conservé', 'fichiers écartés, conservés')} dans le
              dépôt
            </summary>
            <ul>
              {operation.exclusions.map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code> — {file.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {operation?.files.length || operation?.pushOperation ? (
          <details>
            <summary>Détails de l’opération</summary>
            <p className="path">{operation.path}</p>
            {operation.files.length ? <pre>{operation.files.join('\n')}</pre> : null}
            {operation.pushOperation?.remotes.map((remote) => (
              <div key={remote.remote}>
                <strong>{remote.remote}</strong>
                <pre>{remote.output}</pre>
              </div>
            ))}
          </details>
        ) : null}
        <div className="row-actions">
          {operation?.needsProjectScope && projectId ? (
            <button type="button" className="btn primary" onClick={onUseProject}>
              {push ? 'Commiter et pousser tout le projet' : 'Commiter tout le projet'}
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            {active ? 'Continuer en arrière-plan' : 'Fermer'}
          </button>
          {active && !error ? (
            <span className="hint">Ce bouton masque la fenêtre sans arrêter l’opération.</span>
          ) : null}
          {operation?.status === 'running' && ['collecting', 'drafting'].includes(operation.phase) ? (
            <button
              type="button"
              className="btn automatic-commit-cancel"
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              <ActivityStatus active={cancelling}>{cancelling ? 'Annulation…' : 'Annuler l’opération'}</ActivityStatus>
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
