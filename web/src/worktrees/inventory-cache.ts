import { parseWorktreeInventory, type WorktreeInventory } from '../../../shared/worktrees.ts';

/**
 * Last inventory per machine and scope, shown on mount so the panel keeps its height while it refreshes. Kept in
 * memory and in sessionStorage, so a reload of the tab starts from it too; the storage may be unavailable (private
 * mode, quota, blocked site data), the memory copy then serves alone.
 */
const memory = new Map<string, WorktreeInventory>();
const STORAGE_PREFIX = 'cerebro.worktrees:';
export const GLOBAL_INVENTORY_PATH = '/api/worktrees';

const cacheKey = (machineBase: string, path: string): string => `${machineBase}|${path}`;

function readStorage(key: string): WorktreeInventory | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
    return raw === null ? null : parseWorktreeInventory(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeStorage(key: string, inventory: WorktreeInventory): void {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(inventory));
  } catch {
    // Memory still holds it for this page.
  }
}

function read(key: string): WorktreeInventory | null {
  const known = memory.get(key);
  if (known) return known;
  const stored = readStorage(key);
  if (stored) memory.set(key, stored);
  return stored;
}

export function cacheInventory(machineBase: string, path: string, inventory: WorktreeInventory): void {
  const key = cacheKey(machineBase, path);
  memory.set(key, inventory);
  writeStorage(key, inventory);
}

/**
 * Inventory to show before the first answer: the scope's own, or else the project's share of the global one, which
 * the app loads at startup so a first visit to a project does not start from an empty panel.
 */
export function cachedInventory(machineBase: string, path: string, projectId?: string): WorktreeInventory | null {
  const own = read(cacheKey(machineBase, path));
  if (own || !projectId) return own;
  const global = read(cacheKey(machineBase, GLOBAL_INVENTORY_PATH));
  if (!global) return null;
  return {
    worktrees: global.worktrees.filter((view) => view.projectId === projectId),
    cleaned: global.cleaned.filter((copy) => copy.projectId === projectId),
    errors: global.errors,
  };
}

/** Drops forgotten cleaned copies from every scope of the machine, so a remount cannot restore them. */
export function forgetCachedCopies(machineBase: string, ids: readonly string[]): void {
  const prefix = `${machineBase}|`;
  const keys = new Set([...memory.keys()].filter((key) => key.startsWith(prefix)));
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const stored = sessionStorage.key(i);
      if (stored?.startsWith(STORAGE_PREFIX + prefix)) keys.add(stored.slice(STORAGE_PREFIX.length));
    }
  } catch {
    // Only the memory copies are known.
  }
  for (const key of keys) {
    const value = read(key);
    if (!value) continue;
    const kept = { ...value, cleaned: value.cleaned.filter((copy) => !ids.includes(copy.id)) };
    memory.set(key, kept);
    writeStorage(key, kept);
  }
}
