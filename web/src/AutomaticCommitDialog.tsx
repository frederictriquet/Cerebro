import { ActivityStatus } from './ActivityStatus.tsx';
import { AgentLabel } from './AgentLabel.tsx';
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
  reviewed?: AutomaticCommit['reviewed'];
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
  // Le serveur passe la phase à « finished » en fin d'opération : la dernière étape vue désigne celle où
  // l'opération s'est arrêtée.
  const [lastPhase, setLastPhase] = useState<AutomaticCommit['phase']>('collecting');
  const show = useCallback((value: AutomaticCommit): void => {
    setOperation(value);
    if (value.phase !== 'finished') setLastPhase(value.phase);
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
  const steps: [AutomaticCommit['phase'], string][] = [
    ['collecting', 'Vérifier les fichiers'],
    ['drafting', 'Rédiger le message'],
    ['committing', 'Créer le commit'],
    ...(push ? [['pushing', 'Envoyer les commits'] as [AutomaticCommit['phase'], string]] : []),
  ];
  const succeeded = operation?.status === 'succeeded';
  const stopped = !active && !succeeded;
  const currentIndex = steps.findIndex(([key]) => key === lastPhase);
  const stepState = (index: number): 'done' | 'current' | 'stopped' | 'todo' => {
    if (succeeded || index < currentIndex) return 'done';
    if (index > currentIndex) return 'todo';
    return stopped ? 'stopped' : 'current';
  };
  const stopTitle = operation?.needsProjectScope
    ? 'Cette conversation utilise le dossier partagé du projet.'
    : operation?.status === 'cancelled'
      ? 'Opération annulée.'
      : operation
        ? 'L’opération s’est arrêtée.'
        : 'L’opération n’a pas pu démarrer.';
  const stopMessage = operation?.needsProjectScope
    ? 'Ses changements ne peuvent pas être séparés de ceux des autres conversations. Vous pouvez commiter et pousser les changements du projet entier depuis ici.'
    : (operation?.error ?? error);
  return (
    <Modal title={push ? 'Commit et push automatiques' : 'Commit automatique'} onClose={onClose}>
      <div className="automatic-commit">
        <p className="meta">
          {scopeLabel ?? (endpoint ? 'Changements de cette copie de travail' : 'Changements du projet')}
          {operation?.path ? (
            <>
              {' · '}
              <span className="mono">{operation.path}</span>
            </>
          ) : null}
        </p>
        <ol className="automatic-commit-steps" aria-label="Étapes de l’opération">
          {steps.map(([key, label], index) => {
            const state = stepState(index);
            return (
              <li key={key} className={state} aria-current={state === 'current' ? 'step' : undefined}>
                <span
                  className={
                    state === 'current' ? 'pill status running' : state === 'stopped' ? 'pill status waiting' : 'pill'
                  }
                >
                  {state === 'done' ? '✓' : index + 1}
                </span>
                {label}
              </li>
            );
          })}
        </ol>
        {active ? (
          <div className="automatic-commit-progress">
            <p className="automatic-commit-status">
              <ActivityStatus active>{PHASE_LABEL[phase]}</ActivityStatus>
              <span className="meta">
                {' · '}
                {Math.max(0, Math.floor((now - (operation?.startedAt ?? openedAt)) / 1000))} s
                {operation?.files.length ? ` · ${plural(operation.files.length, 'fichier')} à commiter` : ''}
              </span>
            </p>
            <p className="hint">
              {phase === 'collecting'
                ? 'Lecture des changements Git en cours.'
                : phase === 'drafting'
                  ? 'L’IA analyse les changements pour rédiger le message. Cette étape peut prendre du temps ; aucun commit n’a encore été créé.'
                  : phase === 'committing'
                    ? 'Git enregistre les changements. Cette étape ne peut plus être annulée.'
                    : 'Git envoie les commits aux dépôts distants. Cette étape ne peut plus être annulée.'}
            </p>
          </div>
        ) : null}
        {succeeded ? (
          <div className="automatic-commit-ok" role="status">
            <b>
              {operation.push
                ? operation.commits.length
                  ? 'Commit et push terminés.'
                  : 'Push terminé.'
                : operation.commits.length
                  ? 'Commit créé.'
                  : 'Aucun changement à commiter.'}
            </b>
            {operation.commits.map((commit) => (
              <span key={commit.hash}>
                <code>{commit.hash.slice(0, 8)}</code> {commit.title}
              </span>
            ))}
          </div>
        ) : null}
        {stopped ? (
          <div className="automatic-commit-stop" role="alert">
            <b>{stopTitle}</b>
            {stopMessage ? <span>{stopMessage}</span> : null}
            {operation?.commits.map((commit) => (
              <span key={commit.hash}>
                Commit conservé : <code>{commit.hash.slice(0, 8)}</code> {commit.title}
              </span>
            ))}
          </div>
        ) : error ? (
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
          <details className="automatic-commit-fold">
            <summary>
              {plural(operation.exclusions.length, 'fichier écarté, conservé', 'fichiers écartés, conservés')} dans le
              dépôt
            </summary>
            <ul>
              {operation.exclusions.map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code> : {file.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {operation?.overridden.length ? (
          <div>
            <p>
              {plural(
                operation.overridden.length,
                'fichier inclus malgré la détection d’un secret',
                'fichiers inclus malgré la détection d’un secret',
              )}{' '}
              (dérogation explicite sur le diff examiné) :
            </p>
            <ul>
              {operation.overridden.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {operation?.files.length || operation?.pushOperation ? (
          <details className="automatic-commit-fold">
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
        <div className="automatic-commit-footer">
          {operation ? (
            <span className="hint">
              <AgentLabel agent={operation.settings.agent} /> · {operation.settings.model ?? 'modèle par défaut'} ·{' '}
              {operation.settings.effort ?? 'effort par défaut'}
            </span>
          ) : null}
          <span className="automatic-commit-spacer" />
          {operation?.needsProjectScope && projectId ? (
            <button type="button" className="btn primary" onClick={onUseProject}>
              {push ? 'Commiter et pousser tout le projet' : 'Commiter tout le projet'}
            </button>
          ) : null}
          {operation?.status === 'running' && ['collecting', 'drafting'].includes(operation.phase) ? (
            <button type="button" className="btn" disabled={cancelling} onClick={() => void cancel()}>
              <ActivityStatus active={cancelling}>{cancelling ? 'Annulation…' : 'Annuler l’opération'}</ActivityStatus>
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            title={active ? 'Masque la fenêtre sans arrêter l’opération' : undefined}
            onClick={onClose}
          >
            {active ? 'Continuer en arrière-plan' : 'Fermer'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
