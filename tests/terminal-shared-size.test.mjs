import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-term-size-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');

const { CerebroDatabase } = await import('../server/db.ts');
(await import('../server/config.ts')).ensureDataDirs();
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { SESSIONS_DIR } = await import('../server/config.ts');
const { parseTermServerMessage } = await import('../shared/types.ts');

const holders = new Set();
after(() => {
  for (const holder of holders) holder.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

// Stand-in for server/holder.ts: announces a 100x30 PTY and ignores what it is sent.
const FAKE_HOLDER = `
const net = require('node:net');
const fs = require('node:fs');
const socketPath = process.argv[1].replace(/\\.config\\.json$/, '.sock');
try { fs.unlinkSync(socketPath); } catch {}
net.createServer((socket) => {
  socket.on('error', () => {});
  socket.write(JSON.stringify({ type: 'hello', cols: 100, rows: 30 }) + '\\n');
  socket.write(JSON.stringify({ type: 'snapshot', data: '' }) + '\\n');
}).listen(socketPath);
setInterval(() => {}, 60_000);
`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition, timeout, message) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await wait(50);
  }
}

test('a resize from one viewer is broadcast so every viewer renders at the PTY size', async () => {
  const db = new CerebroDatabase(':memory:');
  const path = join(root, 'projet');
  mkdirSync(path, { recursive: true });
  const project = db.createProject('Projet', path, 'shared');
  const id = randomUUID();
  db.createSession(
    {
      id,
      projectId: project.id,
      agent: 'claude',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: 'Partagée',
      status: 'running',
      agentSessionId: null,
    },
    'token',
  );
  const configPath = join(SESSIONS_DIR, `${id}.config.json`);
  writeFileSync(configPath, '{}\n');
  const holder = spawn(process.execPath, ['-e', FAKE_HOLDER, configPath], { stdio: 'ignore' });
  holders.add(holder);
  holder.on('exit', () => holders.delete(holder));

  const manager = new SessionManager(db, createServices(db));
  try {
    await until(() => existsSync(join(SESSIONS_DIR, `${id}.sock`)), 3_000, 'fake holder never listened');
    await manager.initialize();
    await until(() => manager.runtimes.get(id)?.socket != null, 3_000, 'never connected to the holder');
    await until(() => manager.terminalSize(id)?.cols === 100, 3_000, 'holder size never adopted');
    assert.deepEqual(manager.terminalSize(id), { cols: 100, rows: 30 });

    const mac = [];
    const pc = [];
    manager.onTerminalEvent(id, (event) => mac.push(event));
    manager.onTerminalEvent(id, (event) => pc.push(event));

    assert.equal(manager.resize(id, 180, 50), true);
    const expected = { type: 'size', cols: 180, rows: 50 };
    assert.deepEqual(mac, [expected], 'the viewer that resized gets the confirmed size');
    assert.deepEqual(pc, [expected], 'the other viewer must adopt the new size');
    assert.deepEqual(manager.terminalSize(id), { cols: 180, rows: 50 });
    assert.deepEqual(parseTermServerMessage(JSON.parse(JSON.stringify(expected))), expected);

    // Same size again: nothing to tell the viewers.
    manager.resize(id, 180, 50);
    assert.equal(pc.length, 1);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('size messages with invalid dimensions are rejected', () => {
  assert.equal(parseTermServerMessage({ type: 'size', cols: 0, rows: 30 }), null);
  assert.equal(parseTermServerMessage({ type: 'size', cols: 80.5, rows: 30 }), null);
  assert.equal(parseTermServerMessage({ type: 'size', cols: '80', rows: 30 }), null);
});
