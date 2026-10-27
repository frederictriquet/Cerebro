import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-holder-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');

const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { SESSIONS_DIR } = await import('../server/config.ts');

const holders = new Set();
after(() => {
  for (const holder of holders) holder.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

// Stand-in for server/holder.ts, found by its config path argument like the real one. It starts
// listening after `startDelay`, and when `downAfter` >= 0 drops its client and stops listening once
// for `downFor` ms. It never writes an exit record.
const FAKE_HOLDER = `
const net = require('node:net');
const fs = require('node:fs');
const [config, startDelay, downAfter, downFor] = process.argv.slice(1);
const socketPath = config.replace(/\\.config\\.json$/, '.sock');
const clients = new Set();
let server;
let dropped = false;
const send = (socket, message) => socket.write(JSON.stringify(message) + '\\n');
const drop = () => {
  dropped = true;
  server.close();
  for (const client of clients) client.destroy();
  setTimeout(listen, Number(downFor));
};
const listen = () => {
  try { fs.unlinkSync(socketPath); } catch {}
  server = net.createServer((socket) => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    send(socket, { type: 'hello', cols: 120, rows: 32 });
    send(socket, { type: 'snapshot', data: '' });
    if (Number(downAfter) >= 0 && !dropped) setTimeout(drop, Number(downAfter));
  });
  server.listen(socketPath);
};
setTimeout(listen, Number(startDelay));
setInterval(() => {}, 60_000);
`;

function fixture() {
  const db = new CerebroDatabase(':memory:');
  const path = join(root, `projet-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  const project = db.createProject('Projet', path, 'shared');
  const id = randomUUID();
  db.createSession({ id, projectId: project.id, agent: 'claude', mode: 'auto', model: null, effort: null, prompt: '', title: 'Lente', status: 'running', agentSessionId: null }, 'token');
  const configPath = join(SESSIONS_DIR, `${id}.config.json`);
  writeFileSync(configPath, '{}\n');
  return { db, id, configPath, socketPath: join(SESSIONS_DIR, `${id}.sock`) };
}

function startHolder(configPath, { startDelay = 0, downAfter = -1, downFor = 0 } = {}) {
  const holder = spawn(process.execPath, ['-e', FAKE_HOLDER, configPath, String(startDelay), String(downAfter), String(downFor)], { stdio: 'ignore' });
  holders.add(holder);
  holder.on('exit', () => holders.delete(holder));
  return holder;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition, timeout, message) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await wait(50);
  }
}

test('a restart while the holder is not listening yet keeps retrying instead of stranding it', async () => {
  const { db, id, configPath, socketPath } = fixture();
  const manager = new SessionManager(db);
  try {
    const holder = startHolder(configPath, { startDelay: 3_300 });
    await until(() => manager.holderAlive(id), 2_000, 'fake holder not found by its argument');

    await manager.initialize();
    assert.equal(db.getSession(id).status, 'running', 'a live holder must not be concluded on ECONNREFUSED');
    assert.ok(manager.runtimes.has(id));

    await until(() => manager.runtimes.get(id)?.socket != null, 8_000, 'never reconnected to the slow holder');
    assert.notEqual(db.getSession(id).status, 'exited');
    assert.ok(existsSync(socketPath), 'the holder socket must survive');

    // Once the holder process is really gone (no exit record), the session still ends.
    holder.kill('SIGKILL');
    await until(() => db.getSession(id).status === 'exited', 8_000, 'session never concluded after its holder died');
    assert.equal(db.getSession(id).exitCode, null);
    assert.equal(manager.runtimes.has(id), false);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('a holder unreachable for longer than the reconnect attempts is waited for while it lives', async () => {
  const { db, id, configPath } = fixture();
  const manager = new SessionManager(db);
  try {
    startHolder(configPath, { downAfter: 200, downFor: 4_500 });
    await until(() => existsSync(join(SESSIONS_DIR, `${id}.sock`)), 3_000, 'fake holder never listened');
    await manager.initialize();
    assert.ok(manager.runtimes.get(id)?.socket, 'initial connection expected');

    await wait(4_000);
    assert.notEqual(db.getSession(id).status, 'exited', 'three failed attempts must not conclude while the holder lives');
    await until(() => manager.runtimes.get(id)?.socket != null && !manager.runtimes.get(id).socket.destroyed, 8_000, 'never reconnected after the outage');
    assert.notEqual(db.getSession(id).status, 'exited');
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('stopping a session whose live holder never answers kills it by its processes', async () => {
  const { db, id, configPath } = fixture();
  const manager = new SessionManager(db);
  try {
    // Never listens: the reconnection would wait for it forever.
    startHolder(configPath, { startDelay: 600_000 });
    await until(() => manager.holderAlive(id), 2_000, 'fake holder not found by its argument');
    await manager.initialize();
    assert.equal(manager.runtimes.get(id)?.socket ?? null, null);

    assert.equal(manager.kill(id), true, 'an unreachable live holder must still be stoppable');
    await until(() => db.getSession(id).status === 'exited', 8_000, 'session never concluded after kill');
    assert.equal(manager.holderAlive(id), false);
    assert.equal(manager.runtimes.has(id), false);
    assert.equal(manager.kill(id), false);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('stopping a session whose holder is suspended escalates to SIGKILL', async () => {
  const { db, id, configPath } = fixture();
  const manager = new SessionManager(db);
  try {
    const holder = startHolder(configPath, { downAfter: 200, downFor: 600_000 });
    await until(() => existsSync(join(SESSIONS_DIR, `${id}.sock`)), 3_000, 'fake holder never listened');
    await manager.initialize();
    await until(() => manager.runtimes.get(id)?.socket == null, 3_000, 'connection never dropped');
    holder.kill('SIGSTOP');

    assert.equal(manager.kill(id), true);
    await until(() => db.getSession(id).status === 'exited', 10_000, 'suspended holder never stopped');
    assert.equal(manager.holderAlive(id), false);
  } finally {
    await manager.shutdown();
    db.close();
  }
});
