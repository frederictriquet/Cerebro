import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-term-size-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
// Celles de la session Cerebro qui lance les tests imposeraient un jeton aux routes.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('CEREBRO_') && name !== 'CEREBRO_DATA_DIR') delete process.env[name];
}

const { CerebroDatabase } = await import('../server/db.ts');
(await import('../server/config.ts')).ensureDataDirs();
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { SESSIONS_DIR } = await import('../server/config.ts');
const { parseTermServerMessage } = await import('../shared/types.ts');
const { buildServer } = await import('../server/index.ts');

const holders = new Set();
after(() => {
  for (const holder of holders) holder.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

// Stand-in for server/holder.ts: announces a 100x30 PTY and records what it is sent next to its config.
const FAKE_HOLDER = `
const net = require('node:net');
const fs = require('node:fs');
const socketPath = process.argv[1].replace(/\\.config\\.json$/, '.sock');
try { fs.unlinkSync(socketPath); } catch {}
net.createServer((socket) => {
  socket.on('error', () => {});
  socket.on('data', (chunk) => fs.appendFileSync(process.argv[1] + '.received', chunk));
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

/** Session d'un nouveau projet, tenue par le faux holder tant qu'elle n'est pas terminée. */
function seedSession(db, folder, status = 'running') {
  const path = join(root, folder);
  mkdirSync(path, { recursive: true });
  const project = db.createProject(folder, path, 'shared');
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
      status,
      agentSessionId: null,
    },
    'token',
  );
  const configPath = join(SESSIONS_DIR, `${id}.config.json`);
  if (status === 'exited') return { id, configPath };
  writeFileSync(configPath, '{}\n');
  const holder = spawn(process.execPath, ['-e', FAKE_HOLDER, configPath], { stdio: 'ignore' });
  holders.add(holder);
  holder.on('exit', () => holders.delete(holder));
  return { id, configPath };
}

/** Messages reçus par le faux holder de cette session. */
function receivedBy(configPath) {
  return existsSync(`${configPath}.received`)
    ? readFileSync(`${configPath}.received`, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

test('a resize from one viewer is broadcast so every viewer renders at the PTY size', async () => {
  const db = new CerebroDatabase(':memory:');
  const { id, configPath } = seedSession(db, 'projet');

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

    // A forced refresh reaches the holder even at the same size, so the application redraws.
    assert.equal(manager.resize(id, 180, 50, true), true);
    assert.equal(pc.length, 1);
    const received = () => receivedBy(configPath);
    await until(() => received().some((msg) => msg.force === true), 3_000, 'forced resize never reached the holder');
    assert.deepEqual(
      received().filter((msg) => msg.type === 'resize'),
      [
        { type: 'resize', cols: 180, rows: 50 },
        { type: 'resize', cols: 180, rows: 50 },
        { type: 'resize', cols: 180, rows: 50, force: true },
      ],
    );
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('POST /api/sessions/:id/resize impose sa taille au PTY sans terminal ouvert', async () => {
  const db = new CerebroDatabase();
  const { id, configPath } = seedSession(db, 'mobile');
  const exited = seedSession(db, 'terminee', 'exited').id;
  await until(() => existsSync(join(SESSIONS_DIR, `${id}.sock`)), 3_000, 'fake holder never listened');
  const app = await buildServer();
  const resize = async (session, payload) =>
    (await app.inject({ method: 'POST', url: `/api/sessions/${session}/resize`, payload })).statusCode;
  try {
    // 409 jusqu'à ce que le serveur ait rejoint le holder.
    const deadline = Date.now() + 3_000;
    let status = await resize(id, { cols: 52, rows: 30 });
    while (status === 409 && Date.now() < deadline) {
      await wait(50);
      status = await resize(id, { cols: 52, rows: 30 });
    }
    assert.equal(status, 204);
    await until(
      () => receivedBy(configPath).some((msg) => msg.type === 'resize'),
      3_000,
      'resize never reached the holder',
    );
    assert.deepEqual(
      receivedBy(configPath).filter((msg) => msg.type === 'resize'),
      [{ type: 'resize', cols: 52, rows: 30 }],
    );

    for (const payload of [
      {},
      { cols: 52 },
      { cols: 0, rows: 30 },
      { cols: 52, rows: 30.5 },
      { cols: '52', rows: 30 },
      { cols: 52, rows: 1001 },
    ]) {
      assert.equal(await resize(id, payload), 400, JSON.stringify(payload));
    }
    assert.equal(await resize(exited, { cols: 52, rows: 30 }), 409);
    assert.equal(await resize(randomUUID(), { cols: 52, rows: 30 }), 404);
  } finally {
    await app.close();
    db.close();
  }
});

test('size messages with invalid dimensions are rejected', () => {
  assert.equal(parseTermServerMessage({ type: 'size', cols: 0, rows: 30 }), null);
  assert.equal(parseTermServerMessage({ type: 'size', cols: 80.5, rows: 30 }), null);
  assert.equal(parseTermServerMessage({ type: 'size', cols: '80', rows: 30 }), null);
});
