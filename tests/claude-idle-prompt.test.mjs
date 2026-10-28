import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-idle-prompt-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');

const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { handleHook } = await import('../server/hooks.ts');

const db = new CerebroDatabase(':memory:');
const manager = new SessionManager(db, createServices(db));
const alerts = [];
manager.onEvent((event) => {
  if (event.type === 'alert') alerts.push(event.session.id);
});
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const path = join(root, 'projet');
mkdirSync(path, { recursive: true });
const project = db.createProject('Projet', path);

function session(id) {
  return db.createSession(
    {
      id,
      projectId: project.id,
      agent: 'claude',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: id,
      status: 'running',
      agentSessionId: null,
    },
    'token',
  );
}

const idlePrompt = { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' };

test('idle_prompt after an acknowledged Stop neither alerts again nor shows its message', () => {
  session('seen');
  handleHook(manager, 'seen', 'claude', 'Stop', { last_assistant_message: 'Fini' });
  manager.seen('seen');
  alerts.length = 0;

  handleHook(manager, 'seen', 'claude', 'Notification', idlePrompt);
  const after = db.getSession('seen');
  assert.equal(after.status, 'idle');
  assert.equal(after.attention, false);
  assert.equal(after.attentionReason, 'Tour terminé');
  assert.deepEqual(alerts, []);
});

test('idle_prompt ends the turn when its Stop was lost, with the generic reason', () => {
  session('lost-stop');
  alerts.length = 0;

  handleHook(manager, 'lost-stop', 'claude', 'Notification', idlePrompt);
  const after = db.getSession('lost-stop');
  assert.equal(after.status, 'idle');
  assert.equal(after.attention, true);
  assert.equal(after.attentionReason, 'Tour terminé');
  assert.deepEqual(alerts, ['lost-stop']);
});

test('idle_prompt does not downgrade a session waiting for an answer', () => {
  session('question');
  handleHook(manager, 'question', 'claude', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {} });
  handleHook(manager, 'question', 'claude', 'Notification', idlePrompt);
  const after = db.getSession('question');
  assert.equal(after.status, 'waiting');
  assert.equal(after.attentionReason, 'Question');
});
