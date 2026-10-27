import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-launch-deletion-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');

const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { SESSIONS_DIR } = await import('../server/config.ts');
after(() => rmSync(root, { recursive: true, force: true }));

for (const deletion of ['session', 'project']) {
  test(`${deletion} deletion during a slow validate() waits for the launch, which aborts without spawning a holder`, async () => {
    const db = new CerebroDatabase(':memory:');
    try {
      const path = join(root, `projet-${deletion}`);
      mkdirSync(path, { recursive: true });
      const project = db.createProject('Projet', path, 'shared');
      const manager = new SessionManager(db, createServices(db));
      const events = [];
      manager.onEvent((event) => events.push(event));
      let release;
      let validating;
      const validated = new Promise((resolve) => {
        validating = resolve;
      });
      const launch = manager.create(
        project,
        { agent: 'codex', prompt: 'Lancement lent' },
        {
          validate: () => {
            validating();
            return new Promise((resolve) => {
              release = resolve;
            });
          },
        },
      );
      await validated;
      const [session] = db.listProjectSessions(project.id);
      assert.equal(session.status, 'starting');

      let deleted = false;
      const deleting = (deletion === 'session' ? manager.delete(session.id) : manager.deleteProject(project.id)).then(
        (result) => {
          deleted = true;
          return result;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(deleted, false, 'deletion must wait for the launch preparation');
      assert.ok(db.getSession(session.id), 'the session row stays until the launch has settled');

      release();
      await assert.rejects(launch, /supprimée pendant son lancement/);
      assert.equal(await deleting, true);
      assert.equal(db.getSession(session.id), null);
      assert.equal(manager.runtimes.size, 0);
      assert.equal(existsSync(join(SESSIONS_DIR, `${session.id}.config.json`)), false);
      assert.equal(existsSync(join(SESSIONS_DIR, `${session.id}.sock`)), false);
      assert.equal(events.at(-1).type, 'session-deleted');
    } finally {
      db.close();
    }
  });
}
