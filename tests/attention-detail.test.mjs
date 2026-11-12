import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-attention-detail-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');

const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { handleHook, summarizeToolUse } = await import('../server/hooks.ts');
const { parseSession } = await import('../shared/types.ts');

const db = new CerebroDatabase(':memory:');
const manager = new SessionManager(db, createServices(db));
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

const askInput = {
  questions: [
    {
      question: 'Arrondir la TVA ligne par ligne ou sur le total ?',
      header: 'Arrondi',
      multiSelect: false,
      options: [
        { label: 'Ligne par ligne', description: 'Comme les factures' },
        { label: 'Sur le total', description: 'Comme la compta' },
      ],
    },
  ],
};

test('une question AskUserQuestion est gardée avec la session, puis effacée quand le travail reprend', () => {
  session('question');
  handleHook(manager, 'question', 'claude', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: askInput });
  const waiting = db.getSession('question');
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.attentionDetail.kind, 'questions');
  assert.equal(waiting.attentionDetail.questions[0].options[1].label, 'Sur le total');

  handleHook(manager, 'question', 'claude', 'UserPromptSubmit', {});
  const running = db.getSession('question');
  assert.equal(running.status, 'running');
  assert.equal(running.attentionDetail, null);
});

test("la notification d'autorisation reprend l'outil et la commande annoncés par PermissionRequest", () => {
  session('permission');
  handleHook(manager, 'permission', 'claude', 'PermissionRequest', {
    tool_name: 'Bash',
    tool_input: { command: 'npx sharp-cli -i public/img/*.png -f webp', description: 'Convertir' },
  });
  // Rien n'est montré avant la notification : Claude peut encore accorder seul l'autorisation.
  assert.equal(db.getSession('permission').status, 'running');
  handleHook(manager, 'permission', 'claude', 'Notification', {
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use Bash',
  });
  const waiting = db.getSession('permission');
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.attentionReason, 'Claude needs your permission to use Bash');
  assert.deepEqual(waiting.attentionDetail, {
    kind: 'permission',
    tool: 'Bash',
    summary: 'npx sharp-cli -i public/img/*.png -f webp',
  });
});

test("sans PermissionRequest (session lancée avant le hook), l'autorisation reste affichée sans outil", () => {
  session('legacy-permission');
  handleHook(manager, 'legacy-permission', 'claude', 'Notification', {
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use Bash',
  });
  assert.deepEqual(db.getSession('legacy-permission').attentionDetail, {
    kind: 'permission',
    tool: null,
    summary: null,
  });
});

test('le dernier message du tour est gardé, tronqué, puis effacé à la fin de la session', () => {
  session('turn');
  const long = `Pagination ajoutée. ${'x'.repeat(1000)}`;
  handleHook(manager, 'turn', 'claude', 'Stop', { last_assistant_message: long });
  const idle = db.getSession('turn');
  assert.equal(idle.attentionReason, 'Tour terminé');
  assert.equal(idle.attentionDetail.kind, 'turn');
  assert.ok(idle.attentionDetail.message.startsWith('Pagination ajoutée.'));
  assert.equal(idle.attentionDetail.message.length, 600);
  assert.ok(idle.attentionDetail.message.endsWith('…'));

  manager.finishSession('turn', 0);
  assert.equal(db.getSession('turn').attentionDetail, null);
});

test('un second signal sans message garde le détail du tour', () => {
  session('second-signal');
  handleHook(manager, 'second-signal', 'claude', 'Stop', { last_assistant_message: 'Fini.' });
  handleHook(manager, 'second-signal', 'claude', 'Notification', { notification_type: 'idle_prompt' });
  assert.deepEqual(db.getSession('second-signal').attentionDetail, { kind: 'turn', message: 'Fini.' });
});

test("le résumé d'un outil nomme la commande ou le fichier visé", () => {
  assert.equal(summarizeToolUse('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(summarizeToolUse('Edit', { file_path: '/repo/a.ts', old_string: 'x' }), '/repo/a.ts');
  assert.equal(summarizeToolUse('WebFetch', { url: 'https://example.com' }), 'https://example.com');
  assert.equal(summarizeToolUse('Bash', { command: 'y'.repeat(500) }).length, 400);
  assert.equal(summarizeToolUse('Task', { prompt: 'p' }), null);
  assert.equal(summarizeToolUse('Bash', null), null);
});

test("une session reçue d'une instance antérieure, sans détail, reste valide", () => {
  const remote = { ...db.getSession('turn') };
  delete remote.attentionDetail;
  assert.equal(parseSession(remote).attentionDetail, null);
  assert.equal(parseSession({ ...remote, attentionDetail: { kind: 'inconnu' } }).attentionDetail, null);
});
