import assert from 'node:assert/strict';
import { test } from 'node:test';

// Minimal sessionStorage, installed before the module reads it.
class MemoryStorage {
  #items = new Map();
  get length() {
    return this.#items.size;
  }
  key(index) {
    return [...this.#items.keys()][index] ?? null;
  }
  getItem(key) {
    return this.#items.has(key) ? this.#items.get(key) : null;
  }
  setItem(key, value) {
    this.#items.set(key, String(value));
  }
  removeItem(key) {
    this.#items.delete(key);
  }
}
globalThis.sessionStorage = new MemoryStorage();

const { cachedInventory, cacheInventory, forgetCachedCopies, GLOBAL_INVENTORY_PATH } =
  await import('../web/src/worktrees/inventory-cache.ts');

const cleaned = (id, projectId) => ({
  id,
  path: `/tmp/${id}`,
  projectId,
  projectName: projectId ?? 'aucun',
  sessionId: null,
  sessionTitle: null,
  session: null,
  branch: null,
  removedAt: 1,
});
const inventory = (copies) => ({ worktrees: [], cleaned: copies, errors: [] });

test('un inventaire enregistré est relu depuis sessionStorage après un rechargement', async () => {
  cacheInventory('/m/reload', '/api/projects/p1/worktrees', inventory([cleaned('c1', 'p1')]));
  // A fresh module instance stands for the reloaded page: only sessionStorage survives.
  const reloaded = await import(`../web/src/worktrees/inventory-cache.ts?reload=${Date.now()}`);
  assert.deepEqual(reloaded.cachedInventory('/m/reload', '/api/projects/p1/worktrees', 'p1')?.cleaned, [
    cleaned('c1', 'p1'),
  ]);
});

test('un projet jamais visité part de sa part de l’inventaire global', () => {
  cacheInventory('/m/seed', GLOBAL_INVENTORY_PATH, inventory([cleaned('a', 'p1'), cleaned('b', 'p2')]));
  assert.deepEqual(cachedInventory('/m/seed', '/api/projects/p1/worktrees', 'p1')?.cleaned, [cleaned('a', 'p1')]);
  assert.deepEqual(cachedInventory('/m/seed', '/api/projects/p3/worktrees', 'p3'), {
    worktrees: [],
    cleaned: [],
    errors: [],
  });
  // Its own inventory, once known, takes precedence.
  cacheInventory('/m/seed', '/api/projects/p1/worktrees', inventory([]));
  assert.deepEqual(cachedInventory('/m/seed', '/api/projects/p1/worktrees', 'p1')?.cleaned, []);
});

test('sans inventaire connu, aucun contenu n’est inventé ; une autre machine ne partage rien', () => {
  assert.equal(cachedInventory('/m/empty', '/api/projects/p1/worktrees', 'p1'), null);
  cacheInventory('/m/one', GLOBAL_INVENTORY_PATH, inventory([cleaned('a', 'p1')]));
  assert.equal(cachedInventory('/m/two', '/api/projects/p1/worktrees', 'p1'), null);
});

test('oublier une copie la retire de toutes les portées de la machine, stockage compris', async () => {
  cacheInventory('/m/forget', GLOBAL_INVENTORY_PATH, inventory([cleaned('x', 'p1'), cleaned('y', 'p1')]));
  cacheInventory('/m/forget', '/api/projects/p1/worktrees', inventory([cleaned('x', 'p1')]));
  cacheInventory('/m/other', GLOBAL_INVENTORY_PATH, inventory([cleaned('x', 'p1')]));
  forgetCachedCopies('/m/forget', ['x']);
  assert.deepEqual(cachedInventory('/m/forget', GLOBAL_INVENTORY_PATH)?.cleaned, [cleaned('y', 'p1')]);
  assert.deepEqual(cachedInventory('/m/forget', '/api/projects/p1/worktrees', 'p1')?.cleaned, []);
  assert.equal(cachedInventory('/m/other', GLOBAL_INVENTORY_PATH)?.cleaned.length, 1);
  const reloaded = await import(`../web/src/worktrees/inventory-cache.ts?forget=${Date.now()}`);
  assert.deepEqual(reloaded.cachedInventory('/m/forget', '/api/projects/p1/worktrees', 'p1')?.cleaned, []);
});

test('un stockage indisponible ou corrompu retombe sur la mémoire', async () => {
  globalThis.sessionStorage.setItem('cerebro.worktrees:/m/bad|/api/worktrees', '{pas du json');
  assert.equal(cachedInventory('/m/bad', GLOBAL_INVENTORY_PATH), null);
  const saved = globalThis.sessionStorage;
  globalThis.sessionStorage = {
    get length() {
      throw new Error('bloqué');
    },
    getItem() {
      throw new Error('bloqué');
    },
    setItem() {
      throw new Error('bloqué');
    },
  };
  try {
    cacheInventory('/m/blocked', GLOBAL_INVENTORY_PATH, inventory([cleaned('z', null)]));
    assert.equal(cachedInventory('/m/blocked', GLOBAL_INVENTORY_PATH)?.cleaned.length, 1);
    forgetCachedCopies('/m/blocked', ['z']);
    assert.equal(cachedInventory('/m/blocked', GLOBAL_INVENTORY_PATH)?.cleaned.length, 0);
  } finally {
    globalThis.sessionStorage = saved;
  }
});
