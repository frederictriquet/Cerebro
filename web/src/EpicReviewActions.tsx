import { useCallback, useEffect, useState } from 'react';
import { api, apiParsed } from './api.ts';
import { LaunchSessionDialog } from './Dialog.tsx';
import { useStore } from './store.tsx';
import { parseEpicRunList, type EpicRun } from '../../shared/backlog.ts';

export const RUN_ACTIVE: EpicRun['status'][] = ['running', 'waiting-validation', 'blocked'];

// Première ligne des étapes de review ajoutées par le serveur (REVIEW_TASK_TITLE dans server/epic-review.ts, non importable côté web).
const REVIEW_TASK_TITLE = 'Code review du travail de l’epic';

export function useEpicRun(epicId: string, intervalMs = 1000): { run: EpicRun | null; refresh: () => Promise<void> } {
  const [run, setRun] = useState<EpicRun | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    const runs = await apiParsed(`/api/epics/${epicId}/runs`, parseEpicRunList);
    setRun(runs[0] ?? null);
  }, [epicId]);
  useEffect(() => {
    void refresh().catch(() => {});
    const timer = window.setInterval(() => void refresh().catch(() => {}), intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, intervalMs]);
  return { run, refresh };
}

// « Review de l'epic » et « Ajouter une étape de review » : partagés par le bloc du backlog et l'en-tête du groupe de sessions.
export function EpicReviewActions({ epic, run, onError }: {
  epic: { id: string; projectId: string; title: string };
  run: EpicRun | null;
  onError: (message: string) => void;
}) {
  const { tasks, projects } = useStore();
  const [reviewing, setReviewing] = useState(false);
  const workspaceMode = run?.workspace ? run.workspace.mode === 'isolated' ? 'isolated' : 'shared' : projects.find((p) => p.id === epic.projectId)?.workspaceMode ?? 'isolated';
  const members = tasks.filter((t) => t.epicId === epic.id && t.projectId === epic.projectId);
  // Une review porte sur le travail d'une exécution terminée, arrêtée ou échouée, jamais d'une exécution en cours.
  const canReview = run !== null && !RUN_ACTIVE.includes(run.status);
  const hasOpenReviewStep = members.some((t) => t.status !== 'done' && t.text.split('\n')[0] === REVIEW_TASK_TITLE);
  return (
    <>
      {canReview ? (
        <button type="button" className="btn" title="Une session relit tout ce que les étapes ont modifié, dans leur worktree" onClick={() => setReviewing(true)}>
          Review de l'epic
        </button>
      ) : null}
      {members.length > 0 && !hasOpenReviewStep ? (
        <button
          type="button"
          className="btn"
          title="Ajoute une dernière tâche de review, qui attend toutes les autres et travaille dans le même worktree"
          onClick={() => void api(`/api/epics/${epic.id}/review-task`, { method: 'POST' }).catch((err: unknown) => onError(err instanceof Error ? err.message : 'Ajout impossible'))}
        >
          Ajouter une étape de review
        </button>
      ) : null}
      {reviewing ? (
        <LaunchSessionDialog
          title={`Review de l'epic : ${epic.title.slice(0, 80)}`}
          projectId={epic.projectId}
          epicId={epic.id}
          initialPrompt="Cherche les bugs dans le travail de l'epic."
          submitLabel={`Lancer la review ${workspaceMode === 'shared' ? "dans le dossier d’origine de l’epic" : "dans le worktree de l'epic"}`}
          onClose={() => setReviewing(false)}
          onLaunch={async (spec) => {
            await api(`/api/epics/${epic.id}/review`, { method: 'POST', body: JSON.stringify(spec) });
            setReviewing(false);
          }}
        />
      ) : null}
    </>
  );
}
