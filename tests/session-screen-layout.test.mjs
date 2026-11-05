import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Aucun agent ni configuration réels : tout vit dans un dossier temporaire.
const root = mkdtempSync(join(tmpdir(), 'cerebro-screen-layout-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;

const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { buildServer } = await import('../server/index.ts');

const db = new CerebroDatabase(':memory:');
const project = db.createProject('Demo', root);
const manager = new SessionManager(db, createServices(db));
const runtimes = [];
after(() => {
  for (const runtime of runtimes) runtime.terminal.dispose();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** Session dont le terminal (32 rangées) affiche `lines`, une par rangée. */
async function screen(lines) {
  const id = randomUUID();
  db.createSession(
    {
      id,
      projectId: project.id,
      agent: 'claude',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: 'Écran',
      status: 'idle',
      agentSessionId: null,
    },
    'token',
  );
  const runtime = manager.newRuntime('claude');
  runtimes.push(runtime);
  manager.runtimes.set(id, runtime);
  await new Promise((resolve) => runtime.terminal.write(lines.join('\r\n'), resolve));
  return id;
}

const DIALOG = [' Do you want to proceed?   ', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'];

test('layout : indentation et ligne vide interne conservées, vides de fin retirés', async () => {
  // Cinq lignes en haut d'un écran de 32 rangées : la fenêtre part de la dernière ligne non vide.
  const id = await screen(DIALOG);
  assert.deepEqual(manager.screenText(id, 10, { layout: true }), [
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel',
  ]);
  assert.deepEqual(manager.screenText(id, 2, { layout: true }), ['', ' Esc to cancel']);
});

test('layout : la borne N est respectée et le scrollback est lu', async () => {
  const lines = Array.from({ length: 60 }, (_, index) => (index === 45 ? '' : `  ligne ${index}`));
  const id = await screen(lines);
  const fifty = manager.screenText(id, 50, { layout: true });
  assert.equal(fifty.length, 50);
  // La ligne 10 est au-dessus du viewport (rangées 28 à 59).
  assert.equal(fifty[0], '  ligne 10');
  assert.equal(fifty[35], '');
  assert.equal(fifty.at(-1), '  ligne 59');
  assert.deepEqual(manager.screenText(id, 3, { layout: true }), ['  ligne 57', '  ligne 58', '  ligne 59']);
  assert.deepEqual(manager.screenText(id, 200, { layout: true }), lines);
});

test('le mode par défaut reste inchangé : viewport seul, lignes rognées, sans vide, 20 au plus', async () => {
  assert.deepEqual(manager.screenText(await screen(DIALOG)), [
    'Do you want to proceed?',
    '❯ 1. Yes',
    '2. No',
    'Esc to cancel',
  ]);
  const lines = Array.from({ length: 60 }, (_, index) => (index === 45 ? '' : `  ligne ${index}`));
  const expected = [39, 40, 41, 42, 43, 44, ...Array.from({ length: 14 }, (_, index) => 46 + index)].map(
    (index) => `ligne ${index}`,
  );
  assert.deepEqual(manager.screenText(await screen(lines)), expected);
});

test('sans terminal vivant, screenText renvoie null dans les deux modes', () => {
  assert.equal(manager.screenText('absente'), null);
  assert.equal(manager.screenText('absente', 10, { layout: true }), null);
});

test('route : ?lines doit être un entier de 1 à 200', async () => {
  const app = await buildServer();
  const status = async (query) =>
    (await app.inject({ method: 'GET', url: `/api/sessions/${randomUUID()}/screen${query}` })).statusCode;
  try {
    for (const query of [
      '?lines=0',
      '?lines=201',
      '?lines=abc',
      '?lines=1e2',
      '?lines=5.0',
      '?lines=',
      '?lines=1&lines=2',
    ]) {
      assert.equal(await status(query), 400, query);
    }
    // Paramètre valide ou absent : la validation passe, puis la session inconnue donne 404.
    for (const query of ['', '?lines=1', '?lines=5', '?lines=200']) assert.equal(await status(query), 404, query);
  } finally {
    await app.close();
  }
});
