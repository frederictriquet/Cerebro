#!/usr/bin/env node
// Dev launcher: API server with `node --watch` + Vite dev server (HMR), prefixed output,
// and both stopped together on Ctrl+C or when either one dies.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const procs = [
  { name: 'server', color: 36, cmd: process.execPath, args: ['--disable-warning=ExperimentalWarning', '--watch-path=server', '--watch-path=bin', '--watch-preserve-output', 'server/index.ts'] },
  { name: 'web', color: 35, cmd: process.execPath, args: [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', 'web/vite.config.ts'] },
];

let stopping = false;
const children = procs.map(({ name, color, cmd, args }) => {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, FORCE_COLOR: '1' } });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.on('data', (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
  }
  child.on('exit', (code) => {
    if (!stopping) {
      process.stdout.write(`${prefix}exited (${code}), stopping dev\n`);
      stop(code ?? 1);
    }
  });
  return child;
});

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
