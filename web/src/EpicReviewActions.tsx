import { useCallback, useEffect, useState } from 'react';
import { api, apiParsed } from './api.ts';
import { LaunchSessionDialog } from './Dialog.tsx';
import { useRunEvents, useStore } from './store.tsx';
import { usePolling } from './usePolling.ts';
import { parseEpicRunList, type EpicRun } from '../../shared/backlog.ts';

export const RUN_ACTIVE: EpicRun['status'][] = ['running', 'waiting-validation', 'blocked'];

// Première ligne des étapes de review ajoutées par le serveur (REVIEW_TASK_TITLE dans server/epic-review.ts, non importable côté web).
const REVIEW_TASK_TITLE = 'Code review du travail de l’epic';

// Dernier run de l'epic : chargé une fois (et à chaque reconnexion), puis suivi par les événements epic-run,
// ou relu toutes les runPollMs face à une machine qui ne les diffuse pas.
export function useEpicRun(epicId: string): { run: EpicRun | null; refresh: () => Promise<void> } {
  const { connected, runPollMs } = useStore();
  const [run, setRun] = useState<EpicRun | null>(null);
  // Une réponse REST partie avant un événement ne doit pas réafficher un état plus ancien.
  const newer = (current: EpicRun | null, next: EpicRun | null): EpicRun | null =>
    current === null || next === null ? next
      : next.id === current.id ? (next.updatedAt >= current.updatedAt ? next : current)
        : next.startedAt >= current.startedAt ? next : current;
  const fetchRuns = useCallback(() => apiParsed(`/api/epics/${epicId}/runs`, parseEpicRunList), [epicId]);
  const refresh = usePolling(fetchRuns, runPollMs, { onData: (runs) => setRun((current) => newer(current, runs[0] ?? null)) });
  useEffect(() => {
    setRun(null);
  }, [epicId]);
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);
  useRunEvents((event) => {
    if (event.type === 'epic-run' && event.run.epicId === epicId) setRun((current) => newer(current, event.run));
  });
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
