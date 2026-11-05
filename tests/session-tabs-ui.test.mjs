import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as react from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import { moduleRunnerTransform, transformWithOxc } from 'vite';
import * as format from '../web/src/format.ts';
import * as sessionGroups from '../web/src/session-groups.ts';

// Onglets de sessions rendus en mémoire avec le transformateur Vite : aucun DOM ni serveur.
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

const now = 1_800_000_000_000;
let storeSessions = [];

const { StatusDot } = await (await compile('StatusDot'))({ 'react/jsx-runtime': jsx, './format.ts': format });
const { SessionTabs } = await (
  await compile('SessionTabs')
)({
  react,
  'react/jsx-runtime': jsx,
  './format.ts': format,
  './polling.tsx': { useNow: () => now },
  './route.ts': { href: (path) => path },
  './session-groups.ts': sessionGroups,
  './SessionMeta.tsx': { attentionTone: (session) => (session.status === 'waiting' ? 'waiting' : 'idle') },
  './StatusDot.tsx': { StatusDot },
  './store.tsx': { useStore: () => ({ sessions: storeSessions }) },
});

const session = (id, projectId, overrides = {}) => ({
  id,
  projectId,
  agent: 'claude',
  mode: 'auto',
  model: null,
  effort: null,
  prompt: '',
  title: `Titre ${id}`,
  status: 'running',
  attention: false,
  protected: false,
  pinned: false,
  attentionReason: null,
  agentSessionId: null,
  exitCode: null,
  createdAt: now,
  updatedAt: now,
  worktree: null,
  epic: null,
  pendingFindings: 0,
  ...overrides,
});

const render = (route, sessions) => {
  storeSessions = sessions;
  return renderToStaticMarkup(react.createElement(SessionTabs, { route }));
};

const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);

test('les onglets listent les sessions du projet de la session ouverte, dans l’ordre du store', () => {
  const html = render({ kind: 'session', sessionId: 'a1' }, [
    session('a2', 'A'),
    session('b1', 'B'),
    session('a1', 'A', { status: 'exited' }),
  ]);
  assert.match(html, /<nav class="session-tabs" aria-label="Sessions du projet">/);
  assert.deepEqual(hrefs(html), ['#/s/a2', '#/s/a1']);
  assert.match(html, /<a class="session-tab active" href="#\/s\/a1" aria-current="page" title="Titre a1">/);
  assert.match(html, /<a class="session-tab" href="#\/s\/a2" title="Titre a2">/);
  assert.match(html, /class="dot exited"/);
  assert.doesNotMatch(html, /Titre b1/);
});

test('aucune rangée hors d’une session ou quand la session est seule dans son projet', () => {
  const sessions = [session('a1', 'A'), session('a2', 'A'), session('b1', 'B')];
  assert.equal(render({ kind: 'session', sessionId: 'b1' }, sessions), '');
  assert.equal(render({ kind: 'project', projectId: 'A' }, sessions), '');
  assert.equal(render({ kind: 'home' }, sessions), '');
  assert.equal(render({ kind: 'session', sessionId: 'inconnue' }, sessions), '');
});

test('une étape d’epic affiche son numéro sans le préfixe commun, titre complet en infobulle', () => {
  const step = (id, n) =>
    session(id, 'A', {
      prompt: `[CEREBRO_EPIC_STEP run task-${n}]\nTraite uniquement cette étape…`,
      title: `Epic « Refonte du stockage » · étape ${n}/3 : Migrer la table ${n}`,
      epic: { id: 'e1', title: 'Refonte du stockage' },
    });
  const html = render({ kind: 'session', sessionId: 's1' }, [step('s2', 2), step('s1', 1)]);
  assert.match(html, /title="Epic « Refonte du stockage » · étape 2\/3 : Migrer la table 2">/);
  assert.match(html, /<span class="session-tab-title">étape 2\/3 : Migrer la table 2<\/span>/);
  assert.match(html, /<span class="session-tab-title">étape 1\/3 : Migrer la table 1<\/span>/);
});

test('une session qui demande l’attention porte le ton de son alerte et sa raison', () => {
  const html = render({ kind: 'session', sessionId: 'a1' }, [
    session('a1', 'A'),
    session('a2', 'A', { status: 'waiting', attention: true, attentionReason: 'Autorisation demandée' }),
    session('a3', 'A', { status: 'idle', attention: true }),
  ]);
  assert.match(html, /<a class="session-tab alert waiting" href="#\/s\/a2" title="Titre a2\nAutorisation demandée">/);
  assert.match(html, /<a class="session-tab alert idle" href="#\/s\/a3" title="Titre a3">/);
});
