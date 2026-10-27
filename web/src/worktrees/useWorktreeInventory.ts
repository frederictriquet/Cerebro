import { useCallback, useState } from 'react';
import { parseWorktreeInventory, type WorktreeInventory } from '../../../shared/worktrees.ts';
import { api, apiParsed } from '../api.ts';
import { errorMessage } from '../format.ts';
import { usePolling } from '../polling.tsx';

const INVENTORY_REFRESH_MS = 30_000;
/** Last inventory per machine and scope, shown on remount so the panel keeps its height while it refreshes. */
const inventoryCache = new Map<string, WorktreeInventory>();
const cacheKey = (machineBase: string, path: string): string => `${machineBase}|${path}`;

/**
 * Inventory of the copies of one machine and scope, refreshed while the page is visible. The caller mounts it again
 * when the scope changes; switching machines remounts the whole tree (StoreProvider keyed by machine in App), so
 * `machineBase` only keys the module cache.
 */
export function useWorktreeInventory(path: string, machineBase: string) {
  const [inventory, setInventory] = useState<WorktreeInventory | null>(
    () => inventoryCache.get(cacheKey(machineBase, path)) ?? null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => apiParsed(path, parseWorktreeInventory), [path]);
  const refresh = usePolling(load, INVENTORY_REFRESH_MS, {
    onData: (result) => {
      inventoryCache.set(cacheKey(machineBase, path), result);
      setInventory(result);
      setLoadError(null);
    },
    onError: (cause) => setLoadError(errorMessage(cause)),
  });
  /** Forgets cleaned copies from the history; their branches and conversations are kept. */
  const forget = useCallback(
    async (ids: string[]): Promise<void> => {
      await api('/api/worktrees/history', { method: 'DELETE', body: JSON.stringify({ ids }) });
      // Invalidate other scopes on this machine too, so remounting cannot restore deleted entries.
      for (const [key, value] of inventoryCache)
        if (key.startsWith(`${machineBase}|`))
          inventoryCache.set(key, { ...value, cleaned: value.cleaned?.filter((copy) => !ids.includes(copy.id)) ?? [] });
      setInventory((current) =>
        current ? { ...current, cleaned: current.cleaned?.filter((copy) => !ids.includes(copy.id)) ?? [] } : current,
      );
      await refresh();
    },
    [machineBase, refresh],
  );
  return { inventory, loadError, refresh, forget };
}
