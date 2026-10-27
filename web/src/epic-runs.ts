import { useCallback, useEffect, useState } from 'react';
import { api, apiParsed, apiPath, markOperationSeen } from './api.ts';
import { usePolling } from './polling.tsx';
import { useRunEvents, useStore } from './store.tsx';
import { ACTIVE_RUN_STATUSES, parseEpicRunList, type EpicRun } from '../../shared/backlog.ts';

// Exécutions qui occupent encore l'epic : définition unique dans shared/backlog.ts.
export const RUN_ACTIVE = ACTIVE_RUN_STATUSES;

// Dernier run de l'epic : chargé une fois (et à chaque reconnexion), puis suivi par les événements epic-run,
// ou relu toutes les runPollMs face à une machine qui ne les diffuse pas.
export function useEpicRun(epicId: string): { run: EpicRun | null; refresh: () => Promise<void> } {
  const { connected, runPollMs } = useStore();
  const [run, setRun] = useState<EpicRun | null>(null);
  // Une réponse REST partie avant un événement ne doit pas réafficher un état plus ancien.
  const newer = (current: EpicRun | null, next: EpicRun | null): EpicRun | null =>
    current === null || next === null
      ? next
      : next.id === current.id
        ? next.updatedAt >= current.updatedAt
          ? next
          : current
        : next.startedAt >= current.startedAt
          ? next
          : current;
  const fetchRuns = useCallback(() => apiParsed(apiPath`/api/epics/${epicId}/runs`, parseEpicRunList), [epicId]);
  const refresh = usePolling(fetchRuns, runPollMs ?? 0, {
    enabled: runPollMs !== null,
    onData: (runs) => setRun((current) => newer(current, runs[0] ?? null)),
    // Un échec attend la relecture suivante (minuteur, reconnexion ou événement).
    onError: () => {},
  });
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

// L'état affiché de l'exécution a été vu : il ne doit plus être notifié.
export function markEpicRunSeen(run: EpicRun): void {
  markOperationSeen(`epic:${run.id}:${run.status}`);
}

// Arrêter ou reprendre (en recalculant le plan) vaut lecture de l'état courant.
export function controlEpicRun(run: EpicRun, action: 'stop' | 'resume'): Promise<unknown> {
  markEpicRunSeen(run);
  return api(apiPath`/api/epic-runs/${run.id}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ replan: action === 'resume' }),
  });
}

export function setEpicRunAutoValidation(runId: string, enabled: boolean): Promise<unknown> {
  return api(apiPath`/api/epic-runs/${runId}/auto-validation`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
}
