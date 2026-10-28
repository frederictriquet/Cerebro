import { useState } from 'react';
import { ActivityStatus } from '../ActivityStatus.tsx';
import { Modal } from '../Dialog.tsx';
import { branchName, copyTitle, type Confirmation } from './model.ts';

/** Last check before a merge into the target or the removal of a copy. */
export function ConfirmationDialog({
  confirmation,
  busy,
  error,
  canDeclare,
  onDeclare,
  onConfirm,
  onClose,
}: {
  confirmation: Confirmation;
  busy: boolean;
  error: string | null;
  /** The project of the copy is known here: its regenerable paths can be extended. */
  canDeclare: boolean;
  onDeclare: (entry: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { view, deleteIgnored } = confirmation;
  const [acknowledged, setAcknowledged] = useState(false);
  const hidden = (view.ignored ?? 0) - view.ignoredFiles.length;
  return (
    <Modal
      title={
        confirmation.kind === 'merge'
          ? `Intégrer dans ${branchName(confirmation.view.targetBranch)}`
          : 'Retirer la copie de travail'
      }
      onClose={onClose}
    >
      <p>{copyTitle(confirmation.view)}</p>
      <p>Copie : {confirmation.view.path}</p>
      <p>
        Projet cible : {confirmation.view.targetPath} · {branchName(confirmation.view.targetBranch)}
      </p>
      {confirmation.kind === 'merge' ? (
        <>
          <p>
            Les commits de cette copie seront intégrés au projet par un merge. Les contrôles Git habituels s’appliquent.
          </p>
          {confirmation.view.integrationConflicts?.length ? (
            <p className="worktree-warning">
              Conflits prévus dans {confirmation.view.integrationConflicts.join(', ')} : ils resteront à résoudre dans{' '}
              {confirmation.view.targetPath}. Pour les résoudre plutôt dans la copie, annulez et utilisez « Mettre à
              jour avec {branchName(confirmation.view.targetBranch)} ».
            </p>
          ) : null}
          <p>
            Ensuite, publiez avec « Push » dans l’en-tête du projet. La conversation peut continuer dans sa copie ; ses
            nouveaux changements pourront être intégrés plus tard.
          </p>
        </>
      ) : (
        <>
          <p>
            La copie propre et intégrée sera retirée. Sa branche, ses commits et la conversation seront conservés. Cette
            conversation ne pourra plus reprendre dans la copie supprimée.
          </p>
          {deleteIgnored ? (
            <div className="worktree-warning">
              <p>
                Ces fichiers ignorés par Git n’existent que dans la copie et seront supprimés définitivement avec elle.
                {canDeclare
                  ? ' Un chemin qu’une compilation ou une installation recrée peut être déclaré régénérable : les prochaines copies du projet le supprimeront sans demander, y compris au nettoyage automatique.'
                  : ''}
              </p>
              <ul className="worktree-ignored-list">
                {view.ignoredFiles.map((entry) => (
                  <li key={entry}>
                    <code>{entry}</code>
                    {canDeclare ? (
                      <button type="button" className="btn" disabled={busy} onClick={() => onDeclare(entry)}>
                        Déclarer régénérable
                      </button>
                    ) : null}
                  </li>
                ))}
                {hidden > 0 ? <li>… et {hidden} autre(s)</li> : null}
              </ul>
              <label className="worktree-reviewed">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                Supprimer définitivement ces fichiers ignorés
              </label>
            </div>
          ) : null}
        </>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row-actions">
        <button
          type="button"
          className={`btn ${confirmation.kind === 'merge' ? 'primary' : 'danger-ghost'}`}
          disabled={busy || (deleteIgnored && !acknowledged)}
          onClick={onConfirm}
        >
          <ActivityStatus active={busy}>
            {busy
              ? confirmation.kind === 'merge'
                ? 'Intégration…'
                : 'Retrait de la copie…'
              : confirmation.kind === 'merge'
                ? `Intégrer dans ${branchName(confirmation.view.targetBranch)}`
                : 'Retirer la copie'}
          </ActivityStatus>
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Annuler
        </button>
      </div>
    </Modal>
  );
}
