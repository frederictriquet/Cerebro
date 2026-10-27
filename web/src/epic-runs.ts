import { useCallback, useEffect, useState } from 'react';
import type { EpicRunRecord, EpicRunView } from '../../server/epic-runner.ts';
import { api, markOperationSeen } from './api.ts';

export const RUN_ACTIVE: EpicRunRecord['status'][] = ['running', 'waiting-validation', 'blocked'];

// Dernière exécution de l'epic, relue périodiquement : les exécutions ne passent pas par le store.
export function useEpicRun(
  epicId: string,
  intervalMs = 1000,
): { run: EpicRunView | null; refresh: () => Promise<void> } {
  const [run, setRun] = useState<EpicRunView | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    const runs = await api<EpicRunView[]>(`/api/epics/${epicId}/runs`);
    setRun(runs[0] ?? null);
  }, [epicId]);
  useEffect(() => {
    void refresh().catch(() => {});
    const timer = window.setInterval(() => void refresh().catch(() => {}), intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, intervalMs]);
  return { run, refresh };
}

// L'état affiché de l'exécution a été vu : il ne doit plus être notifié.
export function markEpicRunSeen(run: EpicRunView): void {
  markOperationSeen(`epic:${run.id}:${run.status}`);
}

// Arrêter ou reprendre (en recalculant le plan) vaut lecture de l'état courant.
export function controlEpicRun(run: EpicRunView, action: 'stop' | 'resume'): Promise<unknown> {
  markEpicRunSeen(run);
  return api(`/api/epic-runs/${run.id}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ replan: action === 'resume' }),
  });
}

export function setEpicRunAutoValidation(runId: string, enabled: boolean): Promise<unknown> {
  return api(`/api/epic-runs/${runId}/auto-validation`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
}
