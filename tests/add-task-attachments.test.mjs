import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import * as jsx from 'react/jsx-runtime';
import { moduleRunnerTransform, transformWithOxc } from 'vite';

// Exécute le vrai AddTaskDialog et ses handlers en mémoire, sans DOM ni serveur.
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

const [loadDialog, loadAttachments, loadAsyncAction, loadUseLatest] = await Promise.all([
  compile('Dialog'),
  compile('attachments'),
  compile('async-action', 'ts'),
  compile('use-latest', 'ts'),
]);

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (tree === null || typeof tree !== 'object' || !tree.props) return [];
  return [tree, ...nodes(tree.props.children)];
}

function find(view, predicate) {
  const node = nodes(view.tree).find(predicate);
  assert.ok(node, 'Élément attendu absent du formulaire');
  return node;
}

async function fixture() {
  const f = { uploads: [], tasks: [], closed: 0 };
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
    useCallback: (fn) => fn,
    useRef(initial) {
      const { slots } = current;
      const index = current.index++;
      if (index === slots.length) slots.push({ current: initial });
      return slots[index];
    },
    // Pas de montage : les effets (ouverture de la modale, nettoyage) ne sont pas exécutés ;
    // seuls ceux sans dépendances (resynchronisation d'une ref à chaque rendu) le sont, après le rendu.
    useEffect(effect, deps) {
      const { slots } = current;
      if (current.index++ === slots.length) slots.push(null);
      if (deps === undefined) current.effects.push(effect);
    },
    // Sans commit à simuler, useLatest met sa ref à jour dès le rendu.
    useInsertionEffect(effect) {
      effect();
    },
  };
  const store = {
    projects: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    async createTask(projectId, text, { sourceSessionId } = {}) {
      f.tasks.push({ projectId, text, source: sourceSessionId });
    },
  };
  let uploaded = 0;
  const modules = {
    react: hooks,
    'react/jsx-runtime': jsx,
    './ActivityStatus.tsx': { ActivityStatus() {} },
    './NewSessionForm.tsx': { NewSessionForm() {} },
    './store.tsx': { useStore: () => store },
    './keys.ts': { isSubmitShortcut: () => false, SUBMIT_HINT: '' },
    './format.ts': await import('../web/src/format.ts'),
    '../../shared/git.ts': { parseOptionalWorkspaceContext: () => null },
    './api.ts': {
      api: async () => null,
      apiParsed: async () => null,
      clipboardImage: (data) => data.image,
      // Chemin comme celui du serveur : sous le dossier du projet destinataire.
      uploadProjectImage(projectId, image) {
        uploaded += 1;
        const path = `/data/attachments/project-${projectId}/${uploaded}.png`;
        let resolve;
        const promise = new Promise((r) => {
          resolve = r;
        });
        f.uploads.push({ projectId, image, path, resolve: () => resolve(path) });
        return promise;
      },
    },
  };
  modules['./use-latest.ts'] = await loadUseLatest(modules);
  modules['./attachments.tsx'] = await loadAttachments(modules);
  modules['./async-action.ts'] = await loadAsyncAction(modules);
  const { AddTaskDialog } = await loadDialog(modules);
  const state = { slots: [], effects: [], index: 0 };
  f.view = {
    tree: null,
    render() {
      state.index = 0;
      current = state;
      try {
        this.tree = AddTaskDialog({
          projectId: 'a',
          initialText: 'Constat ',
          onClose: () => {
            f.closed++;
          },
        });
      } finally {
        current = null;
      }
      for (const effect of state.effects.splice(0)) effect();
      return this;
    },
  }.render();
  const textarea = () => find(f.view, (node) => node.type === 'textarea');
  f.paste = (image) => {
    textarea().props.onPaste({
      clipboardData: { image },
      preventDefault() {},
      currentTarget: { selectionStart: 8, selectionEnd: 8 },
    });
    f.view.render();
  };
  f.select = (value) => {
    find(f.view, (node) => node.type === 'select').props.onChange({ target: { value } });
    f.view.render();
  };
  f.selectDisabled = () => find(f.view, (node) => node.type === 'select').props.disabled;
  f.text = () => textarea().props.value;
  f.submit = async () => {
    find(f.view, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await setImmediate();
    f.view.render();
  };
  f.settle = async () => {
    await setImmediate();
    f.view.render();
  };
  return f;
}

test('changer de backlog renvoie les images vers le projet choisi', async () => {
  const f = await fixture();
  const image = new Blob(['png'], { type: 'image/png' });
  f.paste(image);
  assert.equal(f.text(), 'Constat [Image #1] ');
  assert.deepEqual(
    f.uploads.map((u) => u.projectId),
    ['a'],
  );
  f.uploads[0].resolve();
  await f.settle();
  assert.equal(f.selectDisabled(), false);

  f.select('b');
  assert.deepEqual(
    f.uploads.map((u) => u.projectId),
    ['a', 'b'],
  );
  assert.equal(f.uploads[1].image, image, 'le fichier d’origine est renvoyé');
  assert.equal(f.selectDisabled(), true, 'envoi en cours : la cible est figée');
  await f.submit();
  assert.deepEqual(f.tasks, [], 'pas d’ajout tant que le renvoi n’est pas terminé');

  f.uploads[1].resolve();
  await f.settle();
  await f.submit();
  assert.deepEqual(f.tasks, [
    { projectId: 'b', text: 'Constat /data/attachments/project-b/2.png ', source: undefined },
  ]);
  assert.equal(f.closed, 1);
});

test('revenir au projet initial renvoie aussi les images, et une réponse remplacée est ignorée', async () => {
  const f = await fixture();
  f.paste(new Blob(['png'], { type: 'image/png' }));
  f.uploads[0].resolve();
  await f.settle();
  f.select('b');
  f.uploads[1].resolve();
  await f.settle();
  f.select('a');
  assert.deepEqual(
    f.uploads.map((u) => u.projectId),
    ['a', 'b', 'a'],
  );
  // Une réponse tardive d'un envoi déjà remplacé ne doit pas réécrire le chemin.
  f.uploads[1].resolve();
  await f.settle();
  assert.equal(f.selectDisabled(), true);
  f.uploads[2].resolve();
  await f.settle();
  await f.submit();
  assert.deepEqual(
    f.tasks.map((t) => t.text),
    ['Constat /data/attachments/project-a/3.png '],
  );
});

test('sans image, changer de backlog n’envoie rien', async () => {
  const f = await fixture();
  f.select('b');
  assert.deepEqual(f.uploads, []);
  await f.submit();
  assert.deepEqual(
    f.tasks.map((t) => t.projectId),
    ['b'],
  );
});
