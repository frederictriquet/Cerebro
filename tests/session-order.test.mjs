import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-order-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;

const { CerebroDatabase } = await import('../server/db.ts');

after(() => rmSync(root, { recursive: true, force: true }));

test('les sessions restent dans l’ordre de création après une mise à jour plus récente', () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Projet', root);
    const base = {
      projectId: project.id, agent: 'claude', mode: 'auto', model: null, effort: null,
      prompt: 'p', status: 'idle', agentSessionId: null,
    };
    db.createSession({ ...base, id: 'older', title: 'ancienne' }, 't');
    db.createSession({ ...base, id: 'newer', title: 'récente' }, 't');
    db.connection.exec("UPDATE sessions SET created_at = 10, updated_at = 10 WHERE id = 'older'");
    db.connection.exec("UPDATE sessions SET created_at = 20, updated_at = 20 WHERE id = 'newer'");
    db.updateSession('older', { title: 'touchée ensuite' });
    assert.ok(db.getSession('older').updatedAt > db.getSession('newer').updatedAt);
    assert.deepEqual(db.listSessions().map((session) => session.id), ['newer', 'older']);
    assert.deepEqual(db.listProjectSessions(project.id).map((session) => session.id), ['newer', 'older']);
  } finally {
    db.close();
  }
});
