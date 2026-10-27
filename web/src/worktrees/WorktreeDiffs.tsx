import { useState } from 'react';
import { parseGitSnapshot, SECRET_WARNING, type GitSecret, type GitSnapshot } from '../../../shared/git.ts';
import type { WorktreeView } from '../../../shared/worktrees.ts';
import { ActivityStatus } from '../ActivityStatus.tsx';
import { apiParsed } from '../api.ts';
import { errorMessage, plural } from '../format.ts';
import type { Reviewed } from './model.ts';

const SECRET_KIND: Record<GitSecret['kind'], string> = {
  'private-key': 'clé privée',
  aws: 'clé d’accès AWS',
  github: 'jeton GitHub',
  openai: 'clé OpenAI',
};
const toggle = (current: Set<string>, path: string, on: boolean): Set<string> => {
  const next = new Set(current);
  if (on) next.add(path);
  else next.delete(path);
  return next;
};
/** Copies commit without pushing; the project's own folder (primary worktree) pushes right after. */
const overrideWarning = (path: string, push: boolean): string =>
  `${path} sera commité avec le motif détecté, et son diff transmis à l’IA qui rédige le message.` +
  (push
    ? ' Ce commit sera ensuite poussé vers les remotes.'
    : ' Il partira vers les remotes au prochain push de la branche.') +
  ' Ne confirmez que si ce n’est pas un secret réel.';

export function WorktreeDiffs({
  view,
  onCommitReviewed,
}: {
  view: WorktreeView;
  onCommitReviewed?: (reviewed: Reviewed) => void;
}) {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [overrides, setOverrides] = useState<Set<string>>(() => new Set());
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
      // Ticks belong to the diffs shown: a new snapshot starts with none, overrides included.
      setChecked(new Set());
      setOverrides(new Set());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const selected = new Set([...checked, ...overrides]);
  const reviewedBox = (path: string) => (
    <label className="worktree-reviewed">
      <input
        type="checkbox"
        checked={checked.has(path)}
        onChange={(event) => setChecked((current) => toggle(current, path, event.target.checked))}
      />{' '}
      Examiné : inclure dans le commit
    </label>
  );
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
          affiché. Un fichier où un secret est détecté reste exclu, sauf dérogation explicite de sa propre case.
        </p>
      ) : null}
      {files?.map((file) => {
        const others = file.warnings.filter((warning) => warning !== SECRET_WARNING);
        const diff = <pre>{file.diff}</pre>;
        return (
          <details key={file.path}>
            <summary>
              {file.path}
              {file.blocked ? ' — secret détecté' : file.warnings.length ? ' — à examiner' : ''}
            </summary>
            {file.blocked ? (
              <>
                <p>Le scanner a reconnu :</p>
                <ul>
                  {file.secrets.map((secret, index) => (
                    <li key={index}>
                      ligne {secret.line} · {SECRET_KIND[secret.kind]} · <code>{secret.excerpt}</code>
                    </li>
                  ))}
                </ul>
                {onCommitReviewed ? (
                  <label className="worktree-reviewed">
                    <input
                      type="checkbox"
                      checked={overrides.has(file.path)}
                      onChange={(event) => {
                        if (event.target.checked && !window.confirm(overrideWarning(file.path, view.primary))) return;
                        setOverrides((current) => toggle(current, file.path, event.target.checked));
                      }}
                    />{' '}
                    Ce n’est pas un secret réel (donnée de test, exemple) : inclure malgré la détection
                  </label>
                ) : null}
                {onCommitReviewed && others.length ? (
                  <>
                    <p className="meta">{others.join(' ; ')}</p>
                    {reviewedBox(file.path)}
                  </>
                ) : null}
                <details>
                  <summary>Afficher le diff (contient le motif détecté)</summary>
                  {diff}
                </details>
              </>
            ) : (
              <>
                {onCommitReviewed ? reviewedBox(file.path) : null}
                {diff}
              </>
            )}
          </details>
        );
      })}
      {snapshot && onCommitReviewed ? (
        <button
          type="button"
          className="btn"
          disabled={!selected.size}
          onClick={() => onCommitReviewed({ snapshotId: snapshot.id, paths: [...checked], secrets: [...overrides] })}
        >
          Commiter avec {plural(selected.size, 'fichier examiné', 'fichiers examinés', { zeroPlural: true })}
        </button>
      ) : null}
    </div>
  );
}
