import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import * as jsx from 'react/jsx-runtime';
import { moduleRunnerTransform, transformWithOxc } from 'vite';
import * as format from '../web/src/format.ts';
import * as types from '../web/src/types.ts';
import { withoutPersona } from '../server/council.ts';

// Exécute les vrais composants et leurs handlers en mémoire, avec le transformateur
// Vite déjà installé. Aucun DOM, serveur ou appel de CLI n'est nécessaire.
async function compile(name) {
  const url = new URL(`../web/src/${name}.tsx`, import.meta.url);
  const source = await readFile(url, 'utf8');
  const { code } = await transformWithOxc(source, url.pathname, { jsx: { runtime: 'automatic' } });
  const transformed = await moduleRunnerTransform(code, null, url.pathname, source);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('__vite_ssr_import__', '__vite_ssr_exportName__', transformed.code);
  return async modules => {
    const exports = {};
    await execute(id => {
      assert.ok(Object.hasOwn(modules, id), `Import inattendu : ${id}`);
      return modules[id];
    }, (name, get) => Object.defineProperty(exports, name, { get }));
    return exports;
  };
}

const [loadLaunch, loadSettings, loadAdvisorList, loadAttachments] = await Promise.all([compile('CouncilLaunch'), compile('CouncilSettingsDialog'), compile('CouncilAdvisorList'), compile('attachments')]);
// Composants dont le rendu est déplié dans l'arbre, pour inspecter leurs éléments.
const inlined = new Map();
const CLAUDE = { agent: 'claude', model: null, effort: null };
const CODEX = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' };
const SONNET = { agent: 'claude', model: 'sonnet', effort: 'low' };
const GROK = { agent: 'grok', model: null, effort: null };
const ids = ['one', 'two', 'three'];
const defaults = () => ({
  assignments: Object.fromEntries(ids.map(id => [id, { ...CLAUDE }])),
  defaultPersonaIds: [...ids], chairman: { ...CLAUDE }, readProject: true,
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

const button = (view, label) => find(view, node => node.type === 'button' && node.props.children === label);
const submit = view => find(view, node => node.type === 'form').props.onSubmit({ preventDefault() {} });

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const lostResponse = () => { throw new TypeError('Failed to fetch'); };

// `setup` prépare catalogue et réglages avant le premier rendu du formulaire.
async function fixture(t, projectId, setup = () => {}) {
  const f = {
    personas: ids.map(id => ({ id, name: id, description: '', prompt: id, builtin: false, createdAt: 0, updatedAt: 0 })),
    globalSettings: defaults(), projectSettings: defaults(), settingsReads: 0, writes: [], launches: [],
    // Councils créés côté serveur, idempotents sur requestId comme CouncilRuns.start.
    created: new Map(), navigations: [],
    // Appelé après la création côté serveur : peut perdre la réponse ou rendre le serveur injoignable.
    afterStart: () => {}, onGet: () => {},
  };
  setup(f);
  const effective = () => projectId ? f.projectSettings ?? f.globalSettings : f.globalSettings;
  const store = {
    agents: types.AGENTS.map(agent => ({ agent, available: true })),
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
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  } });
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
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
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
      if (!slots[index] || deps.some((value, i) => !Object.is(value, slots[index][i]))) effects.push(effect);
      slots[index] = deps;
    },
  };
  function mount(Component, props) {
    const state = { slots: [], effects: [], index: 0 };
    return {
      tree: null,
      render() {
        state.index = 0;
        current = state;
        try { this.tree = Component(props); } finally { current = null; }
        for (const effect of state.effects.splice(0)) effect();
        return this;
      },
      async settle() { await setImmediate(); return this.render(); },
    }.render();
  }
  function LlmSelector() {}
  function PersonasDialog() {}
  f.PersonasDialog = PersonasDialog;
  function Modal() {}
  const modules = {
    react: hooks, 'react/jsx-runtime': jsx, './types.ts': types, './council.css': {},
    './ActivityStatus.tsx': { ActivityStatus() {} },
    './AgentLabel.tsx': { AgentLogo() {} }, './format.ts': { relativeTime: () => '', AGENT_LABEL: format.AGENT_LABEL },
    './DelayedActionButton.tsx': { DelayedActionButton() {} },
    './LlmSelector.tsx': { LlmSelector }, './PersonasDialog.tsx': { PersonasDialog }, './Dialog.tsx': { Modal },
    './route.ts': { useNow: () => 0, go: target => f.navigations.push(target), href: value => value },
    './store.tsx': { useStore: () => store },
    './drafts.ts': {},
    './api.ts': {
      clipboardImage: () => null,
      async uploadCouncilImage() { throw new Error('aucun envoi d’image attendu'); },
      async listPersonas() { return structuredClone(f.personas); },
      async getCouncilSettings() { f.settingsReads++; return structuredClone(f.globalSettings); },
      async getEffectiveCouncilSettings() { f.settingsReads++; return structuredClone(effective()); },
      async putCouncilSettings(settings) { f.globalSettings = structuredClone(settings); f.writes.push('global'); },
      async listCouncils() { return []; },
      async deleteCouncil() {},
      ApiError,
      async startCouncil(input) {
        f.launches.push(structuredClone(input));
        if (!f.created.has(input.requestId)) f.created.set(input.requestId, { id: input.requestId, question: input.question });
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
  modules['./attachments.tsx'] = await loadAttachments(modules);
  modules['./CouncilAdvisorList.tsx'] = await loadAdvisorList(modules);
  const { CouncilAdvisorList } = modules['./CouncilAdvisorList.tsx'];
  // Rendu hors montage : l'onglet actif est sans incidence, tous les panneaux sont dans l'arbre.
  inlined.set(CouncilAdvisorList, props => {
    const outer = current;
    current = { slots: [], effects: [], index: 0 };
    try { return CouncilAdvisorList(props); } finally { current = outer; }
  });
  modules['./CouncilSettingsDialog.tsx'] = await loadSettings(modules);
  const { CouncilLaunch } = await loadLaunch(modules);
  const form = CouncilLaunch({ projectId });
  f.launch = mount(form.type, form.props);
  await f.launch.settle();
  find(f.launch, node => node.type === 'textarea' && node.props.required).props.onChange({ target: { value: 'Quelle priorité ?' } });
  f.launch.render();
  f.selector = (view, id) => {
    const advisor = find(view, node => node.props.role === 'tabpanel' && node.key === id);
    return find({ tree: advisor }, node => node.type === LlmSelector);
  };
  f.choose = (id, value) => { f.selector(f.launch, id).props.onChange(value); f.launch.render(); };
  f.openSettings = async () => {
    button(f.launch, 'Réglages').props.onClick();
    f.launch.render();
    const dialog = find(f.launch, node => node.type === modules['./CouncilSettingsDialog.tsx'].CouncilSettingsDialog);
    return mount(dialog.type, dialog.props).settle();
  };
  f.dismiss = dialog => find(dialog, node => node.type === Modal).props.onClose();
  f.refreshPersonas = async () => {
    button(f.launch, 'Nouvelle persona').props.onClick();
    f.launch.render();
    find(f.launch, node => node.type === PersonasDialog).props.onChange();
    await f.launch.settle();
  };
  // Même réparation des réglages que CerebroDatabase.deletePersona.
  f.deletePersona = id => {
    f.personas = f.personas.filter(persona => persona.id !== id);
    f.globalSettings = withoutPersona(f.globalSettings, id, f.personas);
    if (f.projectSettings) f.projectSettings = withoutPersona(f.projectSettings, id, f.personas);
  };
  f.toggle = id => find({ tree: find(f.launch, node => node.props.role === 'tabpanel' && node.key === id) }, node => node.type === 'button' && node.props.className?.startsWith('council-advisor-toggle'));
  f.checked = () => nodes(f.launch.tree)
    .filter(node => node.props.role === 'tabpanel' && f.toggle(node.key).props.className.endsWith(' on'))
    .map(node => node.key);
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
    test(`les choix du lancement survivent à ${close} (${projectId ?? 'accueil'})`, async t => {
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
      assert.deepEqual(await f.convoke(), ids.map(personaId => ({ personaId, ...(personaId === 'one' ? CODEX : CLAUDE) })));
    });
  }

  test(`enregistrer rafraîchit les défauts et conserve les choix explicites (${projectId ?? 'accueil'})`, async t => {
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
      { personaId: 'one', ...CODEX }, { personaId: 'two', ...SONNET }, { personaId: 'three', ...CLAUDE },
    ]);
  });
}

test('revenir aux réglages globaux puis annuler conserve les choix et rafraîchit les défauts', async t => {
  const f = await fixture(t, 'project');
  f.globalSettings.assignments.two = GROK;
  f.choose('one', CODEX);
  const dialog = await f.openSettings();
  find(dialog, node => node.type === 'button' && node.props.title === 'Supprime les réglages propres à ce projet').props.onClick();
  await dialog.settle();
  button(dialog, 'Annuler').props.onClick();
  await f.launch.settle();
  assert.deepEqual(f.writes, ['reset']);
  assert.deepEqual(f.selector(f.launch, 'one').props.value, CODEX);
  assert.deepEqual(f.selector(f.launch, 'two').props.value, GROK);
  assert.deepEqual(await f.convoke(), [
    { personaId: 'one', ...CODEX }, { personaId: 'two', ...GROK }, { personaId: 'three', ...CLAUDE },
  ]);
});

test('un rafraîchissement du catalogue retire seulement les choix des personas supprimées', async t => {
  const f = await fixture(t);
  f.choose('one', CODEX);
  f.choose('two', SONNET);
  const dialog = await f.openSettings();
  const removed = f.personas.shift();
  button(dialog, 'Annuler').props.onClick();
  await f.launch.settle();
  assert.equal(nodes(f.launch.tree).some(node => node.type === 'li' && node.key === 'one'), false);
  assert.deepEqual(f.selector(f.launch, 'two').props.value, SONNET);
  // Le choix supprimé ne doit pas réapparaître si le même id revient dans le catalogue.
  f.personas.unshift(removed);
  await f.refreshPersonas();
  assert.deepEqual(f.selector(f.launch, 'one').props.value, CLAUDE);
  assert.deepEqual(f.selector(f.launch, 'two').props.value, SONNET);
  assert.deepEqual(await f.convoke(), [
    { personaId: 'one', ...CLAUDE }, { personaId: 'two', ...SONNET }, { personaId: 'three', ...CLAUDE },
  ]);
});

for (const projectId of [undefined, 'project']) {
  test(`un lancement réussi efface le brouillon enregistré avant la navigation (${projectId ?? 'accueil'})`, async t => {
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

test('une réponse perdue retrouve le council déjà créé sans le relancer', async t => {
  const f = await fixture(t, 'project');
  f.afterStart = lostResponse;
  submit(f.launch);
  await f.launch.settle();
  assert.equal(f.launches.length, 1);
  assert.equal(f.created.size, 1);
  const [requestId] = f.created.keys();
  assert.deepEqual(f.navigations, [`#/c/${requestId}`]);
  assert.equal(find(f.launch, node => node.type === 'textarea' && node.props.required).props.value, '');
});

test('une relance après une erreur de transport réutilise l’identifiant de la soumission', async t => {
  const f = await fixture(t, 'project');
  // Le serveur accepte le POST, puis devient injoignable : la réponse et la vérification échouent.
  f.afterStart = lostResponse;
  f.onGet = () => { throw new TypeError('Failed to fetch'); };
  submit(f.launch);
  await f.launch.settle();
  assert.deepEqual(f.navigations, []);
  assert.ok(nodes(f.launch.tree).some(node => node.props.role === 'alert' && node.props.children === 'Failed to fetch'));
  // Le réseau revient : Convoquer avec le même brouillon rend le premier council.
  f.afterStart = () => {};
  submit(f.launch);
  await f.launch.settle();
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1].requestId, f.launches[0].requestId);
  assert.equal(f.created.size, 1);
  assert.deepEqual(f.navigations, [`#/c/${f.launches[0].requestId}`]);
});

test('une soumission aux paramètres modifiés reçoit un nouvel identifiant', async t => {
  const f = await fixture(t);
  f.afterStart = lostResponse;
  f.onGet = () => { throw new TypeError('Failed to fetch'); };
  submit(f.launch);
  await f.launch.settle();
  // Un refus explicite du serveur ne déclenche pas de vérification et conserve l'identifiant.
  f.afterStart = () => { throw new ApiError(500, 'Erreur interne'); };
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

test('un nouveau lancement après un succès reçoit un nouvel identifiant', async t => {
  const f = await fixture(t);
  submit(f.launch);
  await f.launch.settle();
  find(f.launch, node => node.type === 'textarea' && node.props.required).props.onChange({ target: { value: 'Quelle priorité ?' } });
  f.launch.render();
  submit(f.launch);
  await f.launch.settle();
  assert.equal(f.launches.length, 2);
  assert.notEqual(f.launches[1].requestId, f.launches[0].requestId);
  assert.equal(f.created.size, 2);
});

// Quatre personas dont deux participent par défaut : supprimer l'une fait choisir un remplaçant au serveur.
const fourPersonas = f => {
  f.personas.push({ ...f.personas[0], id: 'four', name: 'four', prompt: 'four' });
  for (const settings of [f.globalSettings, f.projectSettings]) {
    settings.assignments.four = { ...CLAUDE };
    settings.defaultPersonaIds = ['one', 'two'];
  }
};

for (const projectId of [undefined, 'project']) {
  test(`supprimer un participant par défaut adopte le remplaçant des réglages (${projectId ?? 'accueil'})`, async t => {
    const f = await fixture(t, projectId, fourPersonas);
    assert.deepEqual(f.checked(), ['one', 'two']);
    f.choose('two', CODEX);
    if (projectId) {
      find(f.launch, node => node.type === 'input' && node.props.type === 'checkbox' && !node.props['aria-label']).props.onChange({ target: { checked: false } });
      f.launch.render();
    }
    button(f.launch, 'Nouvelle persona').props.onClick();
    f.launch.render();
    f.deletePersona('one');
    find(f.launch, node => node.type === f.PersonasDialog).props.onChange();
    await f.launch.settle();
    assert.deepEqual(f.checked(), ['two', 'three']);
    assert.equal(find(f.launch, node => node.type === 'button' && node.props.type === 'submit').props.disabled, false);
    assert.deepEqual(await f.convoke(), [{ personaId: 'two', ...CODEX }, { personaId: 'three', ...CLAUDE }]);
    assert.equal(f.launches[0].readProject, false);
  });
}

test('une sélection explicite ne suit pas le remplaçant choisi par le serveur', async t => {
  const f = await fixture(t, undefined, fourPersonas);
  f.toggle('four').props.onClick();
  f.launch.render();
  f.deletePersona('one');
  await f.refreshPersonas();
  assert.deepEqual(f.checked(), ['two', 'four']);
});

test('supprimer une persona depuis les réglages rafraîchit aussi le formulaire', async t => {
  const f = await fixture(t, 'project', fourPersonas);
  const dialog = await f.openSettings();
  button(dialog, 'Gérer les personas').props.onClick();
  dialog.render();
  f.deletePersona('one');
  find(dialog, node => node.type === f.PersonasDialog).props.onChange();
  await f.launch.settle();
  assert.deepEqual(f.checked(), ['two', 'three']);
});

test('les onglets distinguent les conseillers qui ne participent pas', async t => {
  const f = await fixture(t, undefined);
  const tab = id => find(f.launch, node => node.props.role === 'tab' && node.key === id);
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
  const panels = nodes(f.launch.tree).filter(node => node.props.role === 'tabpanel');
  assert.deepEqual(panels.filter(panel => !panel.props.hidden).map(panel => panel.key), ['one']);
});
