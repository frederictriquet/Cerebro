#!/usr/bin/env node
// Dev launcher: API server restarted on changes in server/, shared/ and bin/ + Vite dev server (HMR),
// prefixed output, and both stopped together on Ctrl+C or when either one dies.
// The server is restarted by this script rather than `node --watch`: Node's watcher loses track
// of a file once it is saved by rename (atomic write) or recreated by Git, whereas a directory watch survives it.
import { spawn } from 'node:child_process';
import { readdirSync, statSync, watch } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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

let stopping = false;
const children = {};

function log(name, line) {
  process.stdout.write(`\x1b[${procs[name].color}m[${name}]\x1b[0m ${line}\n`);
}

function start(name) {
  const { cmd, args } = procs[name];
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, FORCE_COLOR: '1' } });
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
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => {
      clearTimeout(force);
      done();
    });
    child.kill('SIGTERM');
  });
}

let restartTimer = null;
let restarting = Promise.resolve();
function scheduleRestart(file) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restarting = restarting.then(async () => {
      if (stopping) return;
      log('server', `\x1b[32mrestart (${file})\x1b[0m`);
      const child = children.server;
      child.restarting = true;
      await kill(child);
      if (!stopping) start('server');
    });
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

start('server');
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
