import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-questions-cleanup-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');

const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');

const db = new CerebroDatabase(':memory:');
const manager = new SessionManager(db);
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function session(projectId, id) {
  return db.createSession({ id, projectId, agent: 'claude', mode: 'auto', model: null, effort: null, prompt: '', title: id, status: 'running', agentSessionId: null }, 'token');
}

const question = [{ question: 'Quel choix ?', header: 'Choix', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }];

test('a question asked before the agent exited does not resurface after a resume', () => {
  const path = join(root, 'reprise');
  mkdirSync(path, { recursive: true });
  const project = db.createProject('Reprise', path);
  session(project.id, 'resumed');
  manager.markAsked('resumed', 'Ancienne question ?');
  manager.setPendingQuestions('resumed', question);

  manager.finishSession('resumed', 0);
  assert.equal(db.getSession('resumed').status, 'exited');
  assert.equal(manager.pendingQuestions('resumed'), null);

  // Reprise : la session redevient active, puis son premier tour se termine normalement.
  db.updateSession('resumed', { status: 'running', exitCode: null });
  const idle = manager.setReliableState('resumed', 'idle', 'Tour terminé');
  assert.equal(idle.status, 'idle');
  assert.equal(idle.attentionReason, 'Tour terminé');
});

test('deleting a project forgets the questions of its sessions', async () => {
  const path = join(root, 'suppression');
  mkdirSync(path, { recursive: true });
  const project = db.createProject('Suppression', path);
  session(project.id, 'deleted');
  manager.markAsked('deleted', 'Question orpheline ?');
  manager.setPendingQuestions('deleted', question);

  assert.equal(await manager.deleteProject(project.id), true);
  assert.equal(manager.pendingQuestions('deleted'), null);
  assert.equal(manager.askedQuestions.has('deleted'), false);
});
