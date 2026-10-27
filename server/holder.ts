import { appendFileSync, createWriteStream, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { SerializeAddon } from '@xterm/addon-serialize';
import * as headlessPackage from '@xterm/headless';
import * as pty from 'node-pty';
import { processTree, signalProcesses } from './proc.ts';
import type { ProcessInfo } from './proc.ts';

// @xterm/headless is CommonJS at runtime despite exposing ESM-shaped typings.
const Terminal = (headlessPackage as unknown as { default: typeof headlessPackage }).default.Terminal;

interface HolderConfig {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
}

type ClientMessage =
  { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number } | { type: 'kill'; signal: string };

const FORCE_KILL_DELAY_MS = 3_000;
const CLIENT_EXIT_DELAY_MS = 5_000;

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

function send(socket: Socket | null, message: unknown): void {
  if (socket !== null && !socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function validConfig(value: unknown): value is HolderConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.cmd === 'string' &&
    Array.isArray(config.args) &&
    config.args.every((argument) => typeof argument === 'string') &&
    typeof config.cwd === 'string' &&
    typeof config.env === 'object' &&
    config.env !== null &&
    !Array.isArray(config.env) &&
    Number.isInteger(config.cols) &&
    Number(config.cols) > 0 &&
    Number.isInteger(config.rows) &&
    Number(config.rows) > 0
  );
}

function run(configPath: string): void {
  const sessionsDir = dirname(configPath);
  const id = basename(configPath, '.config.json');
  const dataDir = dirname(sessionsDir);
  const socketPath = join(sessionsDir, `${id}.sock`);
  const exitPath = join(sessionsDir, `${id}.exit.json`);
  const holderLogPath = join(sessionsDir, `${id}.holder.log`);
  const terminalLog = createWriteStream(join(dataDir, 'logs', `${id}.log`), { flags: 'a' });
  const report = (error: unknown): void => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    appendFileSync(holderLogPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  };

  let config: HolderConfig;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!validConfig(parsed)) throw new Error('Configuration du holder invalide');
    config = parsed;
  } catch (error) {
    report(error);
    terminalLog.end();
    writeFileSync(exitPath, `${JSON.stringify({ exitCode: 1, signal: 0, at: Date.now() })}\n`, { mode: 0o600 });
    removeFile(configPath);
    return;
  }
  removeFile(configPath);
  removeFile(exitPath);
  removeFile(socketPath);

  const terminal = new Terminal({
    allowProposedApi: true,
    cols: config.cols,
    rows: config.rows,
    scrollback: 5000,
  });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);

  let child: pty.IPty;
  try {
    child = pty.spawn(config.cmd, config.args, {
      name: 'xterm-256color',
      cols: config.cols,
      rows: config.rows,
      cwd: config.cwd,
      env: config.env,
    });
  } catch (error) {
    report(error);
    terminal.dispose();
    // The terminal log is what the UI replays for an exited session: show the failure there.
    const message = error instanceof Error ? error.message : String(error);
    terminalLog.end(`\x1b[31mImpossible de lancer « ${config.cmd} » : ${message}\x1b[0m\r\n`);
    writeFileSync(exitPath, `${JSON.stringify({ exitCode: 1, signal: 0, at: Date.now() })}\n`, { mode: 0o600 });
    return;
  }

  let client: Socket | null = null;
  let cols = config.cols;
  let rows = config.rows;
  let exited = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  let exitCleanupTimer: NodeJS.Timeout | null = null;
  let finishing = false;
  let finalized = false;
  let finalizeRequested = false;
  let terminalLogFinished = false;
  let clientReady = false;
  let pendingClientMessages: unknown[] = [];
  // Everything the agent spawned: child.kill() alone only reaches the agent itself.
  const tracked = new Map<number, ProcessInfo>();
  const collectTree = (): ProcessInfo[] => {
    for (const info of processTree(child.pid)) tracked.set(info.pid, info);
    return [...tracked.values()].filter((info) => info.pid !== child.pid);
  };

  const finalize = (): void => {
    if (finalized) return;
    if (!terminalLogFinished) {
      finalizeRequested = true;
      return;
    }
    finalized = true;
    if (exitCleanupTimer !== null) clearTimeout(exitCleanupTimer);
    signalProcesses(collectTree(), 'SIGKILL');
    removeFile(socketPath);
    terminal.dispose();
    process.exit(0);
  };

  const finish = (): void => {
    if (finishing) return;
    finishing = true;
    server.close(() => finalize());
    if (client === null || client.destroyed) {
      finalize();
      return;
    }
    exitCleanupTimer = setTimeout(() => {
      client?.destroy();
      finalize();
    }, CLIENT_EXIT_DELAY_MS);
  };

  const sendToClient = (message: unknown): void => {
    if (client === null || client.destroyed) return;
    if (clientReady) send(client, message);
    else pendingClientMessages.push(message);
  };

  const handleMessage = (message: ClientMessage): void => {
    if (exited) return;
    if (message.type === 'input' && typeof message.data === 'string') {
      child.write(message.data);
      return;
    }
    if (
      message.type === 'resize' &&
      Number.isInteger(message.cols) &&
      Number.isInteger(message.rows) &&
      message.cols > 0 &&
      message.rows > 0
    ) {
      cols = message.cols;
      rows = message.rows;
      child.resize(cols, rows);
      terminal.resize(cols, rows);
      return;
    }
    if (message.type !== 'kill' || (message.signal !== 'SIGTERM' && message.signal !== 'SIGKILL')) return;
    const descendants = collectTree();
    try {
      child.kill(message.signal);
    } catch (error) {
      report(error);
      return;
    }
    signalProcesses(descendants, message.signal);
    if (message.signal === 'SIGTERM') {
      if (forceKillTimer !== null) clearTimeout(forceKillTimer);
      forceKillTimer = setTimeout(() => {
        forceKillTimer = null;
        if (!exited) {
          try {
            child.kill('SIGKILL');
          } catch (error) {
            report(error);
          }
        }
        signalProcesses(collectTree(), 'SIGKILL');
      }, FORCE_KILL_DELAY_MS);
    }
  };

  const server = createServer((socket) => {
    client?.destroy();
    client = socket;
    clientReady = false;
    pendingClientMessages = [];
    socket.setEncoding('utf8');
    let input = '';
    send(socket, { type: 'hello', pid: process.pid, cols, rows });
    // Flush xterm's asynchronous write queue before serializing, and retain PTY
    // output produced in the meantime so snapshot always precedes output.
    terminal.write('', () => {
      if (client !== socket || socket.destroyed) return;
      send(socket, { type: 'snapshot', data: serializer.serialize() });
      clientReady = true;
      for (const message of pendingClientMessages) send(socket, message);
      pendingClientMessages = [];
      if (exited) {
        socket.end();
        finish();
      }
    });
    socket.on('data', (chunk) => {
      input += chunk;
      let newline = input.indexOf('\n');
      while (newline >= 0) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        try {
          handleMessage(JSON.parse(line) as ClientMessage);
        } catch {
          // Ignore malformed or incomplete client messages.
        }
        newline = input.indexOf('\n');
      }
      if (input.length > 1024 * 1024) input = '';
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (client === socket) {
        client = null;
        clientReady = false;
        pendingClientMessages = [];
      }
      if (exited) finish();
    });
  });
  server.on('error', (error) => {
    report(error);
    try {
      child.kill('SIGTERM');
    } catch {
      // The child may already have exited.
    }
  });

  child.onData((data) => {
    terminalLog.write(data);
    terminal.write(data);
    sendToClient({ type: 'output', data });
  });
  child.onExit(({ exitCode, signal }) => {
    exited = true;
    if (forceKillTimer !== null) clearTimeout(forceKillTimer);
    // Leftovers (background jobs, detached helpers) get a chance to stop before finalize() kills them.
    signalProcesses(collectTree(), 'SIGTERM');
    terminalLog.end(() => {
      terminalLogFinished = true;
      if (finalizeRequested) finalize();
    });
    writeFileSync(exitPath, `${JSON.stringify({ exitCode, signal, at: Date.now() })}\n`, { mode: 0o600 });
    sendToClient({ type: 'exit', exitCode, signal });
    if (clientReady) {
      client?.end();
      finish();
    } else if (client === null) {
      finish();
    }
  });

  server.listen(socketPath);
}

process.on('SIGHUP', () => {});
process.on('SIGINT', () => {});
process.on('uncaughtException', (error) => {
  const configPath = process.argv[2];
  if (configPath !== undefined) {
    const id = basename(configPath, '.config.json');
    appendFileSync(
      join(dirname(configPath), `${id}.holder.log`),
      `${new Date().toISOString()} ${error.stack ?? error.message}\n`,
      { mode: 0o600 },
    );
  }
  process.exit(1);
});

const configPath = process.argv[2];
if (configPath === undefined) throw new Error('Chemin de configuration manquant');
run(configPath);
