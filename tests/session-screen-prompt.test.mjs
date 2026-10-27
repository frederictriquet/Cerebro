import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-screen-prompt-'));
process.env.CEREBRO_DATA_DIR = root;
const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');

const db = new CerebroDatabase(':memory:');
const project = db.createProject('Demo', root);
const manager = new SessionManager(db);
const alerts = [];
manager.onEvent((event) => { if (event.type === 'alert') alerts.push(event.session.id); });
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// Bas d'écran de Claude Code quand il attend une saisie (tour fini ou en cours).
const CLAUDE_COMPOSER = ['', '─'.repeat(80), '❯ ', '─'.repeat(80), '  Opus 5.5 | 70k/1000k', '  ⏵⏵ auto mode on (shift+tab to cycle)'];

/** Draws `lines` on a fresh terminal of a session in `status`, then runs the 2 s screen check. */
async function inspect(status, lines, { agent = 'claude', alternate = false } = {}) {
  const id = randomUUID();
  db.createSession({ id, projectId: project.id, agent, mode: 'auto', model: null, effort: null, prompt: '', title: 'Écran', status, agentSessionId: null }, 'token');
  const runtime = manager.newRuntime(agent);
  manager.runtimes.set(id, runtime);
  const data = (alternate ? '\x1b[?1049h\x1b[H' : '') + lines.join('\r\n');
  await new Promise((resolve) => runtime.terminal.write(data, resolve));
  manager.inspectScreen(id, runtime);
  manager.runtimes.delete(id);
  runtime.terminal.dispose();
  return { session: db.getSession(id), alerted: alerts.includes(id) };
}

test('transcript text matching a dialog pattern does not make an idle session wait', async () => {
  const { session, alerted } = await inspect('idle', [
    '❯ 1. Reproduire avec cat, 2. corriger la détection',
    '● Bash(cat prompt.sh)',
    '  ⎿  read -p "Continue? (y/n) " answer',
    '     Do you want to proceed?',
    '     Enter to confirm · Esc to cancel',
    '● La détection affichait « (y/n) » comme une question.',
    ...CLAUDE_COMPOSER,
  ]);
  assert.equal(session.status, 'idle');
  assert.equal(alerted, false);
});

test('a running agent printing a pattern above its composer keeps running', async () => {
  const { session, alerted } = await inspect('running', [
    '● Bash(cat CHANGELOG.md)',
    '  ⎿  - Ask (y/n) before overwriting',
    '     … +40 lines (ctrl+o to expand)',
    '✶ Razzmatazzing… (12s · esc to interrupt)',
    ...CLAUDE_COMPOSER,
  ]);
  assert.equal(session.status, 'running');
  assert.equal(alerted, false);
});

test('an old pattern scrolled far above the bottom lines is ignored', async () => {
  const { session } = await inspect('idle', [
    'Do you want to proceed? (y/n)',
    ...Array.from({ length: 20 }, (_, index) => `ligne ${index}`),
  ]);
  assert.equal(session.status, 'idle');
});

test('a Claude permission dialog at the bottom of the screen still makes the session wait', async () => {
  const { session, alerted } = await inspect('running', [
    '❯ Lance les tests',
    '● Bash(npm test)',
    '─'.repeat(80),
    ' Bash command',
    '',
    '   npm test',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don\'t ask again for npm test commands',
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel · Tab to amend',
  ]);
  assert.equal(session.status, 'waiting');
  assert.equal(session.attentionReason, 'Do you want to proceed?');
  assert.equal(alerted, true);
});

test('a Codex approval dialog makes the session wait', async () => {
  const { session } = await inspect('running', [
    '› Lance les tests',
    '• Running npm test',
    'Would you like to run the following command?',
    '  $ npm test',
    '› 1. Yes, proceed (y)',
    '  2. No, and tell Codex what to do differently (esc)',
    'Press enter to confirm or esc to cancel',
  ], { agent: 'codex' });
  assert.equal(session.status, 'waiting');
  assert.equal(session.attentionReason, 'Would you like to run the following command?');
});

test('a full-screen TUI dialog drawn at the top is still detected', async () => {
  const { session } = await inspect('running', [
    'Do you trust the files in this folder?',
    '  1. Yes  2. No',
    ...Array.from({ length: 20 }, () => ''),
    '> ',
  ], { agent: 'grok', alternate: true });
  assert.equal(session.status, 'waiting');
  assert.equal(session.attentionReason, 'Do you trust the files in this folder?');
});
