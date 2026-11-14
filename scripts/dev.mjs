#!/usr/bin/env node
// Dev launcher: API server restarted on changes in server/, shared/ and bin/ + Vite dev server (HMR),
// prefixed output, and both stopped together on Ctrl+C or when either one dies.
// The server is restarted by this script rather than `node --watch`: Node's watcher loses track
// of a file once it is saved by rename (atomic write) or recreated by Git, whereas a directory watch survives it.
// Each start runs the migrations and seeds against the real database, even with code saved half-written: the database
// is copied first (scripts/db-backup.mjs) when the code that writes it may have changed.
import { spawn } from 'node:child_process';
import { readdirSync, statSync, watch } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupDatabase, dataDirectory, describeBackup } from './db-backup.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const procs = {
  server: { color: 36, cmd: process.execPath, args: ['--disable-warning=ExperimentalWarning', 'server/index.ts'] },
  web: {
    color: 35,
    cmd: process.execPath,
    args: [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', 'web/vite.config.ts'],
  },
};
const WATCH_DIRS = ['server', 'shared', 'bin'];
const WATCH_EXT = /\.(ts|mts|js|mjs|cjs|json)$/;
// The migrations and seeds live in server/ and shared/; bin/ holds the agents' CLIs.
const DATABASE_CODE = /^(server|shared)[\\/]/;
// Resolved like the server, which runs with `root` as its working directory.
const dataDir = resolve(root, dataDirectory());

let stopping = false;
const children = {};

function log(name, line) {
  process.stdout.write(`\x1b[${procs[name].color}m[${name}]\x1b[0m ${line}\n`);
}

function start(name) {
  const { cmd, args } = procs[name];
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: name === 'server' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.on('data', (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) log(name, line);
    });
  }
  child.on('exit', (code) => {
    if (stopping || child.restarting) return;
    if (name === 'server') {
      // A crash usually means a broken edit: keep dev alive and wait for the next save.
      log(name, `exited (${code}), waiting for changes`);
      return;
    }
    log(name, `exited (${code}), stopping dev`);
    stop(code ?? 1);
  });
  children[name] = child;
  return child;
}

function kill(child) {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    const force = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('exit', () => {
      clearTimeout(force);
      done();
    });
    child.kill('SIGTERM');
  });
}

function waitReadyToRestart(child) {
  if (!child || !child.connected || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((done) => {
    let settled = false;
    let acked = false;
    let ackTimer = null;
    let safetyTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(ackTimer);
      clearTimeout(safetyTimer);
      child.off('message', onMessage);
      child.off('exit', finish);
      child.off('disconnect', finish);
      done();
    };
    const onMessage = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'restart-ack' && !acked) {
        acked = true;
        clearTimeout(ackTimer);
        if (!msg.busy) return finish();
        log('server', '\x1b[33mrestart différé (opération Git en cours…)\x1b[0m');
        safetyTimer = setTimeout(finish, 90_000);
        return;
      }
      if (msg.type === 'restart-ready') finish();
    };
    child.on('message', onMessage);
    child.once('exit', finish);
    child.once('disconnect', finish);
    ackTimer = setTimeout(finish, 500);
    try {
      child.send({ type: 'prepare-restart' });
    } catch {
      finish();
    }
  });
}

// The first start may run database code changed while dev was stopped (pull, checkout): it is preceded by a copy too.
let backupDue = true;

// Called once the previous server has exited, so the copy holds exactly the state the new code starts from.
function startServer() {
  if (backupDue) {
    backupDue = false;
    try {
      const copy = backupDatabase(dataDir);
      if (copy) log('server', describeBackup(copy));
    } catch (error) {
      // The copy is a safety net: the server starts anyway, and the failure stays visible.
      log('server', `\x1b[31msauvegarde de la base en échec, démarrage sans copie : ${error.message}\x1b[0m`);
    }
  }
  start('server');
}

let restartTimer = null;
let pendingFile = null;
let restartRunning = false;
function scheduleRestart(file) {
  // Any change of the burst counts, not only the last file named in the restart line.
  if (DATABASE_CODE.test(file)) backupDue = true;
  pendingFile = file;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (restartRunning || stopping) return;
    restartRunning = true;
    void (async () => {
      try {
        while (pendingFile && !stopping) {
          const target = pendingFile;
          pendingFile = null;
          const child = children.server;
          await waitReadyToRestart(child);
          if (stopping) break;
          // Fold any additional file saves recorded while waiting for the current Git operation to finish.
          const reason = pendingFile ?? target;
          pendingFile = null;
          log('server', `\x1b[32mrestart (${reason})\x1b[0m`);
          child.restarting = true;
          await kill(child);
          if (!stopping) startServer();
        }
      } finally {
        restartRunning = false;
      }
    })();
  }, 150);
}

// One plain watch per directory, not `recursive`: on Linux, Node's recursive watch follows each file and loses one
// deleted then recreated, as `git stash`, `checkout` or `merge` do, so the server kept running stale code. A
// directory watch reports names and survives that. Subdirectories, present or created later, get their own watch.
const watched = new Map();
function unwatch(dir) {
  watched.get(dir)?.close();
  watched.delete(dir);
}
function watchTree(dir) {
  if (watched.has(dir)) return;
  let watcher;
  try {
    watcher = watch(dir, (_event, file) => {
      if (!file) return;
      const path = join(dir, file);
      if (WATCH_EXT.test(file)) return scheduleRestart(relative(root, path));
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat) unwatch(path);
      else if (stat.isDirectory()) watchTree(path);
    });
    watched.set(dir, watcher);
    watcher.on('error', () => unwatch(dir));
    for (const entry of readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory() && entry.name !== 'node_modules') watchTree(join(dir, entry.name));
  } catch {
    // Directory removed meanwhile: its parent's watch picks it up again if it comes back.
    unwatch(dir);
  }
}
for (const dir of WATCH_DIRS) watchTree(join(root, dir));

startServer();
start('web');

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  // kill() escalates to SIGKILL after 3 s, so this always settles.
  await Promise.all(Object.values(children).map(kill));
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
