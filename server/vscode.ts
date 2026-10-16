import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR, HOST, PORT } from './config.ts';
import { findProcessesByArgument, processTree, signalProcesses } from './proc.ts';

// VS Code complet, affiché dans une iframe par l'UI. Une seule instance pour tous les projets :
// le dossier ouvert est choisi par `?folder=`.
//
// On lance directement le serveur web que `code serve-web` télécharge : le CLI ne lui transmet pas
// `--disable-workspace-trust`, et en mode restreint Git et la plupart des extensions sont désactivés.

const CLI = process.env.CEREBRO_VSCODE_BIN ?? 'code';
const SERVERS_DIR = join(process.env.VSCODE_CLI_DATA_DIR ?? join(homedir(), '.vscode', 'cli'), 'serve-web');
// Argument unique sur la ligne de commande : retrouve nos processus, y compris orphelins.
const SERVER_DATA_DIR = join(DATA_DIR, 'vscode');
// Port stable : réglages, disposition et onglets de VS Code sont stockés par le navigateur, par origine.
const PREFERRED_PORT = Number(process.env.CEREBRO_VSCODE_PORT ?? PORT + 1);
// Le premier lancement télécharge le serveur VS Code (~100 Mo).
const READY_TIMEOUT_MS = 180_000;

export interface VscodeTarget {
  port: number;
  // Chemin + requête à ouvrir sur l'hôte de l'UI, port `port`.
  path: string;
}

function listen(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, HOST, () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('Port introuvable'));
      });
    });
  });
}

async function pickPort(): Promise<number> {
  try {
    return await listen(PREFERRED_PORT);
  } catch {
    return listen(0);
  }
}

function killLeftovers(): void {
  const roots = findProcessesByArgument(SERVER_DATA_DIR);
  signalProcesses(roots.flatMap((root) => processTree(root.pid)), 'SIGTERM');
}

// Serveur le plus récemment téléchargé par `code serve-web`.
function installedServer(): string | null {
  if (process.env.CEREBRO_VSCODE_SERVER) return process.env.CEREBRO_VSCODE_SERVER;
  let best: { bin: string; mtime: number } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(SERVERS_DIR);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const bin = join(SERVERS_DIR, entry, 'bin', 'code-server');
    if (!existsSync(bin)) continue;
    const mtime = statSync(join(SERVERS_DIR, entry)).mtimeMs;
    if (best === null || mtime > best.mtime) best = { bin, mtime };
  }
  return best?.bin ?? null;
}

// Lance le processus et attend que le serveur réponde (202 tant que `serve-web` télécharge).
async function run(command: string, args: string[], port: number): Promise<ChildProcess> {
  const child = spawn(command, args, { stdio: 'ignore' });
  const failed = new Promise<never>((_, reject) => {
    child.once('error', (caught) => reject(new Error(`Lancement de « ${command} » impossible : ${caught.message}`)));
    child.once('exit', (code) => reject(new Error(`« ${command} » s'est arrêté (code ${code ?? '?'})`)));
  });
  failed.catch(() => {});

  const deadline = Date.now() + READY_TIMEOUT_MS;
  const ready = (async () => {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://${HOST}:${port}/`, { redirect: 'manual' });
        await res.body?.cancel();
        if (res.status !== 202) return;
      } catch {
        // Pas encore à l'écoute.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('VS Code ne répond pas');
  })();

  try {
    await Promise.race([ready, failed]);
  } catch (caught) {
    killLeftovers();
    throw caught;
  }
  return child;
}

export class VscodeServer {
  private starting: Promise<{ port: number; token: string }> | null = null;

  async open(folder: string): Promise<VscodeTarget> {
    this.starting ??= this.start();
    let running: { port: number; token: string };
    try {
      running = await this.starting;
    } catch (caught) {
      this.starting = null;
      throw caught;
    }
    const query = new URLSearchParams({ tkn: running.token, folder });
    return { port: running.port, path: `/?${query.toString()}` };
  }

  stop(): void {
    this.starting = null;
    killLeftovers();
  }

  private async start(): Promise<{ port: number; token: string }> {
    killLeftovers();
    mkdirSync(SERVER_DATA_DIR, { recursive: true });
    const common = ['--accept-server-license-terms', '--server-data-dir', SERVER_DATA_DIR];

    if (installedServer() === null) {
      // Premier lancement : `code serve-web` télécharge le serveur, puis on l'arrête.
      const port = await listen(0);
      await run(CLI, ['serve-web', '--host', HOST, '--port', String(port), '--without-connection-token', ...common], port);
      killLeftovers();
    }
    const server = installedServer();
    if (server === null) throw new Error(`Serveur VS Code introuvable dans ${SERVERS_DIR}`);

    const port = await pickPort();
    const token = randomBytes(24).toString('hex');
    const child = await run(
      server,
      [
        '--host', HOST,
        '--port', String(port),
        '--connection-token', token,
        '--disable-telemetry',
        '--disable-workspace-trust',
        ...common,
      ],
      port,
    );
    const started = this.starting;
    // Serveur mort : le prochain `open` en relance un.
    child.once('exit', () => {
      if (this.starting === started) this.starting = null;
    });
    return { port, token };
  }
}
