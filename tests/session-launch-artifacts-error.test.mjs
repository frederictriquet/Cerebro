import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-launch-artifacts-error-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');

const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { SESSIONS_DIR } = await import('../server/config.ts');
after(() => rmSync(root, { recursive: true, force: true }));

function setup(name) {
  const db = new CerebroDatabase(':memory:');
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const project = db.createProject(name, path, 'shared');
  const manager = new SessionManager(db);
  manager.spawnHolder = () => { throw new Error('the holder must not be spawned'); };
  return { db, project, manager };
}

test('a config.json already present when the holder config is written ends the session instead of leaving it starting', async () => {
  const { db, project, manager } = setup('existant');
  try {
    const cleanup = manager.cleanupHolderArtifacts;
    let configPath = null;
    // Another launch recreates the file between the cleanup and the exclusive write.
    manager.cleanupHolderArtifacts = function (id) {
      cleanup.call(this, id);
      configPath = join(SESSIONS_DIR, `${id}.config.json`);
      writeFileSync(configPath, 'autre lancement\n');
    };

    await assert.rejects(manager.create(project, { agent: 'codex', prompt: 'Lancement' }), { code: 'EEXIST' });

    const [session] = db.listSessions();
    assert.equal(session.status, 'exited');
    assert.equal(session.exitCode, 1);
    assert.equal(manager.runtimes.size, 0);
    // The file belongs to someone else: the failed launch must not remove it.
    assert.equal(readFileSync(configPath, 'utf8'), 'autre lancement\n');
  } finally { db.close(); }
});

test('a launch artifact cleanup failure ends the session instead of leaving it starting', async () => {
  const { db, project, manager } = setup('nettoyage');
  try {
    manager.cleanupHolderArtifacts = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };

    await assert.rejects(manager.create(project, { agent: 'codex', prompt: 'Lancement' }), { code: 'EACCES' });

    const [session] = db.listSessions();
    assert.equal(session.status, 'exited');
    assert.equal(session.exitCode, 1);
    assert.equal(manager.runtimes.size, 0);
  } finally { db.close(); }
});
