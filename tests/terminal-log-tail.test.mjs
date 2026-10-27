import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-log-tail-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');

const { CerebroDatabase } = await import('../server/db.ts');
// config.ts n'écrit rien à l'import : les dossiers de données sont créés explicitement.
(await import('../server/config.ts')).ensureDataDirs();
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { LOG_DIR, ROOT, SESSIONS_DIR } = await import('../server/config.ts');

const MAX_LOG_SNAPSHOT = 2 * 1024 * 1024;
const holders = new Set();
after(() => {
  for (const holder of holders) holder.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

function exitedSession(log) {
  const db = new CerebroDatabase(':memory:');
  const path = join(root, `projet-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  const project = db.createProject('Projet', path, 'shared');
  const id = randomUUID();
  db.createSession(
    {
      id,
      projectId: project.id,
      agent: 'codex',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: 'Terminée',
      status: 'exited',
      agentSessionId: 'fake',
    },
    'token',
  );
  writeFileSync(join(LOG_DIR, `${id}.log`), log);
  return { db, manager: new SessionManager(db, createServices(db)), id };
}

test('a truncated log snapshot resumes at the next line instead of a cut character', () => {
  const tail = 'fin é!\r\n';
  // The snapshot window starts on the second byte of an « é », right after a colour sequence.
  const log = Buffer.concat([
    Buffer.from('début\x1b[31m'),
    Buffer.from('é'.repeat(MAX_LOG_SNAPSHOT / 2) + '\r\n'),
    Buffer.from(tail),
  ]);
  const window = log.subarray(log.length - MAX_LOG_SNAPSHOT);
  assert.equal(window[0] & 0xc0, 0x80, 'the fixture must cut a multi-byte character');
  const { db, manager, id } = exitedSession(log);
  try {
    const snapshot = manager.terminalSnapshot(id);
    assert.equal(snapshot.includes('�'), false);
    assert.equal(snapshot, tail);
  } finally {
    db.close();
  }
});

test('a truncated log snapshot without line breaks skips the cut character', () => {
  const log = Buffer.from('é'.repeat(MAX_LOG_SNAPSHOT / 2) + 'x');
  assert.equal(log[log.length - MAX_LOG_SNAPSHOT] & 0xc0, 0x80, 'the fixture must cut a multi-byte character');
  const { db, manager, id } = exitedSession(log);
  try {
    const snapshot = manager.terminalSnapshot(id);
    assert.equal(snapshot.includes('�'), false);
    assert.equal(snapshot, 'é'.repeat(MAX_LOG_SNAPSHOT / 2 - 1) + 'x');
  } finally {
    db.close();
  }
});

test('a short log is replayed whole', () => {
  const { db, manager, id } = exitedSession('\x1b[32mprêt\x1b[0m sans saut de ligne');
  try {
    assert.equal(manager.terminalSnapshot(id), '\x1b[32mprêt\x1b[0m sans saut de ligne');
  } finally {
    db.close();
  }
});

async function waitFor(condition, message) {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('the holder writes its exit record only once the terminal log holds all the output', async () => {
  const id = randomUUID();
  const configPath = join(SESSIONS_DIR, `${id}.config.json`);
  const exitPath = join(SESSIONS_DIR, `${id}.exit.json`);
  const logPath = join(LOG_DIR, `${id}.log`);
  const exitedPath = join(root, `${id}.agent-exited`);
  // A FIFO nobody reads yet holds back every log write: the agent exits long before its output is flushed.
  execFileSync('mkfifo', [logPath]);
  // The agent lingers once stdout is flushed: a process that exits at once can lose its last bytes inside the PTY,
  // before the holder ever sees them, which is not what this test is about.
  const script = `process.on('exit', () => require('node:fs').writeFileSync(${JSON.stringify(exitedPath)}, '')); process.stdout.write('é'.repeat(5000) + '\\nFIN-DU-LOG\\n', () => setTimeout(() => process.exit(0), 200));`;
  writeFileSync(
    configPath,
    JSON.stringify({ cmd: process.execPath, args: ['-e', script], cwd: root, env: process.env, cols: 120, rows: 32 }),
    { mode: 0o600 },
  );
  const holder = spawn(process.execPath, [join(ROOT, 'server', 'holder.ts'), configPath], { stdio: 'ignore' });
  holders.add(holder);

  await waitFor(() => existsSync(exitedPath), 'the agent never exited');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(existsSync(exitPath), false, 'the exit record must wait for the terminal log');

  const log = await new Promise((resolve, reject) => {
    const chunks = [];
    createReadStream(logPath)
      .on('data', (chunk) => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .on('error', reject);
  });
  assert.match(log, /FIN-DU-LOG/);
  await waitFor(() => existsSync(exitPath), 'the holder never wrote its exit record');
  assert.equal(JSON.parse(readFileSync(exitPath, 'utf8')).exitCode, 0);
});
