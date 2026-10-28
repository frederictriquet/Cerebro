import { useCallback, useEffect, useState } from 'react';
import { parseWorktreeInventory, type WorktreeInventory } from '../../../shared/worktrees.ts';
import { api, apiBase, apiParsed } from '../api.ts';
import { errorMessage } from '../format.ts';
import { usePolling } from '../polling.tsx';
import { cachedInventory, cacheInventory, forgetCachedCopies, GLOBAL_INVENTORY_PATH } from './inventory-cache.ts';

const INVENTORY_REFRESH_MS = 30_000;

/**
 * Inventory of the copies of one machine and scope, refreshed while the page is visible. The caller mounts it again
 * when the scope changes; switching machines remounts the whole tree (StoreProvider keyed by machine in App), so
 * `machineBase` only keys the module cache.
 */
export function useWorktreeInventory(path: string, machineBase: string, projectId?: string) {
  const [inventory, setInventory] = useState<WorktreeInventory | null>(() =>
    cachedInventory(machineBase, path, projectId),
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => apiParsed(path, parseWorktreeInventory), [path]);
  const refresh = usePolling(load, INVENTORY_REFRESH_MS, {
    onData: (result) => {
      cacheInventory(machineBase, path, result);
      setInventory(result);
      setLoadError(null);
    },
    onError: (cause) => setLoadError(errorMessage(cause)),
  });
  /** Forgets cleaned copies from the history; their branches and conversations are kept. */
  const forget = useCallback(
    async (ids: string[]): Promise<void> => {
      await api('/api/worktrees/history', { method: 'DELETE', body: JSON.stringify({ ids }) });
      forgetCachedCopies(machineBase, ids);
      setInventory((current) =>
        current ? { ...current, cleaned: current.cleaned.filter((copy) => !ids.includes(copy.id)) } : current,
      );
      await refresh();
    },
    [machineBase, refresh],
  );
  return { inventory, loadError, refresh, forget };
}

/**
 * Loads the global inventory once per machine mount, so the first visit to each project starts from its share of it
 * instead of an empty panel. A failure is ignored: the project panel loads its own inventory anyway.
 */
export function usePrefetchWorktreeInventory(): void {
  useEffect(() => {
    const machineBase = apiBase();
    void apiParsed(GLOBAL_INVENTORY_PATH, parseWorktreeInventory)
      .then((result) => cacheInventory(machineBase, GLOBAL_INVENTORY_PATH, result))
      .catch(() => undefined);
  }, []);
}
