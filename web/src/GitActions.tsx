import { CommitPushIcon, ReviewIcon } from './SessionIcons.tsx';
import { ActivityStatus } from './ActivityStatus.tsx';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, apiParsed, apiPath, markOperationSeen } from './api.ts';
import { useAsyncAction } from './async-action.ts';
import { LaunchDialog, Modal, usePrepared } from './Dialog.tsx';
import { useStore } from './store.tsx';
import { pullBlockedReason, pushBlockedReason, type GitInfo } from '../../shared/types.ts';
import './automatic-commits.css';
import { AutomaticCommitDialog } from './AutomaticCommitDialog.tsx';
import { errorMessage } from './format.ts';
import { usePolling } from './polling.tsx';
import {
  parseOptionalPullOperation,
  parseOptionalPushOperation,
  parsePreparedReview,
  parsePullOperation,
  parsePushOperation,
  parseSessionGitContext,
  parseSessionGitSnapshot,
  type PullOperation,
  type PushOperation,
  type PushRemoteResult,
  type SessionGitContext,
} from '../../shared/git.ts';

export function GitActions({
  projectId,
  git,
  changes,
  pendingCommits,
  onRefresh,
}: {
  projectId: string;
  git: GitInfo;
  // Compteur des fichiers modifiés, fourni par GitStatus qui en gère le dépliage.
  changes: ReactNode;
  pendingCommits: ReactNode;
  onRefresh?: () => void;
}) {
  const { projects } = useStore();
  const [open, setOpen] = useState<'review' | 'single' | 'atomic' | 'pull' | 'push' | null>(null);
  const close = (): void => {
    setOpen(null);
    onRefresh?.();
  };
  const hasChanges = git.dirty > 0;
  const pullBlocked = pullBlockedReason(git);
  const pushBlocked = pushBlockedReason(git);
  const autoPush = projects.find((project) => project.id === projectId)?.autoPush === true;

  return (
    <>
      <span className="git-actions" role="group" aria-label="Changements à commiter">
        {changes}
        <button
          type="button"
          className="btn"
          onClick={() => setOpen('review')}
          title="Lancer une session de code review"
        >
          Code review
        </button>
        {(['single', 'atomic'] as const).map((strategy) => (
          <button
            key={strategy}
            type="button"
            className="btn"
            onClick={() => setOpen(strategy)}
            disabled={!hasChanges}
            title={
              hasChanges
                ? `${strategy === 'single' ? 'Créer un seul commit' : 'Créer un commit par intention'}, ${autoPush ? 'puis pousser (push auto)' : 'sans pousser'}`
                : 'Rien à commiter'
            }
          >
            {strategy === 'single' ? 'Un seul commit' : 'Un commit par intention'}
          </button>
        ))}
      </span>
      <span className="git-actions git-actions-publish" role="group" aria-label="Synchronisation avec les remotes">
        {pendingCommits}
        {git.branch !== null && !git.hasUpstream ? <span className="meta">pas d’upstream</span> : null}
        <button
          type="button"
          className="btn"
          onClick={() => setOpen('pull')}
          disabled={pullBlocked !== null}
          title={pullBlocked ?? 'Tirer les commits de l’upstream (avance rapide)'}
        >
          Pull
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setOpen('push')}
          disabled={pushBlocked !== null}
          title={pushBlocked ?? 'Pousser les commits locaux vers les remotes'}
        >
          Push
        </button>
        <AutoPushToggle projectId={projectId} checked={autoPush} />
      </span>
      {open === 'review' ? <RepoReviewDialog projectId={projectId} onClose={close} /> : null}
      {open === 'single' || open === 'atomic' ? (
        <AutomaticCommitDialog projectId={projectId} push={autoPush} strategy={open} onClose={close} />
      ) : null}
      {open === 'pull' ? <PullDialog projectId={projectId} onSettled={onRefresh} onClose={close} /> : null}
      {open === 'push' ? <PushDialog projectId={projectId} onClose={close} /> : null}
    </>
  );
}

function AutoPushToggle({ projectId, checked }: { projectId: string; checked: boolean }) {
  const { updateProject } = useStore();
  const { run, busy, error } = useAsyncAction((autoPush: boolean) => updateProject(projectId, { autoPush }), {
    fallback: 'Modification impossible',
  });
  return (
    <label
      className="git-auto-push"
      title={
        error ??
        'Pousse la branche du dossier du projet dès qu’un nouveau commit y apparaît, qu’il vienne de Cerebro, d’un agent ou d’un merge'
      }
    >
      <input type="checkbox" checked={checked} disabled={busy} onChange={(e) => void run(e.target.checked)} />
      Push auto
      {error ? (
        <span className="form-error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

const REMOTE_STATUS: Record<PushRemoteResult['status'], string> = {
  pending: 'en attente',
  running: 'push en cours…',
  succeeded: 'envoyé',
  failed: 'échec',
};

export function PullDialog({
  projectId,
  onSettled,
  onClose,
}: {
  projectId: string;
  onSettled?: () => void;
  onClose: () => void;
}) {
  const [operation, setOperation] = useState<PullOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = useRef<Promise<PullOperation> | null>(null);
  const settled = useRef(false);
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  const apply = useCallback((value: PullOperation | null): void => {
    setOperation(value);
    if (value?.finishedAt) {
      markOperationSeen(value.id);
      if (!settled.current) {
        settled.current = true;
        onSettledRef.current?.();
      }
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    // Reuse the same request in React StrictMode; a double submission returns the running operation.
    start.current ??= apiParsed(apiPath`/api/projects/${projectId}/git/pull`, parsePullOperation, {
      method: 'POST',
    });
    void start.current.then(
      (value) => {
        if (!disposed) apply(value);
      },
      (cause) => {
        if (!disposed) setError(errorMessage(cause));
      },
    );
    return () => {
      disposed = true;
    };
  }, [projectId, apply]);

  // Suivi tant que le pull tourne ; une erreur de suivi l'interrompt.
  const load = useCallback(
    () => apiParsed(apiPath`/api/projects/${projectId}/git/pull`, parseOptionalPullOperation),
    [projectId],
  );
  usePolling(load, 500, {
    enabled: operation?.status === 'running' && error === null,
    immediate: false,
    onData: apply,
    onError: (cause) => setError(errorMessage(cause)),
  });

  const running = !error && (!operation || operation.status === 'running');
  const updated =
    operation?.beforeHead != null && operation.afterHead != null && operation.beforeHead !== operation.afterHead;
  const headLabel = updated
    ? `${operation.beforeHead!.slice(0, 8)} → ${operation.afterHead!.slice(0, 8)}`
    : (operation?.afterHead ?? operation?.beforeHead)?.slice(0, 8);
  return (
    <Modal title="Pull" onClose={onClose}>
      <div className="automatic-commit">
        <p className="automatic-commit-status">
          <ActivityStatus active={running}>
            {operation?.status === 'succeeded'
              ? updated
                ? 'Projet mis à jour.'
                : 'Déjà à jour.'
              : operation?.status === 'failed'
                ? 'Le pull a échoué.'
                : error
                  ? operation
                    ? 'Suivi du pull interrompu.'
                    : 'Le pull n’a pas pu démarrer.'
                  : 'Pull depuis l’upstream…'}
          </ActivityStatus>
        </p>
        {operation?.branch ? (
          <p className="meta">
            Branche {operation.branch}
            {operation.upstream ? ` ← ${operation.upstream}` : ''}
            {headLabel ? ` · ${headLabel}` : ''}
          </p>
        ) : null}
        {operation?.error ? (
          <p className="form-error" role="alert">
            {operation.error}
          </p>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {operation?.output ? (
          <details>
            <summary>Détails de l’opération</summary>
            <pre>{operation.output}</pre>
          </details>
        ) : null}
        <div className="row-actions">
          <button type="button" className="btn" onClick={onClose}>
            {running ? 'Continuer en arrière-plan' : 'Fermer'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function PushDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [operation, setOperation] = useState<PushOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = useRef<Promise<PushOperation> | null>(null);
  useEffect(() => {
    let disposed = false;
    // Reuse the same request in React StrictMode; a double submission returns the running operation.
    start.current ??= apiParsed(`/api/projects/${projectId}/git/push`, parsePushOperation, {
      method: 'POST',
      body: JSON.stringify({ allowDirty: true }),
    });
    void start.current.then(
      (value) => {
        if (!disposed) setOperation(value);
      },
      (cause) => {
        if (!disposed) setError(errorMessage(cause));
      },
    );
    return () => {
      disposed = true;
    };
  }, [projectId]);
  // Suivi tant que le push tourne ; une erreur de suivi l'interrompt.
  const load = useCallback(
    () => apiParsed(`/api/projects/${projectId}/git/push`, parseOptionalPushOperation),
    [projectId],
  );
  usePolling(load, 500, {
    enabled: operation?.status === 'running' && error === null,
    immediate: false,
    onData: setOperation,
    onError: (cause) => setError(errorMessage(cause)),
  });
  const running = !error && (!operation || operation.status === 'running');
  return (
    <Modal title="Push" onClose={onClose}>
      <div className="automatic-commit">
        <p className="automatic-commit-status">
          <ActivityStatus active={running}>
            {operation?.status === 'succeeded'
              ? 'Push terminé.'
              : operation?.status === 'failed'
                ? 'Le push a échoué.'
                : error
                  ? operation
                    ? 'Suivi du push interrompu.'
                    : 'Le push n’a pas pu démarrer.'
                  : 'Push vers les remotes…'}
          </ActivityStatus>
        </p>
        {operation?.branch ? (
          <p className="meta">
            Branche {operation.branch}
            {operation.head ? ` · ${operation.head.slice(0, 8)}` : ''}
          </p>
        ) : null}
        {operation?.error ? (
          <p className="form-error" role="alert">
            {operation.error}
          </p>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {operation?.remotes.map((remote) => (
          <p className={remote.status === 'failed' ? 'form-error' : 'meta'} key={remote.remote}>
            {remote.remote} : {REMOTE_STATUS[remote.status]}
          </p>
        ))}
        {operation?.remotes.some((remote) => remote.output) ? (
          <details>
            <summary>Détails de l’opération</summary>
            {operation.remotes.map((remote) => (
              <div key={remote.remote}>
                <strong>{remote.remote}</strong>
                <pre>{remote.output}</pre>
              </div>
            ))}
          </details>
        ) : null}
        <div className="row-actions">
          <button type="button" className="btn" onClick={onClose}>
            {running ? 'Continuer en arrière-plan' : 'Fermer'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RepoReviewDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const prepare = useCallback(
    () => apiParsed(`/api/projects/${projectId}/git/prepare-review`, parsePreparedReview, { method: 'POST' }),
    [projectId],
  );
  const { value: review, error } = usePrepared(prepare);
  return (
    <LaunchDialog
      title="Périmètre de code review"
      projectId={projectId}
      ready={review !== null}
      error={error}
      initialPrompt="Recherche les bugs dans le périmètre préparé par Cerebro."
      launchDisabled={review?.scope === 'empty'}
      onLaunch={async (spec) => {
        await api(`/api/projects/${projectId}/git/review`, {
          method: 'POST',
          body: JSON.stringify({ reviewId: review!.id, launch: spec }),
        });
        onClose();
      }}
      onClose={onClose}
    >
      {review ? (
        <>
          <p>
            {review.scope} — HEAD {review.head ?? 'aucun commit'} — upstream {review.upstream ?? 'aucun'}
          </p>
          <p>{review.files.join(', ')}</p>
          <p>{review.commits.join(', ')}</p>
          <details>
            <summary>Contexte Git capturé</summary>
            <pre>{review.context || 'Aucun changement à relire.'}</pre>
          </details>
        </>
      ) : null}
    </LaunchDialog>
  );
}

function SessionReviewDialog({
  sessionId,
  projectId,
  onClose,
}: {
  sessionId: string;
  projectId: string;
  onClose: () => void;
}) {
  const prepare = useCallback(
    () => apiParsed(`/api/sessions/${sessionId}/git/prepare-commit`, parseSessionGitSnapshot, { method: 'POST' }),
    [sessionId],
  );
  const { value: snapshot, error } = usePrepared(prepare);
  // Sélection proposée par défaut tant que l'utilisateur ne l'a pas modifiée.
  const [edited, setEdited] = useState<string | null>(null);
  const selection =
    edited ??
    (snapshot
      ? JSON.stringify(
          {
            snapshotId: snapshot.id,
            selection: snapshot.files.filter((f) => !f.warnings.length).map((f) => ({ path: f.path, all: true })),
            commits: snapshot.provenance.commits.filter((c) => c.certainty === 'workspace').map((c) => c.hash),
            acknowledged: [],
          },
          null,
          2,
        )
      : '');
  return (
    <LaunchDialog
      title="Périmètre de review de la session"
      projectId={projectId}
      ready={snapshot !== null}
      error={error}
      initialPrompt="Review du périmètre sélectionné"
      onLaunch={async (spec) => {
        await api(`/api/sessions/${sessionId}/git/review`, {
          method: 'POST',
          body: JSON.stringify({ selection: JSON.parse(selection), launch: spec }),
        });
        onClose();
      }}
      onClose={onClose}
    >
      {snapshot ? (
        <>
          <p>{snapshot.scopeNotice}</p>
          {snapshot.files.map((f) => (
            <details key={f.path}>
              <summary>
                {f.path} — {f.warnings.join(' ; ')}
              </summary>
              <pre>{f.diff}</pre>
              {f.hunks.map((h) => (
                <p key={h.id}>Hunk : {h.id}</p>
              ))}
            </details>
          ))}
          {snapshot.provenance.commits.map((c) => (
            <p key={c.hash}>
              {c.hash} — {c.title} ({c.certainty})
            </p>
          ))}
          <p>
            Choisissez les fichiers/hunks et commits explicitement. Confirmez les chemins ou hashes incertains dans
            acknowledged.
          </p>
          <textarea
            aria-label="Sélection de review JSON"
            rows={12}
            value={selection}
            onChange={(e) => setEdited(e.target.value)}
          />
        </>
      ) : null}
    </LaunchDialog>
  );
}

// `review` : bouton « Code review » de la rangée d'actions ; `commit` : picto Commit / push de l'en-tête.
export function SessionGitActions({ sessionId, part }: { sessionId: string; part: 'review' | 'commit' }) {
  // Une autre session repart d'un état vierge : ni le contexte ni le dialogue de la précédente. Changer de machine
  // remonte déjà tout l'arbre (StoreProvider par machine, App.tsx).
  return <SessionGitActionsPanel key={sessionId} sessionId={sessionId} part={part} />;
}

/** Dossier Git d'une session (partagé, copie isolée ou copie retirée), lu au montage : le composant appelant est remonté par session. */
export function useSessionGitContext(sessionId: string): {
  context: SessionGitContext | null;
  error: string | null;
} {
  const [context, setContext] = useState<SessionGitContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void apiParsed(apiPath`/api/sessions/${sessionId}/git/context`, parseSessionGitContext)
      .then((value) => {
        if (!disposed) setContext(value);
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause));
      });
    return () => {
      disposed = true;
    };
  }, [sessionId]);
  return { context, error };
}

function SessionGitActionsPanel({ sessionId, part }: { sessionId: string; part: 'review' | 'commit' }) {
  const { sessions } = useStore();
  const session = sessions.find((s) => s.id === sessionId);
  const [open, setOpen] = useState<'review' | 'commit' | null>(null);
  const { context, error: contextError } = useSessionGitContext(sessionId);
  if (!session) return null;
  const close = (): void => setOpen(null);
  const shared = context?.mode === 'shared';
  return (
    <>
      {part === 'review' ? (
        <button
          type="button"
          className="icon-btn"
          aria-label={shared ? 'Code review du projet' : 'Code review'}
          title={
            shared
              ? 'Code review du projet : tous les changements du dossier partagé'
              : 'Code review des changements de cette conversation'
          }
          disabled={!context || context.mode === 'removed'}
          onClick={() => setOpen('review')}
        >
          <ReviewIcon />
        </button>
      ) : (
        <button
          type="button"
          className="icon-btn"
          aria-label={shared ? 'Commit / push du projet' : 'Commit / push'}
          disabled={!context || context.mode === 'removed'}
          title={`${shared ? 'Commit / push du projet' : 'Commit / push'}. ${
            contextError ??
            (shared
              ? 'Traite tous les changements du dossier partagé du projet, y compris ceux des autres conversations.'
              : context?.mode === 'removed'
                ? 'La copie de travail de cette conversation a été retirée.'
                : 'Traite les changements vérifiables de la copie de cette conversation.')
          }`}
          onClick={() => setOpen('commit')}
        >
          <CommitPushIcon />
        </button>
      )}
      {contextError && part === 'review' ? <span className="form-error">{contextError}</span> : null}
      {open === 'commit' ? (
        <AutomaticCommitDialog
          projectId={session.projectId}
          endpoint={shared ? undefined : `/api/sessions/${sessionId}/git`}
          scopeLabel={
            shared
              ? 'Tous les changements du dossier partagé du projet'
              : 'Changements de la copie de cette conversation'
          }
          onClose={close}
        />
      ) : null}
      {open === 'review' ? (
        shared ? (
          <RepoReviewDialog projectId={session.projectId} onClose={close} />
        ) : (
          <SessionReviewDialog sessionId={sessionId} projectId={session.projectId} onClose={close} />
        )
      ) : null}
    </>
  );
}
