import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import * as jsx from 'react/jsx-runtime';
import { moduleRunnerTransform, transformWithOxc } from 'vite';
import * as format from '../web/src/format.ts';

// Exécute le vrai composant en mémoire avec le transformateur Vite, sans DOM ni serveur.
async function compile(name) {
  const url = new URL(`../web/src/${name}.tsx`, import.meta.url);
  const source = await readFile(url, 'utf8');
  const { code } = await transformWithOxc(source, url.pathname, { jsx: { runtime: 'automatic' } });
  const transformed = await moduleRunnerTransform(code, null, url.pathname, source);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('__vite_ssr_import__', '__vite_ssr_exportName__', transformed.code);
  return async (modules) => {
    const exports = {};
    await execute(
      (id) => {
        assert.ok(Object.hasOwn(modules, id), `Import inattendu : ${id}`);
        return modules[id];
      },
      (name, get) => Object.defineProperty(exports, name, { get }),
    );
    return exports;
  };
}

const loadCouncilsTab = await compile('mobile/CouncilsTab');

function texts(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.props?.children);
}

// Runs affichés : les cartes restent des éléments non dépliés, porteurs de leur `run`.
function shownRuns(node) {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(shownRuns);
  if (node.props?.run) return [node.props.run.id];
  return shownRuns(node.props?.children);
}

async function setup(responses) {
  const state = { slots: [], effects: [], index: 0 };
  const hooks = {
    useState(initial) {
      const index = state.index++;
      if (index === state.slots.length) state.slots.push(typeof initial === 'function' ? initial() : initial);
      return [
        state.slots[index],
        (next) => {
          state.slots[index] = typeof next === 'function' ? next(state.slots[index]) : next;
        },
      ];
    },
    useEffect(effect, deps) {
      const index = state.index++;
      const previous = state.slots[index];
      if (!deps || !previous || deps.some((value, i) => !Object.is(value, previous[i]))) state.effects.push(effect);
      state.slots[index] = deps;
    },
    useMemo(factory, deps) {
      const index = state.index++;
      const memo = state.slots[index];
      if (!memo || deps.some((value, i) => !Object.is(value, memo.deps[i])))
        state.slots[index] = { deps, value: factory() };
      return state.slots[index].value;
    },
    useCallback(callback, deps) {
      return hooks.useMemo(() => callback, deps);
    },
  };
  // Polling simulé : `tick()` tient lieu de minuterie et n'interroge l'API que si le composant l'active.
  const polling = { options: null, tick: null };
  const api = { calls: 0 };
  const { CouncilsTab } = await loadCouncilsTab({
    react: hooks,
    'react/jsx-runtime': jsx,
    '../api.ts': {
      ApiError: class extends Error {},
      async getCouncil() {},
      async startCouncil() {},
      async listCouncils() {
        api.calls++;
        const next = responses.shift();
        assert.ok(next, 'appel à listCouncils inattendu');
        if (next instanceof Error) throw next;
        return next;
      },
    },
    '../format.ts': format,
    '../polling.tsx': {
      useNow: () => 0,
      usePolling(fetcher, _ms, options) {
        polling.options = options;
        const load = hooks.useMemo(
          () => () =>
            fetcher().then(
              (value) => polling.options.onData?.(value),
              (cause) => polling.options.onError?.(cause),
            ),
          [fetcher],
        );
        polling.tick = () => (polling.options.enabled === false ? Promise.resolve() : load());
        return load;
      },
    },
    '../route.ts': { go() {}, href: (value) => value },
    '../store.tsx': { useStore: () => ({ projects: [] }) },
  });
  const view = {
    tree: null,
    render() {
      state.index = 0;
      view.tree = CouncilsTab();
      for (const effect of state.effects.splice(0)) effect();
      return view;
    },
    async settle() {
      await setImmediate();
      return view.render();
    },
    text: () => texts(view.tree).join(''),
    runs: () => shownRuns(view.tree),
  };
  return { view: view.render(), polling, api };
}

const done = { id: 'c1', question: 'Faut-il migrer ?', projectId: null, status: 'done', startedAt: 0 };

test("Councils mobile : un premier chargement en échec est relancé jusqu'à obtenir la liste", async () => {
  const { view, polling, api } = await setup([new Error('réseau injoignable'), [done]]);
  await view.settle();
  assert.equal(api.calls, 1);
  assert.match(view.text(), /Liste indisponible : réseau injoignable/);

  await polling.tick();
  await view.settle();
  assert.equal(api.calls, 2, 'le chargement en échec doit être relancé');
  assert.doesNotMatch(view.text(), /Liste indisponible/);
  assert.deepEqual(view.runs(), ['c1']);

  // Liste chargée sans council en cours : plus aucune interrogation.
  assert.equal(polling.options.enabled, false);
});
