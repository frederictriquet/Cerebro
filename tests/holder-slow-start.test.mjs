import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Short prefix: Unix socket paths are limited to 104 bytes on macOS.
const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'chs-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');

const { CerebroDatabase } = await import('../server/db.ts');
(await import('../server/config.ts')).ensureDataDirs();
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { LOG_DIR, SESSIONS_DIR } = await import('../server/config.ts');
const { encodeMessage, holderPaths, parseConfigPath } = await import('../server/holder-protocol.ts');
after(() => rmSync(root, { recursive: true, force: true }));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(name) {
  const db = new CerebroDatabase(':memory:');
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  const project = db.createProject(name, path, 'shared');
  const manager = new SessionManager(db, createServices(db));
  manager.holderStartTimeouts = { soft: 200, hard: 5_000 };
  return { db, project, manager };
}

// Stand-in for the holder ChildProcess: emits 'spawn', records signals, emits 'exit' once killed.
function fakeHolder() {
  const holder = new EventEmitter();
  holder.pid = undefined;
  holder.signals = [];
  holder.unref = () => {};
  holder.kill = (signal) => {
    holder.signals.push(signal);
    setImmediate(() => holder.emit('exit', null, signal));
    return true;
  };
  setImmediate(() => holder.emit('spawn'));
  return holder;
}

test('a holder that listens after the soft timeout is attached instead of ending the session', async () => {
  const { db, project, manager } = setup('lent');
  let server = null;
  let client = null;
  try {
    let holder = null;
    manager.spawnHolder = (configPath) => {
      holder = fakeHolder();
      const { sessionsDir, id } = parseConfigPath(configPath);
      setTimeout(() => {
        server = createServer((socket) => {
          client = socket;
          socket.write(encodeMessage({ type: 'hello', pid: 1, cols: 120, rows: 32 }));
          socket.write(encodeMessage({ type: 'snapshot', data: '' }));
        });
        server.listen(holderPaths(sessionsDir, id).socket);
      }, 600);
      return holder;
    };

    const session = await manager.create(project, { agent: 'codex', prompt: 'Lancement' });

    assert.equal(session.status, 'running');
    assert.deepEqual(holder.signals, []);
    assert.match(readFileSync(join(SESSIONS_DIR, `${session.id}.holder.log`), 'utf8'), /Holder lent/);

    client.write(encodeMessage({ type: 'exit', exitCode: 0 }));
    for (let i = 0; i < 50 && db.getSession(session.id).status !== 'exited'; i += 1) await delay(20);
    assert.equal(db.getSession(session.id).status, 'exited');
  } finally {
    client?.destroy();
    server?.close();
    db.close();
  }
});

test('a holder alive but never listening is stopped at the hard timeout and the failure is shown in the terminal', async () => {
  const { db, project, manager } = setup('muet');
  manager.holderStartTimeouts = { soft: 100, hard: 500 };
  try {
    let holder = null;
    manager.spawnHolder = () => {
      holder = fakeHolder();
      return holder;
    };

    const session = await manager.create(project, { agent: 'codex', prompt: 'Lancement' });

    assert.equal(session.status, 'exited');
    assert.equal(session.exitCode, 1);
    assert.deepEqual(holder.signals, ['SIGTERM']);
    assert.match(readFileSync(join(SESSIONS_DIR, `${session.id}.holder.log`), 'utf8'), /holder arrêté/);
    assert.match(readFileSync(join(LOG_DIR, `${session.id}.log`), 'utf8'), /Échec du lancement de la session/);
  } finally {
    db.close();
  }
});

test('a holder that died without listening ends the launch at the soft timeout', async () => {
  const { db, project, manager } = setup('mort');
  manager.holderStartTimeouts = { soft: 200, hard: 30_000 };
  try {
    let holder = null;
    manager.spawnHolder = () => {
      holder = fakeHolder();
      setTimeout(() => holder.emit('exit', 1, null), 20);
      return holder;
    };

    const started = Date.now();
    const session = await manager.create(project, { agent: 'codex', prompt: 'Lancement' });

    assert.ok(Date.now() - started < 5_000, 'a dead holder must not hold the launch until the hard timeout');
    assert.equal(session.status, 'exited');
    assert.equal(session.exitCode, 1);
    assert.deepEqual(holder.signals, []);
  } finally {
    db.close();
  }
});
