// Copies of the Cerebro database. Every server start runs the migrations and seeds, and `npm run dev` restarts the
// real server on each save: a half-written migration reaches the real database. The dev launcher therefore copies
// the database before each start that may run new database code. A copy is a plain SQLite file: restore it with
// `cp`, or open it read-only to repair one table (README, « Sauvegardes de la base pendant le développement »).
// Run directly (`npm run db:backup`), this module takes a copy right away.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';

/** The most recent copies, always kept. */
export const KEEP_LATEST = 5;
/** Over this span, the oldest copy of each hour is kept too: the state before the first restart of that hour. */
export const KEEP_HOURLY_FOR_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
// A copy is written as `<name>.partial`, then renamed; past this age, a partial file is a leftover of a killed copy.
const STALE_PARTIAL_MS = HOUR_MS;
const COPY_NAME = /^cerebro-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db(\.partial)?$/;

/**
 * The data directory the server opens. Same rule as DATA_DIR in server/config.ts, which loads the default
 * directory's env file (without overriding the environment) before reading CEREBRO_DATA_DIR; the tests compare both.
 */
export function dataDirectory(env = process.env, home = homedir()) {
  if (env.CEREBRO_DATA_DIR !== undefined) return env.CEREBRO_DATA_DIR;
  const defaultDir = join(home, '.cerebro');
  let file;
  try {
    file = readFileSync(join(defaultDir, 'env'), 'utf8');
  } catch {
    return defaultDir;
  }
  return parseEnv(file).CEREBRO_DATA_DIR ?? defaultDir;
}

/** Name of a copy taken at `time`: its UTC date, so that names sort chronologically. */
export function backupName(time) {
  return `cerebro-${new Date(time).toISOString().replace(/[:.]/g, '-')}.db`;
}

/** Time a copy (or a partial copy) was taken, read from its name; null for any other file, which is never touched. */
export function backupTime(name) {
  const match = COPY_NAME.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second, ms] = match.slice(1, 8).map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second, ms);
}

/**
 * Copies to delete among `names`: all but the `latest` most recent ones and, over the last `hourlyFor` ms, the oldest
 * copy of each hour. Partial copies and names that are not copies are never listed.
 */
export function backupsToDelete(names, now, { latest = KEEP_LATEST, hourlyFor = KEEP_HOURLY_FOR_MS } = {}) {
  const copies = names
    .filter((name) => !name.endsWith('.partial'))
    .map((name) => ({ name, time: backupTime(name) }))
    .filter((copy) => copy.time !== null)
    .sort((a, b) => b.time - a.time);
  const kept = new Set(copies.slice(0, latest).map((copy) => copy.name));
  // Newest first: the last copy recorded for an hour is its oldest one.
  const oldestOfHour = new Map();
  for (const copy of copies) {
    if (copy.time > now - hourlyFor) oldestOfHour.set(Math.floor(copy.time / HOUR_MS), copy.name);
  }
  for (const name of oldestOfHour.values()) kept.add(name);
  return copies.filter((copy) => !kept.has(copy.name)).map((copy) => copy.name);
}

/** Applies the rotation to the copies in `dir` and removes stale partial copies; returns the removed names. */
export function pruneBackups(dir, now = Date.now()) {
  const names = readdirSync(dir);
  const stale = names.filter((name) => {
    const time = name.endsWith('.partial') ? backupTime(name) : null;
    return time !== null && time < now - STALE_PARTIAL_MS;
  });
  const removed = [...backupsToDelete(names, now), ...stale];
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed;
}

/**
 * Copies `<dataDir>/cerebro.db` into `<dataDir>/backups` with VACUUM INTO, a consistent snapshot read through a
 * read-only connection, then applies the rotation. Returns null when there is no database yet.
 */
export function backupDatabase(dataDir, now = Date.now()) {
  const source = join(dataDir, 'cerebro.db');
  if (!existsSync(source)) return null;
  const dir = join(dataDir, 'backups');
  // The copies hold what the database holds (hook tokens among others): owner only, like the sessions directory.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, backupName(now));
  const partial = `${path}.partial`;
  const started = performance.now();
  // The busy timeout lets the copy wait for a writer's commit instead of failing at once.
  const db = new DatabaseSync(source, { readOnly: true, timeout: 5_000 });
  try {
    db.prepare('VACUUM INTO ?').run(partial);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  } finally {
    db.close();
  }
  // Renamed only once complete: a copy cut short keeps its .partial name and cannot be restored by mistake.
  renameSync(partial, path);
  const ms = Math.round(performance.now() - started);
  return { path, bytes: statSync(path).size, ms, removed: pruneBackups(dir, now) };
}

/** One line for the terminal, in French like the server logs. */
export function describeBackup({ path, bytes, ms, removed }) {
  const size = (bytes / 1e6).toFixed(1).replace('.', ',');
  const pruned =
    removed.length === 0
      ? ''
      : ` ; ${removed.length} ancienne${removed.length > 1 ? 's copies supprimées' : ' copie supprimée'}`;
  return `base sauvegardée : ${path} (${size} Mo, ${ms} ms)${pruned}`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  const dataDir = dataDirectory();
  try {
    const copy = backupDatabase(dataDir);
    console.log(
      copy ? describeBackup(copy) : `aucune base à sauvegarder : ${join(dataDir, 'cerebro.db')} n'existe pas`,
    );
  } catch (error) {
    console.error(`sauvegarde de la base en échec : ${error.message}`);
    process.exitCode = 1;
  }
}
