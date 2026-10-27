import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-holder-spawn-error-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');

const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { SESSIONS_DIR } = await import('../server/config.ts');
after(() => rmSync(root, { recursive: true, force: true }));

test('an asynchronous holder spawn error ends the launch instead of crashing the server', async () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const path = join(root, 'projet');
    mkdirSync(path, { recursive: true });
    const project = db.createProject('Projet', path, 'shared');
    const manager = new SessionManager(db);
    manager.spawnHolder = () => {
      const holder = new EventEmitter();
      holder.unref = () => {};
      setImmediate(() => holder.emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' })));
      return holder;
    };

    const started = Date.now();
    const session = await manager.create(project, { agent: 'codex', prompt: 'Lancement' });
    assert.ok(Date.now() - started < 5_000, 'the launch must not wait for the connection timeout');
    assert.equal(session.status, 'exited');
    assert.equal(session.exitCode, 1);
    assert.equal(db.getSession(session.id).status, 'exited');
    assert.equal(manager.runtimes.size, 0);
    assert.equal(existsSync(join(SESSIONS_DIR, `${session.id}.config.json`)), false);
    assert.match(readFileSync(join(SESSIONS_DIR, `${session.id}.holder.log`), 'utf8'), /spawn EAGAIN/);
  } finally { db.close(); }
});
