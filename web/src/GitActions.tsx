import { ActivityStatus } from './ActivityStatus.tsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, apiBase } from './api.ts';
import type { PreparedReview } from '../../server/review.ts';
import { Modal } from './Dialog.tsx';
import { NewSessionForm } from './NewSessionForm.tsx';
import { useStore } from './store.tsx';
import type { SessionGitContext, SessionGitSnapshot } from '../../server/session-git.ts';
import type { GitInfo } from './types.ts';
import type { PushOperation, PushRemoteResult } from '../../server/git-push.ts';
import './automatic-commits.css';
import { AutomaticCommitDialog } from './AutomaticCommitDialog.tsx';

const canPush = (git: GitInfo): boolean => (git.ahead ?? 0) > 0 || (git.hasCommits && !git.hasUpstream);

export function GitActions({
  projectId,
  git,
  pendingCommits,
}: {
  projectId: string;
  git: GitInfo;
  pendingCommits: ReactNode;
}) {
  const [open, setOpen] = useState<'review' | 'single' | 'atomic' | 'push' | null>(null);
  const close = (): void => setOpen(null);
  const hasChanges = git.dirty > 0;
  const pushable = canPush(git);

  return (
    <>
      <span className="git-actions" role="group" aria-label="Changements à commiter">
        <span className={hasChanges ? 'git-dirty' : 'meta'}>
          {git.dirty} fichier{git.dirty === 1 ? '' : 's'} modifié{git.dirty === 1 ? '' : 's'}
        </span>
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
                ? `${strategy === 'single' ? 'Créer un seul commit' : 'Créer un commit par intention'}, sans pousser`
                : 'Rien à commiter'
            }
          >
            {strategy === 'single' ? 'Un seul commit' : 'Un commit par intention'}
          </button>
        ))}
      </span>
      <span className="git-actions git-actions-publish" role="group" aria-label="Publication des commits">
        {pendingCommits}
        {!git.hasUpstream ? <span className="meta">pas d’upstream</span> : null}
        <button
          type="button"
          className="btn"
          onClick={() => setOpen('push')}
          disabled={!pushable}
          title={pushable ? 'Pousser les commits locaux vers les remotes' : 'Rien à pousser'}
        >
          Push
        </button>
      </span>
      {open === 'review' ? <RepoReviewDialog projectId={projectId} onClose={close} /> : null}
      {open === 'single' || open === 'atomic' ? (
        <AutomaticCommitDialog projectId={projectId} push={false} strategy={open} onClose={close} />
      ) : null}
      {open === 'push' ? <PushDialog projectId={projectId} onClose={close} /> : null}
    </>
  );
}

const REMOTE_STATUS: Record<PushRemoteResult['status'], string> = {
  pending: 'en attente',
  running: 'push en cours…',
  succeeded: 'envoyé',
  failed: 'échec',
};

function PushDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [machineBase] = useState(apiBase);
  const [operation, setOperation] = useState<PushOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = useRef<Promise<PushOperation> | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const current = (): boolean => !disposed && apiBase() === machineBase;
    const fail = (cause: unknown): void => {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    };
    const poll = async (): Promise<void> => {
      if (!current()) return;
      try {
        const value = await api<PushOperation | null>(`/api/projects/${projectId}/git/push`);
        if (!current()) return;
        setOperation(value);
        if (value?.status !== 'running') return;
      } catch (cause) {
        fail(cause);
        return;
      }
      timer = window.setTimeout(() => void poll(), 500);
    };
    if (apiBase() !== machineBase) return;
    // Reuse the same request in React StrictMode; a double submission returns the running operation.
    start.current ??= api<PushOperation>(`/api/projects/${projectId}/git/push`, {
      method: 'POST',
      body: JSON.stringify({ allowDirty: true }),
    });
    void start.current
      .then((value) => {
        if (!current()) return;
        setOperation(value);
        if (value.status === 'running') timer = window.setTimeout(() => void poll(), 500);
      })
      .catch(fail);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [projectId, machineBase]);
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
  const [review, setReview] = useState<PreparedReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<PreparedReview>(`/api/projects/${projectId}/git/prepare-review`, { method: 'POST' })
      .then(setReview)
      .catch((cause) => setError(String(cause)));
  }, [projectId]);
  return (
    <Modal title="Périmètre de code review" onClose={onClose}>
      {!review && !error ? (
        <p>
          <ActivityStatus>Préparation du périmètre de review…</ActivityStatus>
        </p>
      ) : null}
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
          <NewSessionForm
            className="bare"
            projectId={projectId}
            initialPrompt="Recherche les bugs dans le périmètre préparé par Cerebro."
            launchDisabled={review.scope === 'empty'}
            onLaunch={async (spec) => {
              await api(`/api/projects/${projectId}/git/review`, {
                method: 'POST',
                body: JSON.stringify({ reviewId: review.id, launch: spec }),
              });
              onClose();
            }}
            onCancel={onClose}
          />
        </>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </Modal>
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
  const [snapshot, setSnapshot] = useState<SessionGitSnapshot | null>(null);
  const [selection, setSelection] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<SessionGitSnapshot>(`/api/sessions/${sessionId}/git/prepare-commit`, { method: 'POST' })
      .then((s) => {
        setSnapshot(s);
        setSelection(
          JSON.stringify(
            {
              snapshotId: s.id,
              selection: s.files.filter((f) => !f.warnings.length).map((f) => ({ path: f.path, all: true })),
              commits: s.provenance.commits.filter((c) => c.certainty === 'workspace').map((c) => c.hash),
              acknowledged: [],
            },
            null,
            2,
          ),
        );
      })
      .catch((cause) => setError(String(cause)));
  }, [sessionId]);
  return (
    <Modal title="Périmètre de review de la session" onClose={onClose}>
      {!snapshot && !error ? (
        <p>
          <ActivityStatus>Préparation du périmètre de review…</ActivityStatus>
        </p>
      ) : null}
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
            onChange={(e) => setSelection(e.target.value)}
          />
          <NewSessionForm
            className="bare"
            projectId={projectId}
            initialPrompt="Review du périmètre sélectionné"
            onLaunch={async (spec) => {
              try {
                await api(`/api/sessions/${sessionId}/git/review`, {
                  method: 'POST',
                  body: JSON.stringify({ selection: JSON.parse(selection), launch: spec }),
                });
                onClose();
              } catch (cause) {
                setError(String(cause));
                throw cause;
              }
            }}
            onCancel={onClose}
          />
        </>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </Modal>
  );
}

export function SessionGitActions({ sessionId }: { sessionId: string }) {
  const { sessions } = useStore();
  const session = sessions.find((s) => s.id === sessionId);
  const [open, setOpen] = useState<'review' | 'commit' | null>(null);
  const [context, setContext] = useState<SessionGitContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const machineBase = apiBase();
  useEffect(() => {
    let disposed = false;
    setContext(null);
    setContextError(null);
    setOpen(null);
    void api<SessionGitContext>(`/api/sessions/${sessionId}/git/context`)
      .then((value) => {
        if (!disposed && apiBase() === machineBase) setContext(value);
      })
      .catch((cause) => {
        if (!disposed && apiBase() === machineBase)
          setContextError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, machineBase]);
  if (!session) return null;
  const close = (): void => setOpen(null);
  const shared = context?.mode === 'shared';
  return (
    <>
      <button className="btn" disabled={!context || context.mode === 'removed'} onClick={() => setOpen('review')}>
        {shared ? 'Code review du projet' : 'Code review'}
      </button>
      <button
        className="btn"
        disabled={!context || context.mode === 'removed'}
        title={
          contextError ??
          (shared
            ? 'Traite tous les changements du dossier partagé du projet, y compris ceux des autres conversations.'
            : context?.mode === 'removed'
              ? 'La copie de travail de cette conversation a été retirée.'
              : 'Traite les changements vérifiables de la copie de cette conversation.')
        }
        onClick={() => setOpen('commit')}
      >
        {shared ? 'Commit / push du projet' : 'Commit / push'}
      </button>
      {contextError ? <span className="form-error">{contextError}</span> : null}
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
