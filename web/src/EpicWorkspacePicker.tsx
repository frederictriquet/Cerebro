import { useEffect, useState, type FormEvent } from 'react';
import type { EpicWorkspaceOptions } from '../../server/epic-workspace.ts';
import { api } from './api.ts';
import { useAsyncAction } from './async-action.ts';
import { href } from './route.ts';
import { errorMessage, plural } from './format.ts';

export function EpicWorkspacePicker({ epicId, onResolved }: { epicId: string; onResolved: () => Promise<void> }) {
  const [options, setOptions] = useState<EpicWorkspaceOptions | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run: keep, busy: pending } = useAsyncAction(async (chosen: string) => {
    await api(`/api/epics/${epicId}/workspace`, {method:'POST', body:JSON.stringify({path: chosen})});
    await onResolved();
  }, { onError: setError });
  useEffect(() => {
    let active = true;
    setOptions(null); setPath(''); setError(null);
    void api<EpicWorkspaceOptions>(`/api/epics/${epicId}/workspace-options`)
      .then(result => { if (active) setOptions(result); })
      .catch(cause => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [epicId]);
  const choose = (event: FormEvent): void => {
    event.preventDefault();
    if (!path || pending) return;
    void keep(path);
  };
  return (
    <form className="epic-workspace-picker" onSubmit={choose}>
      <strong>Choisir le dossier de l’epic</strong>
      <p>Plusieurs dossiers ont été utilisés. Vérifiez leurs changements avant de choisir où poursuivre.
        Les tâches terminées gardent leur statut ; les changements des autres dossiers ne sont pas transférés.</p>
      {!options && !error ? <p role="status">Chargement des dossiers…</p> : null}
      {options?.choices.map(choice => (
        <div className="epic-workspace-choice" key={choice.path}>
          <label>
            <input type="radio" name={`epic-workspace-${epicId}`} value={choice.path} checked={path === choice.path}
              disabled={pending || !!choice.unavailableReason || !options.conflict} onChange={() => setPath(choice.path)} />
            <span><strong>{choice.mode === 'isolated' ? 'Worktree' : 'Dossier du projet'}</strong><code>{choice.path}</code></span>
          </label>
          {choice.unavailableReason ? <p className="form-error">{choice.unavailableReason}</p> : (
            <p>{choice.branch ? `Branche ${choice.branch}` : choice.head ? 'HEAD détachée' : 'Dossier sans Git'}
              {choice.head ? ` · ${choice.head.slice(0, 8)}` : ''}
              {choice.changes ? ` · ${plural(choice.changes.length, 'fichier modifié', 'fichiers modifiés')}` : ' · État des fichiers indisponible'}</p>
          )}
          {choice.changes && choice.changes.length > 0 ? (
            <details><summary>Voir les fichiers modifiés</summary><ul>
              {choice.changes.map((change, index) => <li key={index}><code>{change}</code></li>)}
            </ul></details>
          ) : null}
          {choice.sessions.length > 0 ? (
            <details><summary>Sessions dans ce dossier ({choice.sessions.length})</summary><ul>
              {choice.sessions.map(session => <li key={session.id}><a href={href(`#/s/${session.id}`)}>{session.title}</a></li>)}
            </ul></details>
          ) : null}
        </div>
      ))}
      {options?.conflict ? (
        <button type="submit" className="btn primary" disabled={!path || pending}>Conserver ce dossier pour l’epic</button>
      ) : options ? <p>Le dossier a déjà été choisi. Actualisez l’epic pour poursuivre.</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </form>
  );
}
