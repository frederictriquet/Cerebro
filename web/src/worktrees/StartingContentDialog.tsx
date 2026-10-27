import { useEffect, useState } from 'react';
import type { StartingContentPlan, StartingContentStep, WorktreeView } from '../../../server/worktrees.ts';
import { ActivityStatus } from '../ActivityStatus.tsx';
import { api, apiBase } from '../api.ts';
import { Modal } from '../Dialog.tsx';
import { AGENT_LABEL, MODE_CHIP } from '../format.ts';
import { useStore } from '../store.tsx';
import type { Session } from '../types.ts';
import { branchName, copyTitle, originLabel, type DiscardResult, type Resolver } from './model.ts';

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
  onDone: (result: DiscardResult) => void;
  onResolving: (session: Resolver) => void;
}) {
  const [machineBase] = useState(apiBase);
  const { projects } = useStore();
  const settings = projects.find((project) => project.id === view.projectId)?.resolutionSettings;
  const [plan, setPlan] = useState<StartingContentPlan | null>(null);
  const [busy, setBusy] = useState<'loading' | 'running' | 'resolving' | null>('loading');
  const [error, setError] = useState<string | null>(null);
  // Kept files checked as holding only the conversation's work, with the content they were checked with.
  const [confirmed, setConfirmed] = useState<Map<string, string>>(() => new Map());
  const target = branchName(view.targetBranch);
  useEffect(() => {
    let disposed = false;
    api<StartingContentPlan>(`/api/worktrees/${view.id}/starting-content`)
      .then((value) => {
        if (!disposed && apiBase() === machineBase) setPlan(value);
      })
      .catch((cause) => {
        if (!disposed && apiBase() === machineBase) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!disposed && apiBase() === machineBase) setBusy(null);
      });
    return () => {
      disposed = true;
    };
  }, [view.id, machineBase]);
  const run = async (): Promise<void> => {
    setBusy('running');
    setError(null);
    try {
      const result = await api<DiscardResult>(`/api/worktrees/${view.id}/discard-inherited`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: [...confirmed].map(([path, version]) => ({ path, version })) }),
      });
      if (apiBase() === machineBase) onDone(result);
    } catch (cause) {
      if (apiBase() === machineBase) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (apiBase() === machineBase) setBusy(null);
    }
  };
  // The files left for a manual review go to a session working in the copy, with the project's LLM settings.
  const resolve = async (): Promise<void> => {
    setBusy('resolving');
    setError(null);
    try {
      const session = await api<Session>(`/api/worktrees/${view.id}/resolve-starting-content`, { method: 'POST' });
      if (apiBase() === machineBase) onResolving(session);
    } catch (cause) {
      if (apiBase() === machineBase) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (apiBase() === machineBase) setBusy(null);
    }
  };
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
            ? ` Session : ${AGENT_LABEL[settings.agent]} · ${settings.model ?? 'modèle par défaut'} · ${settings.effort ?? 'effort par défaut'} · ${MODE_CHIP[settings.mode]} (« Réglages LLM » du projet).`
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
