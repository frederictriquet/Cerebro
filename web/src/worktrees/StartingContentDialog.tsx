import { useEffect, useState } from 'react';
import { normalizeMode, parseSession } from '../../../shared/types.ts';
import {
  parseStartingContentDiscard,
  parseStartingContentPlan,
  type StartingContentDiscard,
  type StartingContentPlan,
  type StartingContentStep,
  type WorktreeView,
} from '../../../shared/worktrees.ts';
import { ActivityStatus } from '../ActivityStatus.tsx';
import { apiParsed } from '../api.ts';
import { useAsyncAction } from '../async-action.ts';
import { Modal } from '../Dialog.tsx';
import { AGENT_LABEL, errorMessage, MODE_CHIP } from '../format.ts';
import { useStore } from '../store.tsx';
import { branchName, copyTitle, originLabel, type Resolver } from './model.ts';

const ACTION_LABEL: Record<StartingContentStep['action'], string> = {
  restore: 'remis à l’état de la copie',
  separate: 'seul le travail fait depuis la création est gardé',
  settle: 'rattaché tel quel au travail de la conversation',
  keep: 'laissé tel quel, à examiner',
};
/** Preview, then removal of the content copied from the project when the copy was created. */
export function StartingContentDialog({
  view,
  onClose,
  onDone,
  onResolving,
}: {
  view: WorktreeView;
  onClose: () => void;
  onDone: (result: StartingContentDiscard) => void;
  onResolving: (session: Resolver) => void;
}) {
  const { projects } = useStore();
  const settings = projects.find((project) => project.id === view.projectId)?.resolutionSettings;
  const [plan, setPlan] = useState<StartingContentPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Kept files checked as holding only the conversation's work, with the content they were checked with.
  const [confirmed, setConfirmed] = useState<Map<string, string>>(() => new Map());
  const target = branchName(view.targetBranch);
  // No apiBase() check: switching machines remounts the whole tree (StoreProvider keyed by machine in App).
  const discard = useAsyncAction(
    async () => {
      const result = await apiParsed(`/api/worktrees/${view.id}/discard-inherited`, parseStartingContentDiscard, {
        method: 'POST',
        body: JSON.stringify({ confirmed: [...confirmed].map(([path, version]) => ({ path, version })) }),
      });
      onDone(result);
    },
    { onError: setError },
  );
  // The files left for a manual review go to a session working in the copy, with the project's LLM settings.
  const resolution = useAsyncAction(
    async () => {
      const session = await apiParsed(`/api/worktrees/${view.id}/resolve-starting-content`, parseSession, {
        method: 'POST',
      });
      onResolving(session);
    },
    { onError: setError },
  );
  const busy = loading ? 'loading' : discard.busy ? 'running' : resolution.busy ? 'resolving' : null;
  useEffect(() => {
    let disposed = false;
    apiParsed(`/api/worktrees/${view.id}/starting-content`, parseStartingContentPlan)
      .then((value) => {
        if (!disposed) setPlan(value);
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [view.id]);
  const run = discard.run;
  const resolve = resolution.run;
  const actionable = plan?.steps.some((step) => step.action !== 'keep') || confirmed.size > 0;
  const confirm = (step: StartingContentStep, checked: boolean): void =>
    setConfirmed((current) => {
      const next = new Map(current);
      if (checked && step.version) next.set(step.path, step.version);
      else next.delete(step.path);
      return next;
    });
  const toReview = plan?.steps.filter((step) => step.action === 'keep').length ?? 0;
  return (
    <Modal title="Retirer le contenu de départ" onClose={onClose}>
      <p>{copyTitle(view)}</p>
      <p className="meta">
        À sa création, la copie a reçu les fichiers alors non commités du dossier du projet. Ce contenu n’est pas le
        travail de la conversation : le retirer laisse dans la copie uniquement ce qu’elle a changé. Le dossier du
        projet n’est pas modifié.
      </p>
      {busy === 'loading' ? (
        <p>
          <ActivityStatus active>Analyse des fichiers…</ActivityStatus>
        </p>
      ) : null}
      {plan?.targetUpdate ? (
        <p className="worktree-notice">
          La copie reçoit d’abord{' '}
          {plan.targetUpdate.commits === 1 ? 'le nouveau commit' : `les ${plan.targetUpdate.commits} nouveaux commits`}{' '}
          de {branchName(plan.targetUpdate.branch)} (un commit de merge) : le travail gardé s’applique ainsi à la
          version à jour des fichiers.
        </p>
      ) : null}
      {plan ? (
        <ul className="worktree-plan">
          {plan.steps.map((step) => (
            <li key={step.path} className={`worktree-plan-${step.action}`}>
              <code>{step.path}</code> — {ACTION_LABEL[step.action]}
              <div className="meta">Contenu de départ : {originLabel(step.origin, target)}</div>
              {step.reason ? (
                <div className={step.action === 'keep' ? 'worktree-warning' : 'meta'}>{step.reason}</div>
              ) : null}
              {step.diff ? (
                <details>
                  <summary>{step.action === 'keep' ? 'Changements non commités' : 'Travail gardé'}</summary>
                  <pre>{step.diff}</pre>
                </details>
              ) : null}
              {step.action === 'keep' && step.state === 'mixed' && step.version ? (
                <label className="worktree-reviewed">
                  <input
                    type="checkbox"
                    checked={confirmed.has(step.path)}
                    disabled={busy !== null}
                    onChange={(event) => confirm(step, event.target.checked)}
                  />{' '}
                  Vérifié : ne contient que le travail de la conversation
                </label>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {plan && !actionable ? (
        <p className="worktree-warning">
          Aucun fichier ne peut être traité automatiquement : examinez leurs changements, puis cochez ceux qui ne
          contiennent que le travail de la conversation{toReview ? ', ou confiez-les à l’IA' : ''}.
        </p>
      ) : null}
      {toReview ? (
        <p className="meta">
          « Résoudre avec l’IA » lance une session dans la copie pour séparer le contenu de départ du travail de la
          conversation dans {toReview === 1 ? 'le fichier laissé' : `les ${toReview} fichiers laissés`} à examiner. Elle
          ne commite rien : relisez ensuite ses changements, puis retirez le contenu de départ restant.
          {settings
            ? ` Session : ${AGENT_LABEL[settings.agent]} · ${settings.model ?? 'modèle par défaut'} · ${settings.effort ?? 'effort par défaut'} · ${MODE_CHIP[normalizeMode(settings.mode)]} (« Réglages LLM » du projet).`
            : ''}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row-actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy !== null || !actionable}
          onClick={() => void run()}
        >
          <ActivityStatus active={busy === 'running'}>
            {busy === 'running' ? 'Retrait du contenu de départ…' : 'Retirer le contenu de départ'}
          </ActivityStatus>
        </button>
        {toReview ? (
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void resolve()}>
            <ActivityStatus active={busy === 'resolving'}>
              {busy === 'resolving' ? 'Lancement de la session…' : 'Résoudre avec l’IA'}
            </ActivityStatus>
          </button>
        ) : null}
        <button type="button" className="btn" disabled={busy === 'running' || busy === 'resolving'} onClick={onClose}>
          Annuler
        </button>
      </div>
    </Modal>
  );
}
