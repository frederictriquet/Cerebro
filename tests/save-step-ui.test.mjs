import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as react from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import { moduleRunnerTransform, transformWithOxc } from 'vite';
import * as format from '../web/src/format.ts';
import * as model from '../web/src/worktrees/model.ts';
import * as git from '../shared/git.ts';

// L'étape 1 des « Étapes » rendue en mémoire avec le transformateur Vite : aucun DOM ni serveur.
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
const { WorktreeDiffs } = await (
  await compile('worktrees/WorktreeDiffs')
)({
  react,
  'react/jsx-runtime': jsx,
  '../../../shared/git.ts': git,
  '../ActivityStatus.tsx': { ActivityStatus: ({ children }) => children },
  '../api.ts': { apiParsed: () => Promise.reject(new Error('non appelé')) },
  '../format.ts': format,
});
const { SaveStep } = await (
  await compile('worktrees/SaveStep')
)({
  'react/jsx-runtime': jsx,
  '../route.ts': { href: (path) => path },
  '../format.ts': format,
  './model.ts': model,
  './Step.tsx': { Step },
  './WorktreeDiffs.tsx': { WorktreeDiffs },
});

// Copie d'un epic dont la conversation a créé deux icônes, sans contenu copié du projet.
const copy = (overrides = {}) => ({
  id: 'copy',
  path: '/copies/epic',
  dirty: 2,
  ahead: 2,
  behind: 0,
  error: null,
  primary: false,
  mergeInProgress: false,
  integration: 'pending',
  integrationConflicts: null,
  targetBranch: 'refs/heads/master',
  mergeBlockers: ['La copie contient 2 fichier(s) modifié(s) non commité(s) : commitez-les.'],
  startingContent: [],
  changesSinceCreation: {
    count: 2,
    files: ['web/public/icon-192.png', 'web/public/icon-512.png'],
    inheritedCount: 0,
    needsReviewCount: 0,
  },
  ...overrides,
});
// Le bouton du panneau, distinct du texte qui le cite entre guillemets.
const diffsButton = />Voir les diffs</;
const render = (view, showDetails = true) =>
  renderToStaticMarkup(
    react.createElement(SaveStep, {
      view,
      plan: model.journey(view),
      target: 'master',
      result: undefined,
      resolver: undefined,
      commitBlocked: false,
      showDetails,
      actions: {},
    }),
  );

test('le travail de la conversation garde un examen manuel pour les fichiers que le commit automatique écarte', () => {
  const html = render(copy());
  assert.match(html, /Créer le commit/);
  assert.match(html, /Il écarte aussi les fichiers qu’il ne peut pas inspecter/);
  assert.match(html, diffsButton);
});

test('le panneau des diffs reste replié tant que la copie n’est pas dépliée', () => {
  const html = render(copy(), false);
  assert.match(html, /Il écarte aussi les fichiers qu’il ne peut pas inspecter/);
  assert.doesNotMatch(html, diffsButton);
});

test('une copie sans changement non commité ne propose aucun examen', () => {
  const html = render(
    copy({ dirty: 0, changesSinceCreation: { ...copy().changesSinceCreation, count: 0, files: [] } }),
  );
  assert.match(html, /Aucun changement non commité/);
  assert.doesNotMatch(html, diffsButton);
});

test('une mise à jour en cours masque l’examen de l’étape 1', () => {
  const html = render(copy({ mergeInProgress: true, conflicts: [], remainingMarkers: [], resolver: null }));
  assert.doesNotMatch(html, diffsButton);
});
