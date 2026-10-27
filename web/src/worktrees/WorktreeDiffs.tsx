import { useState } from 'react';
import type { GitSnapshot } from '../../../server/git-plan.ts';
import type { WorktreeView } from '../../../server/worktrees.ts';
import { ActivityStatus } from '../ActivityStatus.tsx';
import { api, apiBase } from '../api.ts';
import type { Reviewed } from './model.ts';

export function WorktreeDiffs({
  view,
  onCommitReviewed,
}: {
  view: WorktreeView;
  onCommitReviewed?: (reviewed: Reviewed) => void;
}) {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async (): Promise<void> => {
    const machine = apiBase();
    setBusy(true);
    setError(null);
    try {
      const value = await api<GitSnapshot>(`/api/worktrees/${view.id}/git/prepare-commit`, { method: 'POST' });
      if (machine === apiBase()) {
        setSnapshot(value);
        setChecked(new Set());
      }
    } catch (cause) {
      if (machine === apiBase()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (machine === apiBase()) setBusy(false);
    }
  };
  const files = snapshot?.files.filter(
    (file) => !view.changesSinceCreation || view.changesSinceCreation.files.includes(file.path),
  );
  return (
    <div className="worktree-diffs">
      <button type="button" className="btn" disabled={busy} onClick={() => void load()}>
        <ActivityStatus active={busy}>
          {busy ? 'Lecture des changements…' : snapshot ? 'Actualiser les diffs' : 'Voir les diffs'}
        </ActivityStatus>
      </button>
      {error ? <p className="form-error">{error}</p> : null}
      {snapshot ? (
        <p className="meta">
          Diffs par rapport au dernier commit de la copie : pour les fichiers modifiés avant sa création, ils
          contiennent aussi le contenu de départ.
        </p>
      ) : null}
      {snapshot && onCommitReviewed ? (
        <p className="meta">
          Cochez les fichiers dont vous avez lu le diff : le commit les inclura tant que leur contenu reste celui
          affiché.
        </p>
      ) : null}
      {files?.map((file) => (
        <details key={file.path}>
          <summary>
            {file.path}
            {file.blocked ? ' — secret détecté' : file.warnings.length ? ' — à examiner' : ''}
          </summary>
          {file.blocked ? (
            <p>Contenu masqué : le scanner a détecté un secret.</p>
          ) : (
            <>
              {onCommitReviewed ? (
                <label className="worktree-reviewed">
                  <input
                    type="checkbox"
                    checked={checked.has(file.path)}
                    onChange={(event) =>
                      setChecked((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(file.path);
                        else next.delete(file.path);
                        return next;
                      })
                    }
                  />{' '}
                  Examiné : inclure dans le commit
                </label>
              ) : null}
              <pre>{file.diff}</pre>
            </>
          )}
        </details>
      ))}
      {snapshot && onCommitReviewed ? (
        <button
          type="button"
          className="btn"
          disabled={!checked.size}
          onClick={() => onCommitReviewed({ snapshotId: snapshot.id, paths: [...checked] })}
        >
          Commiter avec {checked.size} fichier{checked.size === 1 ? '' : 's'} examiné{checked.size === 1 ? '' : 's'}
        </button>
      ) : null}
    </div>
  );
}
