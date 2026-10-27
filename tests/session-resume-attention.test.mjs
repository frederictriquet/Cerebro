import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-resume-attention-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');

const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { handleHook } = await import('../server/hooks.ts');

const db = new CerebroDatabase(':memory:');
const manager = new SessionManager(db);
const project = db.createProject('Demo', root);
const events = [];
manager.onEvent((event) => events.push(event));
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function session(id) {
  return db.createSession({ id, projectId: project.id, agent: 'claude', mode: 'auto', model: null, effort: null, prompt: '', title: id, status: 'running', agentSessionId: null }, 'token');
}

// SPEC « Retour à running » : la reprise efface l'attention, même si la session n'a jamais été ouverte.
for (const event of ['PostToolUse', 'UserPromptSubmit']) {
  test(`${event} on an unseen waiting session resumes it and clears its attention without alert`, () => {
    const id = `waiting-${event}`;
    session(id);
    handleHook(manager, id, 'claude', 'Notification', { notification_type: 'permission_prompt', message: 'Permission demandée : Bash' });
    const waiting = db.getSession(id);
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.attention, true);

    // Permission accordée ailleurs (Slack, autre terminal) : l'agent reprend.
    events.length = 0;
    handleHook(manager, id, 'claude', event, {});
    const resumed = db.getSession(id);
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.attention, false);
    assert.equal(resumed.attentionReason, null);
    assert.equal(events.some((e) => e.type === 'alert'), false);
    assert.equal(events.some((e) => e.type === 'session' && e.session.id === id && !e.session.attention), true);
  });
}
