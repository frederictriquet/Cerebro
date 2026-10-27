import { ActivityStatus } from './ActivityStatus.tsx';
import { useCallback, useId, useState } from 'react';
import { api } from './api.ts';
import { plural } from './format.ts';
import { GitActions } from './GitActions.tsx';
import { usePolling } from './polling.tsx';
import { parseGitInfo, type GitInfo } from './types.ts';

export function GitStatus({ projectId }: { projectId: string }) {
  const [git, setGit] = useState<GitInfo | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewId = useId();

  const load = useCallback(async (): Promise<GitInfo> => {
    const raw = await api<unknown>(`/api/projects/${projectId}/git${expanded ? '?commits=true' : ''}`);
    const parsed = parseGitInfo(raw);
    if (!parsed) throw new Error('Réponse Git invalide');
    return parsed;
  }, [projectId, expanded]);
  usePolling(load, 10_000, {
    onData: (parsed) => {
      setGit(parsed);
      setPreviewError(expanded && !parsed.pendingCommits && !parsed.pendingCommitsError && (parsed.ahead ?? 0) > 0
        ? 'Aperçu indisponible sur cette machine.' : null);
    },
    onError: () => {
      if (expanded) setPreviewError('Impossible de charger les commits. Nouvelle tentative dans quelques instants.');
    },
  });

  if (!git) return null;
  if (git.branch === null) return <p className="git-line meta">Pas un dépôt git</p>;
  const count = git.ahead ?? 0;
  const preview = git.pendingCommits;
  const error = git.pendingCommitsError ?? previewError;
  return <>
    <div className="git-line">
      <span className="pill">{git.branch}</span>
      <GitActions projectId={projectId} git={git} pendingCommits={count > 0 ? <button type="button" className="git-ahead-toggle" aria-expanded={expanded} aria-controls={previewId}
        onClick={() => { setExpanded(value => !value); setPreviewError(null); }}>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {plural(count, 'commit')} à pousser
      </button> : null} />
    </div>
    {expanded && count > 0 ? <section id={previewId} className="git-pending-preview" aria-label="Commits à pousser">
      {error ? <p className="form-error" role="alert">{error}</p> : preview ? <>
        <p className="meta">Commits locaux absents de <strong>{preview.upstream}</strong></p>
        <ol className="git-pending-list">
          {preview.commits.map(commit => <li key={commit.hash}>
            <code title={commit.hash}>{commit.hash.slice(0, 8)}</code>
            <span className="git-commit-subject">{commit.subject}</span>
            <span className="meta git-commit-author">Auteur : {commit.author}</span>
          </li>)}
        </ol>
        {preview.truncated ? <p className="meta">Les {preview.commits.length} commits les plus récents sont affichés sur {count}.</p> : null}
      </> : <p className="meta"><ActivityStatus>Chargement des commits…</ActivityStatus></p>}
    </section> : null}
  </>;
}
