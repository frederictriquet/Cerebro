import { useCallback, useEffect, useState } from 'react';
import type { WorktreeInventory } from '../../../server/worktrees.ts';
import { api, apiBase } from '../api.ts';

const INVENTORY_REFRESH_MS = 30_000;
/** Last inventory per machine and scope, shown on remount so the panel keeps its height while it refreshes. */
const inventoryCache = new Map<string, WorktreeInventory>();
const cacheKey = (machineBase: string, path: string): string => `${machineBase}|${path}`;

/**
 * Inventory of the copies of one machine and scope, refreshed while the page is visible. The caller mounts it again
 * when the machine or the scope changes.
 */
export function useWorktreeInventory(path: string, machineBase: string) {
  const [inventory, setInventory] = useState<WorktreeInventory | null>(
    () => inventoryCache.get(cacheKey(machineBase, path)) ?? null,
  );
  const [loadedBase, setLoadedBase] = useState<string | null>(() =>
    inventoryCache.has(cacheKey(machineBase, path)) ? machineBase : null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await api<WorktreeInventory>(path);
      if (apiBase() === machineBase) {
        inventoryCache.set(cacheKey(machineBase, path), result);
        setInventory(result);
        setLoadedBase(machineBase);
        setLoadError(null);
      }
    } catch (cause) {
      if (apiBase() === machineBase) setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [path, machineBase]);
  useEffect(() => {
    let disposed = false;
    let loading = false;
    let timer: number | undefined;
    const load = async (): Promise<void> => {
      if (disposed || loading) return;
      loading = true;
      timer = undefined;
      try {
        if (!document.hidden) await refresh();
      } finally {
        loading = false;
        if (!disposed) timer = window.setTimeout(() => void load(), INVENTORY_REFRESH_MS);
      }
    };
    const visible = (): void => {
      if (!document.hidden && !loading) {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        void load();
      }
    };
    document.addEventListener('visibilitychange', visible);
    void load();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  /** Forgets cleaned copies from the history; their branches and conversations are kept. */
  const forget = useCallback(
    async (ids: string[]): Promise<void> => {
      if (apiBase() !== machineBase) return;
      await api('/api/worktrees/history', { method: 'DELETE', body: JSON.stringify({ ids }) });
      if (apiBase() !== machineBase) return;
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
  return { inventory: loadedBase === machineBase ? inventory : null, loadError, refresh, forget };
}
