import { ActivityStatus } from './ActivityStatus.tsx';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { plural, sessionTitle } from './format.ts';
import { GitActions } from './GitActions.tsx';
import { usePolling } from './polling.tsx';
import { useStore } from './store.tsx';
import { parseGitInfo, type GitCommitPreview, type GitInfo, type Session } from '../../shared/types.ts';

export function GitStatus({ projectId }: { projectId: string }) {
  const { sessions, gitSyncVersion = 0, reportProjectBehind } = useStore();
  const [git, setGit] = useState<GitInfo | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewId = useId();
  const [incomingExpanded, setIncomingExpanded] = useState(false);
  const [incomingPreviewError, setIncomingPreviewError] = useState<string | null>(null);
  const incomingPreviewId = useId();
  const [filesExpanded, setFilesExpanded] = useState(false);
  const filesId = useId();

  const load = useCallback(async (): Promise<GitInfo> => {
    const params = new URLSearchParams();
    if (expanded) params.set('commits', 'true');
    if (incomingExpanded) params.set('incoming', 'true');
    const query = params.size > 0 ? `?${params.toString()}` : '';
    const raw = await api(`/api/projects/${projectId}/git${query}`);
    const parsed = parseGitInfo(raw);
    if (!parsed) throw new Error('Réponse Git invalide');
    return parsed;
  }, [projectId, expanded, incomingExpanded]);
  const refresh = usePolling(load, 10_000, {
    onData: (parsed) => {
      setGit(parsed);
      reportProjectBehind?.(projectId, parsed.branch !== null ? (parsed.behind ?? 0) : 0);
      setPreviewError(
        expanded && !parsed.pendingCommits && !parsed.pendingCommitsError && (parsed.ahead ?? 0) > 0
          ? 'Aperçu indisponible sur cette machine.'
          : null,
      );
      setIncomingPreviewError(
        incomingExpanded && !parsed.incomingCommits && !parsed.incomingCommitsError && (parsed.behind ?? 0) > 0
          ? 'Aperçu indisponible sur cette machine.'
          : null,
      );
    },
    onError: () => {
      if (expanded) setPreviewError('Impossible de charger les commits. Nouvelle tentative dans quelques instants.');
      if (incomingExpanded)
        setIncomingPreviewError('Impossible de charger les commits. Nouvelle tentative dans quelques instants.');
    },
  });
  const seenSync = useRef(gitSyncVersion);
  useEffect(() => {
    if (seenSync.current === gitSyncVersion) return;
    seenSync.current = gitSyncVersion;
    void refresh();
  }, [gitSyncVersion, refresh]);

  if (!git) return null;
  if (git.error)
    return (
      <p className="git-line form-error" role="alert">
        {git.error}
      </p>
    );
  if (!git.repository) return <p className="git-line meta">Pas un dépôt git</p>;
  const count = git.ahead ?? 0;
  const behind = git.behind ?? 0;
  const preview = git.pendingCommits;
  const error = git.pendingCommitsError ?? previewError;
  const incomingPreview = git.incomingCommits;
  const incomingError = git.incomingCommitsError ?? incomingPreviewError;
  const dirtyLabel = plural(git.dirty, 'fichier modifié', 'fichiers modifiés', { zeroPlural: true });
  return (
    <>
      <div className="git-line">
        <span className="pill">{git.branch ?? 'HEAD détachée'}</span>
        <GitActions
          projectId={projectId}
          git={git}
          onRefresh={() => void refresh()}
          changes={
            git.dirty > 0 ? (
              <button
                type="button"
                className="git-toggle git-dirty"
                aria-expanded={filesExpanded}
                aria-controls={filesId}
                onClick={() => setFilesExpanded((value) => !value)}
              >
                <span aria-hidden="true">{filesExpanded ? '▾' : '▸'}</span> {dirtyLabel}
              </button>
            ) : (
              <span className="meta">{dirtyLabel}</span>
            )
          }
          incomingCommits={
            behind > 0 ? (
              <button
                type="button"
                className="git-toggle git-behind"
                aria-expanded={incomingExpanded}
                aria-controls={incomingPreviewId}
                onClick={() => {
                  setIncomingExpanded((value) => !value);
                  setIncomingPreviewError(null);
                }}
              >
                <span aria-hidden="true">{incomingExpanded ? '▾' : '▸'}</span> ↓ {plural(behind, 'commit')} à tirer
              </button>
            ) : null
          }
          pendingCommits={
            count > 0 ? (
              <button
                type="button"
                className="git-toggle"
                aria-expanded={expanded}
                aria-controls={previewId}
                onClick={() => {
                  setExpanded((value) => !value);
                  setPreviewError(null);
                }}
              >
                <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {plural(count, 'commit')} à pousser
              </button>
            ) : null
          }
        />
      </div>
      <CommitBlockers git={git} busy={sessions.filter((s) => s.projectId === projectId && workingInProjectFolder(s))} />
      {filesExpanded && git.dirty > 0 ? <DirtyFiles id={filesId} git={git} /> : null}
      {incomingExpanded && behind > 0 ? (
        <CommitPreviewSection
          id={incomingPreviewId}
          label="Commits à tirer"
          count={behind}
          preview={incomingPreview}
          error={incomingError}
          heading={(upstream) => (
            <>
              Commits distants sur <strong>{upstream}</strong> absents localement
            </>
          )}
        />
      ) : null}
      {expanded && count > 0 ? (
        <CommitPreviewSection
          id={previewId}
          label="Commits à pousser"
          count={count}
          preview={preview}
          error={error}
          heading={(upstream) => (
            <>
              Commits locaux absents de <strong>{upstream}</strong>
            </>
          )}
        />
      ) : null}
    </>
  );
}

function CommitPreviewSection({
  id,
  label,
  count,
  preview,
  error,
  heading,
}: {
  id: string;
  label: string;
  count: number;
  preview: GitCommitPreview | undefined;
  error: string | null;
  heading: (upstream: string) => ReactNode;
}) {
  return (
    <section id={id} className="git-preview" aria-label={label}>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : preview ? (
        <>
          <p className="meta">{heading(preview.upstream)}</p>
          <ol className="git-pending-list">
            {preview.commits.map((commit) => (
              <li key={commit.hash}>
                <code title={commit.hash}>{commit.hash.slice(0, 8)}</code>
                <span className="git-commit-subject">{commit.subject}</span>
                <span className="meta git-commit-author">Auteur : {commit.author}</span>
              </li>
            ))}
          </ol>
          {preview.truncated ? (
            <p className="meta">
              Les {preview.commits.length} commits les plus récents sont affichés sur {count}.
            </p>
          ) : null}
        </>
      ) : (
        <p className="meta">
          <ActivityStatus>Chargement des commits…</ActivityStatus>
        </p>
      )}
    </section>
  );
}

/** Fichiers comptés comme modifiés, dans l'ordre de `git status` ; un dossier non suivi y figure une fois (`dossier/`). */
export function DirtyFileList({ git, noteClassName }: { git: GitInfo; noteClassName: string }) {
  const files = git.dirtyFiles;
  if (!files) return <p className={noteClassName}>Liste indisponible sur cette machine.</p>;
  return (
    <>
      <ul className="git-file-list">
        {/* Un même chemin peut figurer deux fois (`git rm --cached` : supprimé de l'index et non suivi). */}
        {files.paths.map((path, index) => (
          <li key={`${index}:${path}`}>
            <code>{path}</code>
          </li>
        ))}
      </ul>
      {files.truncated ? (
        <p className={noteClassName}>
          Les {files.paths.length} premiers fichiers sont affichés sur {git.dirty}.
        </p>
      ) : null}
    </>
  );
}

function DirtyFiles({ id, git }: { id: string; git: GitInfo }) {
  return (
    <section id={id} className="git-preview" aria-label="Fichiers modifiés">
      <DirtyFileList git={git} noteClassName="meta" />
    </section>
  );
}

// Session en tour dans le dossier du projet : le serveur refuse alors le commit automatique (automatic-commits.ts).
function workingInProjectFolder(session: Session): boolean {
  return session.worktree === null && session.status !== 'idle' && session.status !== 'exited';
}

/** Ce qui arrêtera un commit automatique du projet, dit avant de cliquer. */
function CommitBlockers({ git, busy }: { git: GitInfo; busy: Session[] }) {
  const staged = git.staged ?? 0;
  if (busy.length === 0 && staged === 0) return null;
  return (
    <ul className="commit-blockers" aria-label="Avant de commiter">
      {busy.length > 0 ? (
        <li>
          {busy.length === 1
            ? `« ${sessionTitle(busy[0]?.title ?? '')} » travaille encore dans ce dossier`
            : `${busy.length} sessions travaillent encore dans ce dossier`}{' '}
          : le commit automatique sera refusé jusqu’à la fin de leur tour.
        </li>
      ) : null}
      {staged > 0 ? (
        <li>
          {plural(staged, 'fichier déjà indexé', 'fichiers déjà indexés')} : le commit automatique s’arrêtera s’il
          touche les mêmes lignes.
        </li>
      ) : null}
    </ul>
  );
}
