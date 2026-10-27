import { useState } from 'react';
import { parseGitSnapshot, type GitSnapshot } from '../../../shared/git.ts';
import type { WorktreeView } from '../../../shared/worktrees.ts';
import { ActivityStatus } from '../ActivityStatus.tsx';
import { apiParsed } from '../api.ts';
import { errorMessage, plural } from '../format.ts';
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
    setBusy(true);
    setError(null);
    try {
      const value = await apiParsed(`/api/worktrees/${view.id}/git/prepare-commit`, parseGitSnapshot, {
        method: 'POST',
      });
      setSnapshot(value);
      setChecked(new Set());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
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
          Commiter avec {plural(checked.size, 'fichier examiné', 'fichiers examinés', { zeroPlural: true })}
        </button>
      ) : null}
    </div>
  );
}
