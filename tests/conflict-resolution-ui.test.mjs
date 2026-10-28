import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as react from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import { moduleRunnerTransform, transformWithOxc } from 'vite';
import * as format from '../web/src/format.ts';
import * as model from '../web/src/worktrees/model.ts';
import * as types from '../shared/types.ts';

// L'étape 2 des « Étapes » rendue en mémoire avec le transformateur Vite : aucun DOM ni serveur.
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

const { Step } = await (await compile('worktrees/Step'))({ 'react/jsx-runtime': jsx });
const { UpdateStep } = await (
  await compile('worktrees/UpdateStep')
)({
  react,
  'react/jsx-runtime': jsx,
  '../../../shared/types.ts': types,
  '../ActivityStatus.tsx': { ActivityStatus: ({ children }) => children },
  '../api.ts': { ApiError: class extends Error {}, apiParsed: () => Promise.reject(new Error('non appelé')) },
  '../async-action.ts': { useAsyncAction: () => ({ run: async () => true, busy: false, error: null }) },
  '../format.ts': format,
  // Sans machine affichée, un lien garde son chemin.
  '../route.ts': { href: (path) => path },
  './model.ts': model,
  './Step.tsx': { Step },
});

const merging = (overrides = {}) => ({
  id: 'copy',
  mergeInProgress: true,
  conflicts: ['a.ts', 'b.ts'],
  remainingMarkers: ['b.ts'],
  resolver: null,
  session: { id: 'origin', title: 'Conversation', status: 'idle' },
  integrationConflicts: null,
  integrationNote: null,
  ...overrides,
});
const render = (view) =>
  renderToStaticMarkup(
    react.createElement(UpdateStep, {
      view,
      plan: { update: 'todo' },
      target: 'master',
      disabled: false,
      commitBlocked: false,
      actions: {},
    }),
  );
const resolver = (status) => ({ sessionId: 'fixer', title: 'Conflits · Conversation', status });

test('sans session de résolution : fichiers résolus ou marqués, et le bouton qui la lance', () => {
  const html = render(merging());
  assert.match(html, /<code>a\.ts<\/code><span class="pill resolved">résolu<\/span>/);
  assert.match(html, /<code>b\.ts<\/code><span class="pill marked">marqueurs restants<\/span>/);
  assert.match(html, /Résoudre avec l’IA/);
  assert.match(html, /elle ne commite rien/);
  assert.match(html, /Terminer la mise à jour/);
  assert.match(html, /Annuler la mise à jour/);
});

test('un fichier indexé avec des marqueurs reste listé comme à terminer', () => {
  const html = render(merging({ conflicts: [], remainingMarkers: ['staged.ts'] }));
  assert.match(html, /<code>staged\.ts<\/code><span class="pill marked">marqueurs restants<\/span>/);
  assert.doesNotMatch(html, /Les conflits sont résolus/);
  // Le serveur ne lance une session que pour des fichiers en conflit.
  assert.doesNotMatch(html, /Résoudre avec l’IA/);
});

test('session de résolution au travail, puis inactive avec ou sans marqueurs', () => {
  const running = render(merging({ resolver: resolver('running') }));
  assert.match(running, /Session de résolution : <a href="#\/s\/fixer">Conflits · Conversation<\/a> \(en cours\)/);
  assert.match(running, /attendez la fin de son tour/);
  assert.doesNotMatch(running, /Résoudre avec l’IA/);

  const marked = render(merging({ resolver: resolver('idle') }));
  assert.match(marked, /Il reste des marqueurs dans 1 fichier : ouvrez la session pour l’aider/);

  const clean = render(merging({ resolver: resolver('idle'), remainingMarkers: [] }));
  assert.match(clean, /Tous les conflits sont résolus : relisez puis terminez la mise à jour/);
  assert.doesNotMatch(clean, /marqueurs restants/);
});

test('une session de résolution terminée peut être relayée par une autre', () => {
  const html = render(merging({ resolver: resolver('exited') }));
  assert.match(html, /\(terminé\)/);
  assert.match(html, /Résoudre avec l’IA/);
});

test('le prochain geste du parcours mentionne la session de résolution', () => {
  const view = (overrides) => ({
    ...merging(overrides),
    changesSinceCreation: null,
    startingContent: null,
    targetBranch: 'refs/heads/master',
    mergeBlockers: [],
    error: null,
  });
  assert.match(model.journey(view()).next, /avec « Résoudre avec l’IA »/);
  assert.match(model.journey(view({ resolver: resolver('running') })).next, /« Conflits · Conversation » résout/);
  assert.match(model.journey(view({ resolver: resolver('idle') })).next, /Il reste des marqueurs dans 1 fichier/);
  assert.match(
    model.journey(view({ resolver: resolver('idle'), remainingMarkers: [] })).next,
    /a retiré tous les marqueurs/,
  );
});
