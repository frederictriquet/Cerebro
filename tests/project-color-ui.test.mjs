import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as react from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import { moduleRunnerTransform, transformWithOxc } from 'vite';
import * as asyncAction from '../web/src/async-action.ts';
import * as format from '../web/src/format.ts';

// Composants rendus en mémoire avec le transformateur Vite : aucun DOM ni serveur.
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
const projects = [
  { id: 'red', name: 'Rouge', path: '/rouge', color: '#e5484d' },
  { id: 'plain', name: 'Sans couleur', path: '/plain', color: null },
];
const sessions = [
  {
    id: 's-red',
    projectId: 'red',
    agent: 'claude',
    title: 'Session rouge',
    status: 'waiting',
    attention: true,
    pendingFindings: 0,
    updatedAt: now,
    worktree: null,
  },
  {
    id: 's-plain',
    projectId: 'plain',
    agent: 'codex',
    title: 'Session neutre',
    status: 'idle',
    attention: true,
    pendingFindings: 0,
    updatedAt: now,
    worktree: null,
  },
];

const stub = () => null;
const store = {
  projects,
  sessions,
  connected: true,
  muted: false,
  setMuted() {},
  desktopNotif: false,
  setDesktopNotif() {},
  reorderProjects: async () => {},
};

const { ProjectTabs } = await (
  await compile('ProjectTabs')
)({
  react,
  'react/jsx-runtime': jsx,
  './Dialog.tsx': { Modal: stub },
  './format.ts': format,
  './NewProjectForm.tsx': { NewProjectForm: stub },
  './route.ts': { href: (path) => path },
  './store.tsx': { useStore: () => store },
  './async-action.ts': asyncAction,
});

const { Sidebar } = await (
  await compile('Sidebar')
)({
  react,
  'react/jsx-runtime': jsx,
  './AdvisorSettings.tsx': { AdvisorPanel: stub, useAdvisor: () => ({ model: null, setModel() {} }) },
  './AgentLabel.tsx': { AgentLabel: ({ agent }) => agent },
  './api.ts': {
    acquireGeneralSlack: async () => {},
    getGeneralSlack: async () => null,
    getSlackStatus: async () => null,
    updateSlackSettings: async () => null,
  },
  './format.ts': format,
  './MachineSwitcher.tsx': { AppVersion: stub, MachineSwitcher: stub },
  './route.ts': { href: (path) => path },
  './polling.tsx': { useNow: () => now },
  './StatusDot.tsx': { StatusDot: stub },
  './store.tsx': { useStore: () => store },
  './UsageGauges.tsx': { UsageGauges: stub },
  './SidebarTodos.tsx': { SidebarTodos: stub },
  './WorktreeLabel.tsx': { WorktreeLabel: stub },
  './SessionEpicBadge.tsx': { SessionEpicBadge: stub },
  './SlackWatchSettings.tsx': {
    NumberSetting: stub,
    SLACK_ALERT_TOGGLES: [],
    SlackWatchSettings: stub,
  },
  './ProjectSlackDialog.tsx': { projectSlackLabel: () => '' },
  './SessionMeta.tsx': {
    attentionTone: (session) => (session.status === 'waiting' ? 'waiting' : 'idle'),
    SessionAttention: stub,
  },
});

test('la liste À traiter et l’onglet du projet portent la couleur du projet', () => {
  const sidebar = renderToStaticMarkup(react.createElement(Sidebar, { route: { kind: 'home' }, onNavigate() {} }));
  assert.match(sidebar, /<li class="attention-item colored" style="--project-color:#e5484d">/);
  assert.match(sidebar, /Session rouge/);
  assert.match(sidebar, /<li class="attention-item">/);
  assert.match(sidebar, /Session neutre/);

  const tabs = renderToStaticMarkup(react.createElement(ProjectTabs, { route: { kind: 'project', projectId: 'red' } }));
  assert.match(
    tabs,
    /<a class="project-tab colored active alert waiting" style="--project-color:#e5484d" href="#\/p\/red"/,
  );
  assert.match(tabs, /<a class="project-tab alert idle" href="#\/p\/plain"/);
  assert.doesNotMatch(tabs, /--project-color:[^"]*" href="#\/p\/plain"/);
});

test('le fond teinté des deux endroits lit la même variable de couleur', async () => {
  const css = await readFile(new URL('../web/src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.attention-item\.colored \{[^}]*var\(--project-color\)/);
  const inactive = css.match(/\.project-tab\.colored \{[^}]*\}/)?.[0] ?? '';
  assert.match(inactive, /var\(--project-color\)/);
  assert.doesNotMatch(inactive, /inset/);
  assert.match(css, /\.project-tab\.active \{[^}]*outline:\s*3px solid var\(--text\)/);
  assert.match(css, /\.project-tab\.colored\.active \{[^}]*inset 0 -6px 0 var\(--project-color\)/);
});
