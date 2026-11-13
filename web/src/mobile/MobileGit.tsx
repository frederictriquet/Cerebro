/*
 * Commit, pull et push depuis la vue mobile. Mêmes opérations serveur et mêmes dialogues que le desktop (GitStatus,
 * GitActions) ; les infobulles du desktop deviennent du texte visible, un téléphone n'affiche pas les `title`.
 * Code review et aperçu des commits à pousser restent sur la version complète.
 */
import { useCallback, useId, useState } from 'react';
import { api, apiPath } from '../api.ts';
import { useAsyncAction } from '../async-action.ts';
import { AutomaticCommitDialog } from '../AutomaticCommitDialog.tsx';
import { errorMessage, plural } from '../format.ts';
import { PullDialog, PushDialog, useSessionGitContext } from '../GitActions.tsx';
import { DirtyFileList } from '../GitStatus.tsx';
import { usePolling } from '../polling.tsx';
import { useStore } from '../store.tsx';
import {
  parseGitInfo,
  pullBlockedReason,
  pushBlockedReason,
  type GitInfo,
  type Project,
  type Session,
} from '../../../shared/types.ts';

const GIT_POLL_MS = 10_000;

async function fetchGit(projectId: string): Promise<GitInfo> {
  const parsed = parseGitInfo(await api(apiPath`/api/projects/${projectId}/git`));
  if (!parsed) throw new Error('Réponse Git invalide');
  return parsed;
}

function AutoPushToggle({ project }: { project: Project }) {
  const { updateProject } = useStore();
  const { run, busy, error } = useAsyncAction((autoPush: boolean) => updateProject(project.id, { autoPush }), {
    fallback: 'Modification impossible',
  });
  return (
    <>
      <label className="m-check">
        <input
          type="checkbox"
          checked={project.autoPush}
          disabled={busy}
          onChange={(event) => void run(event.target.checked)}
        />
        Push auto
      </label>
      <p className="m-hint">
        Pousse la branche du dossier du projet dès qu’un nouveau commit y apparaît, y compris ceux créés ici.
      </p>
      {error === null ? null : (
        <p className="m-form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** Section Git de la page projet : état du dossier du projet, commit automatique, pull, push et push auto. */
export function ProjectGit({ project }: { project: Project }) {
  const [git, setGit] = useState<GitInfo | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [open, setOpen] = useState<'single' | 'atomic' | 'pull' | 'push' | null>(null);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const filesId = useId();
  const fetcher = useCallback(() => fetchGit(project.id), [project.id]);
  const refresh = usePolling(fetcher, GIT_POLL_MS, {
    onData: (value) => {
      setGit(value);
      setReadError(null);
    },
    onError: (cause) => setReadError(errorMessage(cause)),
  });
  // Compteurs à jour dès la fermeture, sans attendre le prochain relevé.
  const close = (): void => {
    setOpen(null);
    void refresh();
  };

  let body;
  if (git === null) {
    body =
      readError === null ? (
        <p className="m-hint">Chargement…</p>
      ) : (
        <p className="m-form-error" role="alert">
          Lecture de l’état Git impossible : {readError}
        </p>
      );
  } else if (git.error) {
    body = (
      <p className="m-form-error" role="alert">
        {git.error}
      </p>
    );
  } else if (!git.repository) {
    body = <p className="m-hint">Pas un dépôt git.</p>;
  } else {
    const hasChanges = git.dirty > 0;
    const dirtyLabel = plural(git.dirty, 'fichier modifié', 'fichiers modifiés', { zeroPlural: true });
    const ahead = git.ahead ?? 0;
    const pullBlocked = pullBlockedReason(git);
    const pushBlocked = pushBlockedReason(git);
    const reasons = [
      hasChanges ? null : 'Rien à commiter.',
      ...(git.branch === null
        ? ['HEAD détachée : choisissez une branche.']
        : [pullBlocked === null ? null : `${pullBlocked}.`, pushBlocked === null ? null : `${pushBlocked}.`]),
    ].filter((reason) => reason !== null);
    body = (
      <>
        <div className="m-git-state">
          <span className="pill">{git.branch ?? 'HEAD détachée'}</span>
          {hasChanges ? (
            <button
              type="button"
              className="m-git-files-toggle git-dirty"
              aria-expanded={filesExpanded}
              aria-controls={filesId}
              onClick={() => setFilesExpanded((value) => !value)}
            >
              <span aria-hidden="true">{filesExpanded ? '▾' : '▸'}</span> {dirtyLabel}
            </button>
          ) : (
            <span>{dirtyLabel}</span>
          )}
          {ahead > 0 ? <span>{plural(ahead, 'commit')} à pousser</span> : null}
          {git.branch !== null && !git.hasUpstream ? <span>pas d’upstream</span> : null}
        </div>
        {filesExpanded && hasChanges ? (
          <section id={filesId} className="m-git-files" aria-label="Fichiers modifiés">
            <DirtyFileList git={git} noteClassName="m-hint" />
          </section>
        ) : null}
        {readError === null ? null : <p className="m-form-error">Actualisation impossible : {readError}</p>}
        <div className="m-git-actions">
          <button type="button" className="m-button" disabled={!hasChanges} onClick={() => setOpen('single')}>
            Un seul commit
          </button>
          <button type="button" className="m-button" disabled={!hasChanges} onClick={() => setOpen('atomic')}>
            Un commit par intention
          </button>
          <button type="button" className="m-button" disabled={pullBlocked !== null} onClick={() => setOpen('pull')}>
            Pull
          </button>
          <button type="button" className="m-button" disabled={pushBlocked !== null} onClick={() => setOpen('push')}>
            Push
          </button>
        </div>
        {reasons.length === 0 ? null : <p className="m-hint">{reasons.join(' ')}</p>}
        <AutoPushToggle project={project} />
      </>
    );
  }

  return (
    <section className="m-section" aria-labelledby="m-git-title">
      <h2 className="m-section-title" id="m-git-title">
        Git
      </h2>
      {body}
      {open === 'single' || open === 'atomic' ? (
        <AutomaticCommitDialog projectId={project.id} push={project.autoPush} strategy={open} onClose={close} />
      ) : null}
      {open === 'pull' ? <PullDialog projectId={project.id} onSettled={() => void refresh()} onClose={close} /> : null}
      {open === 'push' ? <PushDialog projectId={project.id} onClose={close} /> : null}
    </section>
  );
}

/**
 * « Commit / push » de l'écran de session, comme le desktop : la copie de la conversation, ou tout le dossier
 * partagé du projet quand la session y travaille. À remonter par session (`key`).
 */
export function SessionCommit({ session }: { session: Session }) {
  const { context, error } = useSessionGitContext(session.id);
  const [open, setOpen] = useState(false);
  if (error !== null) return <span className="m-form-error">Git : {error}</span>;
  if (context?.mode === 'removed') return <span>Copie de travail retirée</span>;
  const shared = context?.mode === 'shared';
  return (
    <>
      <button type="button" className="m-button" disabled={context === null} onClick={() => setOpen(true)}>
        {shared ? 'Commit / push du projet' : 'Commit / push'}
      </button>
      {open ? (
        <AutomaticCommitDialog
          projectId={session.projectId}
          endpoint={shared ? undefined : apiPath`/api/sessions/${session.id}/git`}
          scopeLabel={
            shared
              ? 'Tous les changements du dossier partagé du projet'
              : 'Changements de la copie de cette conversation'
          }
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
