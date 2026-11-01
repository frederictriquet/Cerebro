import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import {
  backupDatabase,
  backupName,
  backupsToDelete,
  backupTime,
  dataDirectory,
  pruneBackups,
} from '../scripts/db-backup.mjs';

const repo = join(import.meta.dirname, '..');
// Everything happens under this directory: neither ~/.cerebro nor the folders watched by the real `npm run dev`.
const scratch = mkdtempSync(join(tmpdir(), 'cerebro-db-backup-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;
function tempDir(label) {
  const dir = join(scratch, `${label}-${++dirs}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const ROWS = [
  { id: 'empiricist', needs: '["web"]' },
  { id: 'failure-historian', needs: '["web","shell"]' },
];
function createDatabase(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'cerebro.db'));
  db.exec('CREATE TABLE personas (id TEXT PRIMARY KEY, needs TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO personas VALUES (?, ?)');
  for (const row of ROWS) insert.run(row.id, row.needs);
  db.close();
}
function readRows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    return db
      .prepare('SELECT id, needs FROM personas ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const at = (iso) => backupName(Date.parse(iso));

test('une copie VACUUM INTO reprend la base sans la modifier, sous un nom daté qui se trie dans le temps', () => {
  const dataDir = tempDir('copy');
  createDatabase(dataDir);
  const source = join(dataDir, 'cerebro.db');
  const before = { digest: digest(source), mtimeMs: statSync(source).mtimeMs };
  const now = Date.parse('2026-11-01T14:04:05.123Z');

  const copy = backupDatabase(dataDir, now);

  const backups = join(dataDir, 'backups');
  assert.equal(copy.path, join(backups, 'cerebro-2026-11-01T14-04-05-123Z.db'));
  assert.equal(copy.bytes, statSync(copy.path).size);
  assert.deepEqual(copy.removed, []);
  assert.deepEqual(readRows(copy.path), ROWS);
  assert.deepEqual(readdirSync(backups), ['cerebro-2026-11-01T14-04-05-123Z.db']);
  assert.equal(statSync(backups).mode & 0o777, 0o700);
  assert.deepEqual({ digest: digest(source), mtimeMs: statSync(source).mtimeMs }, before);
  assert.equal(backupTime(copy.path.slice(backups.length + 1)), now);
  assert.ok(backupName(now) < backupName(now + 1) && backupName(now + 1) < backupName(now + 3_600_000));
});

test("sans base, rien n'est copié et aucun dossier n'est créé", () => {
  const dataDir = tempDir('empty');
  assert.equal(backupDatabase(dataDir), null);
  assert.equal(existsSync(join(dataDir, 'backups')), false);
});

test('une copie en échec ne laisse aucun fichier partiel et garde les copies existantes', () => {
  const dataDir = tempDir('broken');
  writeFileSync(join(dataDir, 'cerebro.db'), 'pas une base SQLite. '.repeat(200));
  const backups = join(dataDir, 'backups');
  mkdirSync(backups);
  const previous = at('2026-11-01T09:00:00Z');
  writeFileSync(join(backups, previous), 'copie précédente');

  assert.throws(() => backupDatabase(dataDir, Date.parse('2026-11-01T10:00:00Z')), /not a database/);
  assert.deepEqual(readdirSync(backups), [previous]);
});

test('la rotation garde les 5 dernières copies et la plus ancienne de chaque heure sur 24 h', () => {
  const now = Date.parse('2026-11-01T12:30:00Z');
  const latest = ['12:29', '12:25', '12:20', '12:15', '12:10'].map((time) => at(`2026-11-01T${time}:00Z`));
  const sameHourLater = at('2026-11-01T12:05:00Z');
  const firstOfHour12 = at('2026-11-01T12:01:00Z');
  const hour11Later = at('2026-11-01T11:50:00Z');
  const firstOfHour11 = at('2026-11-01T11:10:00Z');
  const within24h = at('2026-10-31T13:00:00Z');
  const beyond24h = at('2026-10-31T12:00:00Z');
  const lastWeek = at('2026-10-25T08:00:00Z');
  const others = [`${at('2026-11-01T12:29:30Z')}.partial`, 'notes.txt', 'cerebro.db', 'cerebro-2026-11-01.db'];
  const names = [
    lastWeek,
    ...others,
    firstOfHour11,
    ...latest.slice(2),
    beyond24h,
    sameHourLater,
    within24h,
    hour11Later,
    firstOfHour12,
    ...latest.slice(0, 2),
  ];

  assert.deepEqual(backupsToDelete(names, now), [sameHourLater, hour11Later, beyond24h, lastWeek]);
  // After a long pause, the last copies stay even when they are all old.
  assert.deepEqual(backupsToDelete([beyond24h, lastWeek, at('2026-10-20T08:00:00Z')], now), []);
});

test('le nettoyage ne supprime que les copies hors rotation et les copies partielles abandonnées', () => {
  const dir = tempDir('prune');
  const now = Date.parse('2026-11-01T12:30:00Z');
  const copies = ['12:00', '12:24', '12:25', '12:26', '12:27', '12:28', '12:29'].map((time) =>
    at(`2026-11-01T${time}:00Z`),
  );
  const stalePartial = `${at('2026-11-01T10:00:00Z')}.partial`;
  const freshPartial = `${at('2026-11-01T12:20:00Z')}.partial`;
  const unrelated = ['notes.partial', 'lisez-moi.txt'];
  for (const name of [...copies, stalePartial, freshPartial, ...unrelated]) writeFileSync(join(dir, name), name);

  assert.deepEqual(pruneBackups(dir, now), [copies[1], stalePartial]);
  assert.deepEqual(readdirSync(dir).sort(), [copies[0], ...copies.slice(2), freshPartial, ...unrelated].sort());
});

test('le lanceur vise le même dossier de données que le serveur (DATA_DIR de server/config.ts)', () => {
  const home = tempDir('home');
  const configUrl = new URL('../server/config.ts', import.meta.url).href;
  const serverDataDir = (env) => {
    const result = spawnSync(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--input-type=module',
        '-e',
        `const { DATA_DIR } = await import(${JSON.stringify(configUrl)}); process.stdout.write(DATA_DIR);`,
      ],
      { env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const explicit = { CEREBRO_DATA_DIR: join(home, 'explicite') };

  for (const env of [{}, explicit]) assert.equal(dataDirectory(env, home), serverDataDir(env));
  assert.equal(dataDirectory({}, home), join(home, '.cerebro'));

  // The default directory's env file may name another directory; the environment still wins.
  mkdirSync(join(home, '.cerebro'));
  writeFileSync(join(home, '.cerebro', 'env'), `CEREBRO_DATA_DIR=${join(home, 'depuis-env')}\n`);
  for (const env of [{}, explicit]) assert.equal(dataDirectory(env, home), serverDataDir(env));
  assert.equal(dataDirectory({}, home), join(home, 'depuis-env'));
});

test('npm run db:backup copie la base du dossier de données sur demande', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['db:backup'], /scripts\/db-backup\.mjs$/);
  const dataDir = tempDir('cli');
  const run = () =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(repo, 'scripts', 'db-backup.mjs')], {
      env: { PATH: process.env.PATH, HOME: tempDir('cli-home'), CEREBRO_DATA_DIR: dataDir },
      encoding: 'utf8',
    });

  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^aucune base à sauvegarder : .*cerebro\.db n'existe pas\n$/);

  createDatabase(dataDir);
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^base sauvegardée : .*\/backups\/cerebro-[\dT-]+Z\.db \(\d+,\d Mo, \d+ ms\)\n$/);
  const [copy] = readdirSync(join(dataDir, 'backups'));
  assert.deepEqual(readRows(join(dataDir, 'backups', copy)), ROWS);
});

// `npm run dev` itself, run from a copy of the launcher in a scratch root: its folders and its stand-in server and
// Vite are scratch files, so the test never edits the watched folders of the repository.
const SERVER_STUB = `import { appendFileSync, readdirSync } from 'node:fs';
const copies = () => {
  try {
    return readdirSync(process.env.CEREBRO_DATA_DIR + '/backups').filter((name) => name.endsWith('.db')).length;
  } catch {
    return 0;
  }
};
appendFileSync('events.log', 'start ' + copies() + '\\n');
process.on('SIGTERM', () => {
  appendFileSync('events.log', 'stop ' + copies() + '\\n');
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
`;
const VITE_STUB = `process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

function launchDev(t, prepareData) {
  const root = tempDir('dev-root');
  for (const dir of ['scripts', 'server', 'shared', 'bin', join('node_modules', 'vite', 'bin')])
    mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['dev.mjs', 'db-backup.mjs'])
    copyFileSync(join(repo, 'scripts', file), join(root, 'scripts', file));
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(root, 'server', 'index.ts'), SERVER_STUB);
  writeFileSync(join(root, 'node_modules', 'vite', 'bin', 'vite.js'), VITE_STUB);
  const dataDir = tempDir('dev-data');
  prepareData(dataDir);

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'scripts', 'dev.mjs')], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: tempDir('dev-home'), CEREBRO_DATA_DIR: dataDir },
    // Own process group: a failed test still kills the launcher and its children.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  });
  const eventsFile = join(root, 'events.log');
  return {
    root,
    dataDir,
    exited,
    output: () => output,
    events: () => (existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').trim().split('\n') : []),
    stop: () => child.kill('SIGTERM'),
  };
}

async function waitFor(check, what) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`délai dépassé : ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('npm run dev copie la base avant le premier démarrage et avant chaque redémarrage dû à server/ ou shared/', async (t) => {
  const dev = launchDev(t, createDatabase);
  await waitFor(() => dev.events().length === 1, 'premier démarrage');

  writeFileSync(join(dev.root, 'bin', 'outil.mjs'), 'export {};\n');
  await waitFor(() => dev.events().length === 3, 'redémarrage après bin/');
  writeFileSync(join(dev.root, 'server', 'db.ts'), 'export const migration = 1;\n');
  await waitFor(() => dev.events().length === 5, 'redémarrage après server/');
  writeFileSync(join(dev.root, 'shared', 'types.ts'), 'export const seeded = true;\n');
  await waitFor(() => dev.events().length === 7, 'redémarrage après shared/');

  // Number of copies seen by each start and stop: a copy before the first start, none for bin/, and for server/ and
  // shared/ one taken once the previous server has stopped and before the next one starts.
  assert.deepEqual(dev.events(), ['start 1', 'stop 1', 'start 1', 'stop 1', 'start 2', 'stop 2', 'start 3']);
  const backups = join(dev.dataDir, 'backups');
  const copies = readdirSync(backups);
  assert.equal(copies.length, 3);
  for (const copy of copies) assert.deepEqual(readRows(join(backups, copy)), ROWS);
  await waitFor(() => dev.output().match(/base sauvegardée : /g)?.length === 3, 'trois lignes de sauvegarde');

  dev.stop();
  assert.deepEqual(await dev.exited, { code: 0, signal: null });
  assert.equal(dev.events().at(-1), 'stop 3');
});

test("npm run dev démarre le serveur quand la copie échoue, en l'affichant", async (t) => {
  const dev = launchDev(t, (dataDir) =>
    writeFileSync(join(dataDir, 'cerebro.db'), 'pas une base SQLite. '.repeat(200)),
  );
  await waitFor(() => dev.events().length === 1, 'démarrage malgré la copie en échec');
  assert.deepEqual(dev.events(), ['start 0']);
  await waitFor(
    () => /sauvegarde de la base en échec, démarrage sans copie : .*not a database/.test(dev.output()),
    'message d’échec',
  );
  assert.deepEqual(readdirSync(join(dev.dataDir, 'backups')), []);

  dev.stop();
  assert.deepEqual(await dev.exited, { code: 0, signal: null });
});
