import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import * as jsx from 'react/jsx-runtime';
import { moduleRunnerTransform, transformWithOxc } from 'vite';
import * as format from '../web/src/format.ts';
import * as localStore from '../web/src/storage.ts';
import * as types from '../shared/types.ts';
import * as council from '../shared/council.ts';
import { withoutPersona } from '../server/council.ts';

// Exécute les vrais composants et leurs handlers en mémoire, avec le transformateur
// Vite déjà installé. Aucun DOM, serveur ou appel de CLI n'est nécessaire.
async function compile(name, extension = 'tsx') {
  const url = new URL(`../web/src/${name}.${extension}`, import.meta.url);
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

const [loadLaunch, loadSettings, loadAdvisorList, loadAttachments, loadUseLatest, loadAsyncAction, loadPersonas] =
  await Promise.all([
    compile('CouncilLaunch'),
    compile('CouncilSettingsDialog'),
    compile('CouncilAdvisorList'),
    compile('attachments'),
    compile('use-latest', 'ts'),
    compile('async-action', 'ts'),
    compile('PersonasDialog'),
  ]);
// Composants dont le rendu est déplié dans l'arbre, pour inspecter leurs éléments.
const inlined = new Map();
const CLAUDE = { agent: 'claude', model: null, effort: null };
const CODEX = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' };
const SONNET = { agent: 'claude', model: 'sonnet', effort: 'low' };
const GROK = { agent: 'grok', model: null, effort: null };
const ids = ['one', 'two', 'three'];
const defaults = () => ({
  assignments: Object.fromEntries(ids.map((id) => [id, { ...CLAUDE }])),
  defaultPersonaIds: [...ids],
  chairman: { ...CLAUDE },
  readProject: true,
  compositions: [],
});

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (tree === null || typeof tree !== 'object' || !tree.props) return [];
  if (inlined.has(tree.type)) return [tree, ...nodes(inlined.get(tree.type)(tree.props))];
  return [tree, ...nodes(tree.props.children)];
}

function find(view, predicate) {
  const node = nodes(view.tree).find(predicate);
  assert.ok(node, 'Élément attendu absent du formulaire');
  return node;
}

const button = (view, label) => find(view, (node) => node.type === 'button' && node.props.children === label);
const submit = (view) => find(view, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} });

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const lostResponse = () => {
  throw new TypeError('Failed to fetch');
};

// `setup` prépare catalogue et réglages avant le premier rendu du formulaire.
async function fixture(t, projectId, setup = () => {}) {
  const f = {
    personas: ids.map((id) => ({
      id,
      name: id,
      description: '',
      prompt: id,
      needs: [],
      builtin: false,
      createdAt: 0,
      updatedAt: 0,
    })),
    globalSettings: defaults(),
    projectSettings: defaults(),
    settingsReads: 0,
    writes: [],
    launches: [],
    // Personas créées ou modifiées par le dialogue des personas.
    saved: [],
    // Councils créés côté serveur, idempotents sur requestId comme CouncilRuns.start.
    created: new Map(),
    navigations: [],
    // Appelé après la création côté serveur : peut perdre la réponse ou rendre le serveur injoignable.
    afterStart: () => {},
    onGet: () => {},
  };
  setup(f);
  const effective = () => (projectId ? (f.projectSettings ?? f.globalSettings) : f.globalSettings);
  const store = {
    agents: types.AGENTS.map((agent) => ({ agent, available: true })),
    projects: projectId ? [{ id: projectId, name: 'Projet', councilSettings: f.projectSettings }] : [],
    async updateProject(id, patch) {
      assert.equal(id, projectId);
      f.projectSettings = structuredClone(patch.councilSettings);
      store.projects[0] = { ...store.projects[0], ...patch };
      f.writes.push(patch.councilSettings === null ? 'reset' : 'project');
      return store.projects[0];
    },
  };
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map();
  f.storage = storage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  });
  t.after(() => {
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else delete globalThis.localStorage;
  });

  // Un état de hooks distinct par composant, conservé entre les rendus.
  let current;
  const hooks = {
    useState(initial) {
      const { slots } = current;
      const index = current.index++;
      if (index === slots.length) slots.push(typeof initial === 'function' ? initial() : initial);
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        },
      ];
    },
    useId: () => 'id',
    useRef(initial) {
      const { slots } = current;
      const index = current.index++;
      if (index === slots.length) slots.push({ current: initial });
      return slots[index];
    },
    useEffect(effect, deps) {
      const { slots, effects } = current;
      const index = current.index++;
      if (!deps || !slots[index] || deps.some((value, i) => !Object.is(value, slots[index][i]))) effects.push(effect);
      slots[index] = deps;
    },
    useMemo(factory, deps) {
      const { slots } = current;
      const index = current.index++;
      const memo = slots[index];
      if (!memo || deps.some((value, i) => !Object.is(value, memo.deps[i]))) slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useCallback(callback, deps) {
      return hooks.useMemo(() => callback, deps);
    },
    // Sans commit à simuler, la mise à jour a lieu dès le rendu.
    useInsertionEffect(effect) {
      effect();
    },
  };
  function mount(Component, props) {
    const state = { slots: [], effects: [], index: 0 };
    return {
      tree: null,
      render() {
        state.index = 0;
        current = state;
        try {
          this.tree = Component(props);
        } finally {
          current = null;
        }
        for (const effect of state.effects.splice(0)) effect();
        return this;
      },
      async settle() {
        await setImmediate();
        return this.render();
      },
    }.render();
  }
  function LlmSelector() {}
  function PersonasDialog() {}
  f.PersonasDialog = PersonasDialog;
  function Modal() {}
  const modules = {
    react: hooks,
    'react/jsx-runtime': jsx,
    '../../shared/types.ts': types,
    '../../shared/council.ts': council,
    './council.css': {},
    './ActivityStatus.tsx': { ActivityStatus() {} },
    './AgentLabel.tsx': { AgentLogo() {} },
    './format.ts': { ...format, relativeTime: () => '' },
    './DelayedActionButton.tsx': { DelayedActionButton() {} },
    './LlmSelector.tsx': { LlmSelector },
    './PersonasDialog.tsx': { PersonasDialog },
    './Dialog.tsx': { Modal },
    './route.ts': { go: (target) => f.navigations.push(target), href: (value) => value },
    // Sans minuterie : seul le chargement explicite (refresh) interroge l'API. Comme le vrai hook, refresh ne
    // change qu'avec le fetcher et appelle les derniers gestionnaires.
    './polling.tsx': {
      useNow: () => 0,
      usePolling(fetcher, _ms, options) {
        const handlers = hooks.useRef(options);
        handlers.current = options;
        return hooks.useMemo(
          () => () =>
            fetcher().then(
              (value) => handlers.current.onData?.(value),
              (cause) => handlers.current.onError?.(cause),
            ),
          [fetcher],
        );
      },
    },
    './store.tsx': { useStore: () => store },
    './drafts.ts': {},
    './storage.ts': localStore,
    './api.ts': {
      clipboardImage: () => null,
      async uploadCouncilImage() {
        throw new Error('aucun envoi d’image attendu');
      },
      async listPersonas() {
        return structuredClone(f.personas);
      },
      async createPersona(input) {
        f.saved.push(['create', structuredClone(input)]);
        const created = { id: 'new', ...input, builtin: false, createdAt: 0, updatedAt: 0 };
        f.personas.push(created);
        return structuredClone(created);
      },
      async updatePersona(id, patch) {
        f.saved.push(['update', id, structuredClone(patch)]);
        const persona = Object.assign(
          f.personas.find((candidate) => candidate.id === id),
          patch,
        );
        return structuredClone(persona);
      },
      async deletePersona() {},
      async getCouncilSettings() {
        f.settingsReads++;
        return structuredClone(f.globalSettings);
      },
      async getEffectiveCouncilSettings() {
        f.settingsReads++;
        return structuredClone(effective());
      },
      async putCouncilSettings(settings) {
        f.globalSettings = structuredClone(settings);
        f.writes.push('global');
      },
      async listCouncils() {
        return [];
      },
      async deleteCouncil() {},
      ApiError,
      async startCouncil(input) {
        f.launches.push(structuredClone(input));
        if (!f.created.has(input.requestId))
          f.created.set(input.requestId, { id: input.requestId, question: input.question });
        f.afterStart(input);
        return f.created.get(input.requestId);
      },
      async getCouncil(id) {
        f.onGet(id);
        if (!f.created.has(id)) throw new ApiError(404, 'Council introuvable.');
        return f.created.get(id);
      },
    },
  };
  modules['./use-latest.ts'] = await loadUseLatest(modules);
  modules['./attachments.tsx'] = await loadAttachments(modules);
  modules['./async-action.ts'] = await loadAsyncAction(modules);
  modules['./CouncilAdvisorList.tsx'] = await loadAdvisorList(modules);
  const { CouncilAdvisorList } = modules['./CouncilAdvisorList.tsx'];
  // Rendu hors montage : l'onglet actif est sans incidence, tous les panneaux sont dans l'arbre.
  inlined.set(CouncilAdvisorList, (props) => {
    const outer = current;
    current = { slots: [], effects: [], index: 0 };
    try {
      return CouncilAdvisorList(props);
    } finally {
      current = outer;
    }
  });
  modules['./CouncilSettingsDialog.tsx'] = await loadSettings(modules);
  f.mount = mount;
  f.modules = modules;
  const { CouncilLaunch } = await loadLaunch(modules);
  const form = CouncilLaunch({ projectId });
  f.launch = mount(form.type, form.props);
  await f.launch.settle();
  find(f.launch, (node) => node.type === 'textarea' && node.props.required).props.onChange({
    target: { value: 'Quelle priorité ?' },
  });
  f.launch.render();
  f.selector = (view, id) => {
    const advisor = find(view, (node) => node.props.role === 'tabpanel' && node.key === id);
    return find({ tree: advisor }, (node) => node.type === LlmSelector);
  };
  f.choose = (id, value) => {
    f.selector(f.launch, id).props.onChange(value);
    f.launch.render();
  };
  f.openSettings = async () => {
    button(f.launch, 'Réglages').props.onClick();
    f.launch.render();
    const dialog = find(f.launch, (node) => node.type === modules['./CouncilSettingsDialog.tsx'].CouncilSettingsDialog);
    return mount(dialog.type, dialog.props).settle();
  };
  f.dismiss = (dialog) => find(dialog, (node) => node.type === Modal).props.onClose();
  f.refreshPersonas = async () => {
    button(f.launch, 'Nouvelle persona').props.onClick();
    f.launch.render();
    find(f.launch, (node) => node.type === PersonasDialog).props.onChange();
    await f.launch.settle();
  };
  // Même réparation des réglages que CerebroDatabase.deletePersona.
  f.deletePersona = (id) => {
    f.personas = f.personas.filter((persona) => persona.id !== id);
    f.globalSettings = withoutPersona(f.globalSettings, id, f.personas);
    if (f.projectSettings) f.projectSettings = withoutPersona(f.projectSettings, id, f.personas);
  };
  f.toggle = (id) =>
    find(
      { tree: find(f.launch, (node) => node.props.role === 'tabpanel' && node.key === id) },
      (node) => node.type === 'button' && node.props.className?.startsWith('council-advisor-toggle'),
    );
  f.checked = () =>
    nodes(f.launch.tree)
      .filter((node) => node.props.role === 'tabpanel' && f.toggle(node.key).props.className.endsWith(' on'))
      .map((node) => node.key);
  f.convoke = async () => {
    submit(f.launch);
    await f.launch.settle();
    assert.equal(f.launches.length, 1);
    return f.launches[0].participants;
  };
  return f;
}

for (const projectId of [undefined, 'project']) {
  for (const close of ['Annuler', 'fermeture de la modale']) {
    test(`les choix du lancement survivent à ${close} (${projectId ?? 'accueil'})`, async (t) => {
      const f = await fixture(t, projectId);
      f.choose('one', CODEX);
      const dialog = await f.openSettings();
      // Une modification non enregistrée dans les réglages ne concerne pas le lancement.
      f.selector(dialog, 'one').props.onChange(GROK);
      dialog.render();
      const reads = f.settingsReads;
      if (close === 'Annuler') button(dialog, 'Annuler').props.onClick();
      else f.dismiss(dialog);
      await f.launch.settle();
      assert.deepEqual(f.selector(f.launch, 'one').props.value, CODEX);
      assert.equal(f.settingsReads, reads, 'une annulation ne recharge pas les valeurs par défaut');
      assert.deepEqual(f.writes, []);
      assert.deepEqual(
        await f.convoke(),
        ids.map((personaId) => ({ personaId, ...(personaId === 'one' ? CODEX : CLAUDE) })),
      );
    });
  }

  test(`enregistrer rafraîchit les défauts et conserve les choix explicites (${projectId ?? 'accueil'})`, async (t) => {
    const f = await fixture(t, projectId);
    f.choose('one', CODEX);
    f.choose('three', CLAUDE); // Les null explicites restent prioritaires sur un futur modèle par défaut.
    const dialog = await f.openSettings();
    for (const id of ids) {
      f.selector(dialog, id).props.onChange(SONNET);
      dialog.render();
    }
    submit(dialog);
    await f.launch.settle();
    assert.deepEqual(f.writes, [projectId ? 'project' : 'global']);
    assert.deepEqual(f.selector(f.launch, 'one').props.value, CODEX);
    assert.deepEqual(f.selector(f.launch, 'one').props.defaults, SONNET);
    assert.deepEqual(f.selector(f.launch, 'two').props.value, SONNET);
    assert.deepEqual(f.selector(f.launch, 'three').props.value, CLAUDE);
    assert.deepEqual(await f.convoke(), [
      { personaId: 'one', ...CODEX },
      { personaId: 'two', ...SONNET },
      { personaId: 'three', ...CLAUDE },
    ]);
  });
}

test('revenir aux réglages globaux puis annuler conserve les choix et rafraîchit les défauts', async (t) => {
  const f = await fixture(t, 'project');
  f.globalSettings.assignments.two = GROK;
  f.choose('one', CODEX);
  const dialog = await f.openSettings();
  find(
    dialog,
    (node) => node.type === 'button' && node.props.title === 'Supprime les réglages propres à ce projet',
  ).props.onClick();
  await dialog.settle();
  button(dialog, 'Annuler').props.onClick();
  await f.launch.settle();
  assert.deepEqual(f.writes, ['reset']);
  assert.deepEqual(f.selector(f.launch, 'one').props.value, CODEX);
  assert.deepEqual(f.selector(f.launch, 'two').props.value, GROK);
  assert.deepEqual(await f.convoke(), [
    { personaId: 'one', ...CODEX },
    { personaId: 'two', ...GROK },
    { personaId: 'three', ...CLAUDE },
  ]);
});

test('un rafraîchissement du catalogue retire seulement les choix des personas supprimées', async (t) => {
  const f = await fixture(t);
  f.choose('one', CODEX);
  f.choose('two', SONNET);
  const dialog = await f.openSettings();
  const removed = f.personas.shift();
  button(dialog, 'Annuler').props.onClick();
  await f.launch.settle();
  assert.equal(
    nodes(f.launch.tree).some((node) => node.type === 'li' && node.key === 'one'),
    false,
  );
  assert.deepEqual(f.selector(f.launch, 'two').props.value, SONNET);
  // Le choix supprimé ne doit pas réapparaître si le même id revient dans le catalogue.
  f.personas.unshift(removed);
  await f.refreshPersonas();
  assert.deepEqual(f.selector(f.launch, 'one').props.value, CLAUDE);
  assert.deepEqual(f.selector(f.launch, 'two').props.value, SONNET);
  assert.deepEqual(await f.convoke(), [
    { personaId: 'one', ...CLAUDE },
    { personaId: 'two', ...SONNET },
    { personaId: 'three', ...CLAUDE },
  ]);
});

for (const projectId of [undefined, 'project']) {
  test(`un lancement réussi efface le brouillon enregistré avant la navigation (${projectId ?? 'accueil'})`, async (t) => {
    const f = await fixture(t, projectId);
    const key = `cerebro.council-draft.${projectId ?? 'home'}`;
    assert.ok(f.storage.has(key));
    submit(f.launch);
    // La navigation démonte le formulaire : aucun rendu ni effet ne suit le lancement.
    await setImmediate();
    assert.equal(f.navigations.length, 1);
    assert.equal(f.storage.has(key), false);
  });
}

test('une réponse perdue retrouve le council déjà créé sans le relancer', async (t) => {
  const f = await fixture(t, 'project');
  f.afterStart = lostResponse;
  submit(f.launch);
  await f.launch.settle();
  assert.equal(f.launches.length, 1);
  assert.equal(f.created.size, 1);
  const [requestId] = f.created.keys();
  assert.deepEqual(f.navigations, [`#/c/${requestId}`]);
  assert.equal(find(f.launch, (node) => node.type === 'textarea' && node.props.required).props.value, '');
});

test('une relance après une erreur de transport réutilise l’identifiant de la soumission', async (t) => {
  const f = await fixture(t, 'project');
  // Le serveur accepte le POST, puis devient injoignable : la réponse et la vérification échouent.
  f.afterStart = lostResponse;
  f.onGet = () => {
    throw new TypeError('Failed to fetch');
  };
  submit(f.launch);
  await f.launch.settle();
  assert.deepEqual(f.navigations, []);
  assert.ok(
    nodes(f.launch.tree).some((node) => node.props.role === 'alert' && node.props.children === 'Failed to fetch'),
  );
  // Le réseau revient : Convoquer avec le même brouillon rend le premier council.
  f.afterStart = () => {};
  submit(f.launch);
  await f.launch.settle();
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1].requestId, f.launches[0].requestId);
  assert.equal(f.created.size, 1);
  assert.deepEqual(f.navigations, [`#/c/${f.launches[0].requestId}`]);
});

test('une soumission aux paramètres modifiés reçoit un nouvel identifiant', async (t) => {
  const f = await fixture(t);
  f.afterStart = lostResponse;
  f.onGet = () => {
    throw new TypeError('Failed to fetch');
  };
  submit(f.launch);
  await f.launch.settle();
  // Un refus explicite du serveur ne déclenche pas de vérification et conserve l'identifiant.
  f.afterStart = () => {
    throw new ApiError(500, 'Erreur interne');
  };
  f.onGet = () => assert.fail('aucune vérification après une réponse du serveur');
  submit(f.launch);
  await f.launch.settle();
  assert.equal(f.launches[1].requestId, f.launches[0].requestId);
  f.afterStart = () => {};
  f.choose('one', CODEX);
  submit(f.launch);
  await f.launch.settle();
  assert.equal(f.launches.length, 3);
  assert.notEqual(f.launches[2].requestId, f.launches[0].requestId);
  assert.deepEqual(f.navigations, [`#/c/${f.launches[2].requestId}`]);
});

test('un nouveau lancement après un succès reçoit un nouvel identifiant', async (t) => {
  const f = await fixture(t);
  submit(f.launch);
  await f.launch.settle();
  find(f.launch, (node) => node.type === 'textarea' && node.props.required).props.onChange({
    target: { value: 'Quelle priorité ?' },
  });
  f.launch.render();
  submit(f.launch);
  await f.launch.settle();
  assert.equal(f.launches.length, 2);
  assert.notEqual(f.launches[1].requestId, f.launches[0].requestId);
  assert.equal(f.created.size, 2);
});

// Quatre personas dont deux participent par défaut : supprimer l'une fait choisir un remplaçant au serveur.
const fourPersonas = (f) => {
  f.personas.push({ ...f.personas[0], id: 'four', name: 'four', prompt: 'four' });
  for (const settings of [f.globalSettings, f.projectSettings]) {
    settings.assignments.four = { ...CLAUDE };
    settings.defaultPersonaIds = ['one', 'two'];
  }
};

for (const projectId of [undefined, 'project']) {
  test(`supprimer un participant par défaut adopte le remplaçant des réglages (${projectId ?? 'accueil'})`, async (t) => {
    const f = await fixture(t, projectId, fourPersonas);
    assert.deepEqual(f.checked(), ['one', 'two']);
    f.choose('two', CODEX);
    if (projectId) {
      find(
        f.launch,
        (node) => node.type === 'input' && node.props.type === 'checkbox' && !node.props['aria-label'],
      ).props.onChange({ target: { checked: false } });
      f.launch.render();
    }
    button(f.launch, 'Nouvelle persona').props.onClick();
    f.launch.render();
    f.deletePersona('one');
    find(f.launch, (node) => node.type === f.PersonasDialog).props.onChange();
    await f.launch.settle();
    assert.deepEqual(f.checked(), ['two', 'three']);
    assert.equal(
      find(f.launch, (node) => node.type === 'button' && node.props.type === 'submit').props.disabled,
      false,
    );
    assert.deepEqual(await f.convoke(), [
      { personaId: 'two', ...CODEX },
      { personaId: 'three', ...CLAUDE },
    ]);
    assert.equal(f.launches[0].readProject, false);
  });
}

test('une sélection explicite ne suit pas le remplaçant choisi par le serveur', async (t) => {
  const f = await fixture(t, undefined, fourPersonas);
  f.toggle('four').props.onClick();
  f.launch.render();
  f.deletePersona('one');
  await f.refreshPersonas();
  assert.deepEqual(f.checked(), ['two', 'four']);
});

test('supprimer une persona depuis les réglages rafraîchit aussi le formulaire', async (t) => {
  const f = await fixture(t, 'project', fourPersonas);
  const dialog = await f.openSettings();
  button(dialog, 'Gérer les personas').props.onClick();
  dialog.render();
  f.deletePersona('one');
  find(dialog, (node) => node.type === f.PersonasDialog).props.onChange();
  await f.launch.settle();
  assert.deepEqual(f.checked(), ['two', 'three']);
});

// Deux compositions en plus des quatre personas ; « gone » n'est plus au catalogue.
const withCompositions = (f) => {
  fourPersonas(f);
  for (const settings of [f.globalSettings, f.projectSettings])
    settings.compositions = [
      { name: 'Technique', personaIds: ['four', 'gone', 'one', 'three'] },
      { name: 'Produit', personaIds: ['two', 'four'] },
    ];
};
// Sélecteur de composition du lancement : valeur, libellés des choix et choix d'une valeur.
const compositionSelect = (view) => find(view, (node) => node.type === 'select');
const compositionChoices = (view) =>
  nodes(compositionSelect(view).props.children)
    .filter((node) => node.type === 'option')
    .map((option) => option.props.children);
const chooseComposition = (f, value) => {
  compositionSelect(f.launch).props.onChange({ target: { value } });
  f.launch.render();
};
const callsHint = (view) =>
  nodes(view.tree).find((node) => typeof node.props.children === 'string' && / appels LLM$/.test(node.props.children))
    ?.props.children;

for (const projectId of [undefined, 'project']) {
  test(`une composition coche ses personas, ajustables avant de convoquer (${projectId ?? 'accueil'})`, async (t) => {
    const f = await fixture(t, projectId, withCompositions);
    assert.deepEqual(f.checked(), ['one', 'two']);
    assert.equal(compositionSelect(f.launch).props.value, 'defaults');
    assert.deepEqual(compositionChoices(f.launch), ['Participants par défaut', 'Technique', 'Produit']);

    // La persona absente du catalogue est ignorée sans erreur.
    chooseComposition(f, '0');
    assert.deepEqual(f.checked(), ['one', 'three', 'four']);
    assert.equal(compositionSelect(f.launch).props.value, '0');
    assert.equal(callsHint(f.launch), '3 conseillers · 7 appels LLM');
    // Une retouche rend la sélection personnalisée ; la défaire retrouve la composition.
    f.toggle('two').props.onClick();
    f.launch.render();
    assert.equal(compositionSelect(f.launch).props.value, 'custom');
    assert.deepEqual(compositionChoices(f.launch), [
      'Sélection personnalisée',
      'Participants par défaut',
      'Technique',
      'Produit',
    ]);
    f.toggle('two').props.onClick();
    f.launch.render();
    assert.equal(compositionSelect(f.launch).props.value, '0');
    // L'agent choisi pour ce lancement s'ajoute à la composition.
    f.choose('four', CODEX);
    assert.deepEqual(await f.convoke(), [
      { personaId: 'one', ...CLAUDE },
      { personaId: 'three', ...CLAUDE },
      { personaId: 'four', ...CODEX },
    ]);
  });
}

test('« Participants par défaut » rend la sélection aux réglages, qu’elle suit de nouveau', async (t) => {
  const f = await fixture(t, undefined, withCompositions);
  chooseComposition(f, '1');
  assert.deepEqual(f.checked(), ['two', 'four']);
  chooseComposition(f, 'defaults');
  assert.deepEqual(f.checked(), ['one', 'two']);
  // Les participants par défaut enregistrés ensuite s'appliquent.
  const dialog = await f.openSettings();
  find(
    { tree: find(dialog, (node) => node.props.role === 'tabpanel' && node.key === 'three') },
    (node) => node.type === 'button' && node.props.className?.startsWith('council-advisor-toggle'),
  ).props.onClick();
  dialog.render();
  submit(dialog);
  await f.launch.settle();
  assert.deepEqual(f.checked(), ['one', 'two', 'three']);
  assert.equal(compositionSelect(f.launch).props.value, 'defaults');
});

test('une persona supprimée du catalogue quitte les compositions sans erreur', async (t) => {
  const f = await fixture(t, undefined, withCompositions);
  chooseComposition(f, '0');
  f.deletePersona('one');
  await f.refreshPersonas();
  assert.deepEqual(f.checked(), ['three', 'four']);
  assert.equal(compositionSelect(f.launch).props.value, '0');
  assert.deepEqual(
    (await f.convoke()).map((participant) => participant.personaId),
    ['three', 'four'],
  );
});

test('sans composition, le lancement n’affiche pas de sélecteur', async (t) => {
  const f = await fixture(t);
  assert.equal(
    nodes(f.launch.tree).some((node) => node.type === 'select'),
    false,
  );
});

test('les réglages créent, renomment, modifient et suppriment des compositions', async (t) => {
  const f = await fixture(t, undefined, withCompositions);
  const dialog = await f.openSettings();
  // Sans état propre : son rendu est déplié dans l'arbre du dialogue.
  const editor = find(dialog, (node) => node.type?.name === 'CouncilCompositions');
  inlined.set(editor.type, editor.type);
  const items = () =>
    nodes(dialog.tree).filter((node) => node.type === 'li' && node.props.className === 'council-composition-item');
  const within = (index, predicate) => find({ tree: items()[index] }, predicate);
  const names = () => items().map((_, index) => within(index, (node) => node.type === 'input').props.value);
  const pressed = (index) =>
    nodes(items()[index])
      .filter((node) => node.props['aria-pressed'] === true)
      .map((node) => node.key);
  const message = (index) => within(index, (node) => node.type === 'p').props.children;
  const rename = (index, value) => {
    within(index, (node) => node.type === 'input').props.onChange({ target: { value } });
    dialog.render();
  };
  const press = (index, id) => {
    within(index, (node) => node.type === 'button' && node.key === id).props.onClick();
    dialog.render();
  };
  const blocked = () => find(dialog, (node) => node.type === 'button' && node.props.type === 'submit').props.disabled;

  // La persona absente du catalogue n'est ni proposée ni comptée.
  assert.deepEqual(names(), ['Technique', 'Produit']);
  assert.deepEqual(pressed(0), ['one', 'three', 'four']);
  assert.equal(message(0), '3 personas · 7 appels LLM');
  assert.equal(blocked(), false);

  // Une nouvelle composition part des participants cochés par défaut et doit être nommée.
  button(dialog, 'Nouvelle composition').props.onClick();
  dialog.render();
  assert.deepEqual(pressed(2), ['one', 'two']);
  assert.equal(message(2), 'Nommez la composition.');
  assert.equal(blocked(), true);
  rename(2, ' produit ');
  assert.equal(message(2), 'Une autre composition porte déjà ce nom.');
  rename(2, 'Décision');
  press(2, 'one');
  assert.equal(message(2), 'Choisissez au moins 2 personas.');
  assert.equal(blocked(), true);
  press(2, 'three');
  assert.equal(message(2), '2 personas · 5 appels LLM');
  assert.equal(blocked(), false);

  within(1, (node) => node.type === 'button' && node.props.children === 'Supprimer').props.onClick();
  dialog.render();
  assert.deepEqual(names(), ['Technique', 'Décision']);
  submit(dialog);
  await f.launch.settle();
  assert.deepEqual(f.writes, ['global']);
  assert.deepEqual(f.globalSettings.compositions, [
    { name: 'Technique', personaIds: ['four', 'one', 'three'] },
    { name: 'Décision', personaIds: ['two', 'three'] },
  ]);
  // Le lancement propose aussitôt les compositions enregistrées.
  assert.deepEqual(compositionChoices(f.launch), ['Participants par défaut', 'Technique', 'Décision']);
  chooseComposition(f, '1');
  assert.deepEqual(f.checked(), ['two', 'three']);
});

test('les onglets distinguent les conseillers qui ne participent pas', async (t) => {
  const f = await fixture(t, undefined);
  const tab = (id) => find(f.launch, (node) => node.props.role === 'tab' && node.key === id);
  assert.match(tab('two').props.className, /\bchecked\b/);
  assert.equal(f.toggle('two').props.children, 'Participe');
  f.toggle('two').props.onClick();
  f.launch.render();
  assert.equal(f.toggle('two').props.children, 'Ne participe pas');
  // La configuration reste visible, désactivée, et réapparaît intacte une fois la persona recochée.
  assert.equal(f.selector(f.launch, 'two').props.disabled, true);
  assert.doesNotMatch(tab('two').props.className, /\bchecked\b/);
  assert.equal(tab('two').props.title, 'Ne participe pas');
  assert.equal(tab('one').props.title, 'Joué par claude');
  f.personas[0].description = 'Cherche la faille.';
  await f.refreshPersonas();
  assert.equal(tab('one').props.title, 'Cherche la faille.\nJoué par claude');
  assert.deepEqual(f.checked(), ['one', 'three']);
  // Un seul panneau visible : celui du premier onglet tant qu'aucun autre n'est choisi.
  const panels = nodes(f.launch.tree).filter((node) => node.props.role === 'tabpanel');
  assert.deepEqual(
    panels.filter((panel) => !panel.props.hidden).map((panel) => panel.key),
    ['one'],
  );
});

// L'Empiriste a besoin du dépôt et du web, l'Historien du web seulement ; la troisième persona d'aucun accès.
const needingPersonas = (f) => {
  Object.assign(f.personas[0], { name: 'Empiriste', needs: ['project', 'web'] });
  Object.assign(f.personas[1], { name: 'Historien', needs: ['web'] });
};
const accessWarning = (view) =>
  nodes(view.tree).find((node) => node.props.className === 'council-access-warning')?.props.children ?? null;
// Cases d'accès dans l'ordre du formulaire : lecture du projet (dans un projet seulement), puis web.
const accessBoxes = (view) =>
  nodes(view.tree)
    .filter((node) => node.type === 'label' && node.props.className === 'council-read-project')
    .map((label) => find({ tree: label }, (node) => node.type === 'input'));
const check = (f, box, checked) => {
  box.props.onChange({ target: { checked } });
  f.launch.render();
};

test('hors projet, une persona cochée sans l’accès dont elle a besoin est nommée, sans bloquer le lancement', async (t) => {
  const f = await fixture(t, undefined, needingPersonas);
  assert.equal(
    accessWarning(f.launch),
    'Empiriste a besoin du dépôt et du web, Historien a besoin du web : ce council n’y donne pas accès, leurs preuves risquent d’être inventées.',
  );
  check(f, accessBoxes(f.launch).at(-1), true);
  // Le web ne donne pas le dépôt : seul l'Empiriste reste signalé, pour ce seul accès.
  assert.equal(
    accessWarning(f.launch),
    'Empiriste a besoin du dépôt : ce council n’y donne pas accès, ses preuves risquent d’être inventées.',
  );
  f.toggle('one').props.onClick();
  f.launch.render();
  assert.equal(accessWarning(f.launch), null);
  f.toggle('one').props.onClick();
  f.launch.render();
  assert.ok(accessWarning(f.launch));
  assert.equal(find(f.launch, (node) => node.type === 'button' && node.props.type === 'submit').props.disabled, false);
  assert.deepEqual(
    (await f.convoke()).map((participant) => participant.personaId),
    ids,
  );
  assert.equal(f.launches[0].webAccess, true);
});

test('dans un projet, l’avertissement suit la lecture du dépôt et l’accès au web cochés pour ce lancement', async (t) => {
  const f = await fixture(t, 'project', needingPersonas);
  // Lecture du projet proposée par les réglages : seul le web manque.
  assert.equal(
    accessWarning(f.launch),
    'Empiriste a besoin du web, Historien a besoin du web : ce council n’y donne pas accès, leurs preuves risquent d’être inventées.',
  );
  check(f, accessBoxes(f.launch)[1], true);
  assert.equal(accessWarning(f.launch), null);
  check(f, accessBoxes(f.launch)[0], false);
  assert.equal(
    accessWarning(f.launch),
    'Empiriste a besoin du dépôt : ce council n’y donne pas accès, ses preuves risquent d’être inventées.',
  );
  // Une persona décochée n'est plus signalée.
  f.toggle('one').props.onClick();
  f.launch.render();
  assert.equal(accessWarning(f.launch), null);
  await f.convoke();
  assert.equal(f.launches[0].readProject, false);
  assert.equal(f.launches[0].webAccess, true);
});

test('le dialogue des personas modifie les besoins d’accès et les rappelle dans la liste', async (t) => {
  const f = await fixture(t, undefined, needingPersonas);
  const { PersonasDialog } = await loadPersonas(f.modules);
  const dialog = await f.mount(PersonasDialog, { onClose() {} }).settle();
  const item = (id) => find(dialog, (node) => node.type === 'li' && node.key === id);
  const summary = (id) =>
    nodes(item(id).props.children).find((node) => node.props.className === 'persona-needs-summary')?.props.children ??
    null;
  const edit = (id) => {
    find({ tree: item(id) }, (node) => node.type === 'button' && node.props.children === 'Modifier').props.onClick();
    dialog.render();
  };
  // Formulaire déplié : ses cases d'accès dans l'ordre (dépôt, web) et sa soumission.
  const form = () => {
    const element = find(dialog, (node) => node.type?.name === 'PersonaForm');
    return { tree: element.type(element.props) };
  };
  const needBoxes = () => nodes(form().tree).filter((node) => node.type === 'input' && node.props.type === 'checkbox');
  const toggleNeed = (index, checked) => {
    needBoxes()[index].props.onChange({ target: { checked } });
    dialog.render();
  };
  const save = async () => {
    find(form(), (node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await dialog.settle();
  };

  assert.deepEqual(summary('one'), ['A besoin ', 'du dépôt et du web']);
  assert.deepEqual(summary('two'), ['A besoin ', 'du web']);
  assert.equal(summary('three'), null);

  edit('three');
  assert.deepEqual(
    needBoxes().map((box) => box.props.checked),
    [false, false],
  );
  // Cochés dans le désordre, envoyés dans l'ordre canonique.
  toggleNeed(1, true);
  toggleNeed(0, true);
  assert.deepEqual(
    needBoxes().map((box) => box.props.checked),
    [true, true],
  );
  await save();
  assert.deepEqual(f.saved.at(-1), [
    'update',
    'three',
    { name: 'three', description: '', prompt: 'three', needs: ['project', 'web'] },
  ]);
  assert.deepEqual(summary('three'), ['A besoin ', 'du dépôt et du web']);

  edit('one');
  assert.deepEqual(
    needBoxes().map((box) => box.props.checked),
    [true, true],
  );
  toggleNeed(0, false);
  await save();
  assert.deepEqual(f.saved.at(-1)[2].needs, ['web']);
  assert.deepEqual(summary('one'), ['A besoin ', 'du web']);

  button(dialog, 'Nouvelle persona').props.onClick();
  dialog.render();
  for (const [field, value] of [
    ['input', 'Juriste'],
    ['textarea', 'Tu es le juriste.'],
  ]) {
    find(form(), (node) => node.type === field && node.props.required).props.onChange({ target: { value } });
    dialog.render();
  }
  await save();
  assert.deepEqual(f.saved.at(-1), [
    'create',
    { name: 'Juriste', description: '', prompt: 'Tu es le juriste.', needs: [] },
  ]);
});
