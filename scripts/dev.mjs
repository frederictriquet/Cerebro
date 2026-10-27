#!/usr/bin/env node
// Dev launcher: API server restarted on changes in server/, shared/ and bin/ + Vite dev server (HMR),
// prefixed output, and both stopped together on Ctrl+C or when either one dies.
// The server is restarted by this script rather than `node --watch`: Node's watcher loses track
// of a file once it is saved by rename (atomic write), whereas a directory watch survives it.
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
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

for (const dir of WATCH_DIRS) {
  // Recursive so that a future subdirectory also triggers a restart (supported on Linux since Node 20).
  watch(join(root, dir), { recursive: true }, (_event, file) => {
    if (file && WATCH_EXT.test(file)) scheduleRestart(`${dir}/${file}`);
  });
}

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
