import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { OutgoingHttpHeaders } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withoutCerebroVariables } from './agent-env.ts';
import { DATA_DIR } from './config.ts';
import { findProcessesByArgumentAndEnvironment, isAlive, processTree, signalProcesses } from './proc.ts';
import { filteredHeaders, isWebSocketUpgrade, relayHttp, relayWebSocket, websocketHeaders, withoutCookie } from './proxy.ts';

// VS Code complet, affiché dans une iframe par l'UI et relayé sous /vscode/ (sous /m/<id>/vscode/ par la
// passerelle multi-machines). Une seule instance pour tous les projets : le dossier est choisi par `?folder=`.
//
// On lance directement le serveur web que `code serve-web` télécharge : le CLI ne lui transmet pas
// `--disable-workspace-trust`, et en mode restreint Git et la plupart des extensions sont désactivés.

const CLI = process.env.CEREBRO_VSCODE_BIN ?? 'code';
const SERVERS_DIR = join(process.env.VSCODE_CLI_DATA_DIR ?? join(homedir(), '.vscode', 'cli'), 'serve-web');
const SERVER_DATA_DIR = join(DATA_DIR, 'vscode');
// Nos serveurs portent SERVER_DATA_DIR en argument et ce marqueur dans leur environnement : on les retrouve,
// y compris orphelins, sans viser un programme de l'utilisateur dont la ligne de commande nommerait ce dossier.
const MARKER_NAME = 'CEREBRO_VSCODE_DATA_DIR';
const MARKER = `${MARKER_NAME}=${SERVER_DATA_DIR}`;
// Le serveur choisit lui-même son port (`--port 0`) et l'annonce ainsi sur sa sortie standard.
const LISTENING = /Web UI available at https?:\/\/[^\s/?]+:(\d+)/;
// Conservé entre redémarrages : une iframe rechargée garde son cookie valide.
const TOKEN_FILE = join(SERVER_DATA_DIR, 'token');
const LOOPBACK = '127.0.0.1';
// Le premier lancement télécharge le serveur VS Code (~100 Mo).
const READY_TIMEOUT_MS = 180_000;
// Au-delà, l'API répond « pas prêt » et le client réessaie (la passerelle coupe à 10 s).
const OPEN_WAIT_MS = 5_000;
// Délai laissé à SIGTERM avant SIGKILL.
const KILL_GRACE_MS = 3_000;

interface Running {
  port: number;
  token: string;
}

export type VscodeOpenResult = { ready: false } | { ready: true; path: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killLeftovers(): Promise<void> {
  const targets = findProcessesByArgumentAndEnvironment(SERVER_DATA_DIR, MARKER).flatMap((root) => processTree(root.pid));
  if (targets.length === 0) return;
  signalProcesses(targets, 'SIGTERM');
  const deadline = Date.now() + KILL_GRACE_MS;
  while (targets.some(isAlive) && Date.now() < deadline) await delay(100);
  signalProcesses(targets, 'SIGKILL');
}

function loadToken(): string {
  try {
    const saved = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[a-f0-9]{32,}$/.test(saved)) return saved;
  } catch {
    // Premier lancement.
  }
  const token = randomBytes(24).toString('hex');
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
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
async function run(command: string, args: string[]): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(command, [...args, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...withoutCerebroVariables(), [MARKER_NAME]: SERVER_DATA_DIR },
  });
  const failed = new Promise<never>((_, reject) => {
    child.once('error', (caught) => reject(new Error(`Lancement de « ${command} » impossible : ${caught.message}`)));
    child.once('exit', (code) => reject(new Error(`« ${command} » s'est arrêté (code ${code ?? '?'})`)));
  });
  failed.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('VS Code ne répond pas')), READY_TIMEOUT_MS);
  });
  expired.catch(() => {});

  // La sortie reste lue ensuite, sinon le serveur bloquerait sur un tube plein.
  const listening = new Promise<number>((resolve) => {
    let output = '';
    const onData = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-4096);
      const match = LISTENING.exec(output);
      if (match === null) return;
      output = '';
      child.stdout?.off('data', onData).resume();
      resolve(Number(match[1]));
    };
    child.stdout?.on('data', onData);
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  const ready = (async () => {
    const port = await listening;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://${LOOPBACK}:${port}/`, { redirect: 'manual' });
        await res.body?.cancel();
        if (res.status !== 202) return port;
      } catch {
        // Pas encore à l'écoute.
      }
      await delay(500);
    }
    throw new Error('VS Code ne répond pas');
  })();
  ready.catch(() => {});

  try {
    return { child, port: await Promise.race([ready, failed, expired]) };
  } catch (caught) {
    await killLeftovers();
    throw caught;
  } finally {
    clearTimeout(timer);
  }
}

export class VscodeServer {
  private starting: Promise<Running> | null = null;

  // Démarre le serveur au besoin ; `null` s'il n'est pas prêt dans `waitMs`.
  async ensure(waitMs = Number.POSITIVE_INFINITY): Promise<Running | null> {
    if (this.starting === null) {
      const starting = this.start();
      this.starting = starting;
      starting.catch(() => {
        if (this.starting === starting) this.starting = null;
      });
    }
    const starting = this.starting;
    if (!Number.isFinite(waitMs)) return starting;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
    });
    try {
      return await Promise.race([starting, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async open(folder: string): Promise<VscodeOpenResult> {
    const running = await this.ensure(OPEN_WAIT_MS);
    if (running === null) return { ready: false };
    const query = new URLSearchParams({ tkn: running.token, folder });
    return { ready: true, path: `/vscode/?${query.toString()}` };
  }

  async stop(): Promise<void> {
    this.starting = null;
    await killLeftovers();
  }

  private async start(): Promise<Running> {
    await killLeftovers();
    mkdirSync(SERVER_DATA_DIR, { recursive: true });
    const common = ['--accept-server-license-terms', '--server-data-dir', SERVER_DATA_DIR];

    if (installedServer() === null) {
      // Premier lancement : `code serve-web` télécharge le serveur, puis on l'arrête.
      await run(CLI, ['serve-web', '--host', LOOPBACK, '--without-connection-token', ...common]);
      await killLeftovers();
    }
    const server = installedServer();
    if (server === null) throw new Error(`Serveur VS Code introuvable dans ${SERVERS_DIR}`);

    const token = loadToken();
    const { child, port } = await run(
      server,
      [
        '--host', LOOPBACK,
        '--connection-token', token,
        '--disable-telemetry',
        '--disable-workspace-trust',
        ...common,
      ],
    );
    const started = this.starting;
    // Serveur mort : le prochain accès en relance un.
    child.once('exit', () => {
      if (this.starting === started) this.starting = null;
    });
    return { port, token };
  }
}

// Le jeton Cerebro reste ici. Un x-forwarded-prefix posé par la passerelle d'une autre machine est conservé.
function relayHeaders(request: FastifyRequest, base: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const headers = { ...base };
  const cookie = withoutCookie(request.headers.cookie, 'cerebro_token');
  if (cookie === undefined) delete headers.cookie;
  else headers.cookie = cookie;
  headers['x-forwarded-host'] ??= request.headers.host;
  headers['x-forwarded-prefix'] ??= '/vscode';
  return headers;
}

export function registerVscodeRelay(app: FastifyInstance, vscode: VscodeServer): void {
  app.addHook('onRequest', async (request, reply) => {
    const url = new URL(request.raw.url ?? request.url, 'http://localhost');
    const match = /^\/vscode(\/.*)?$/.exec(url.pathname);
    if (match === null || isWebSocketUpgrade(request)) return;
    let running: Running | null;
    try {
      running = await vscode.ensure();
    } catch (caught) {
      return reply.code(502).send({ error: caught instanceof Error ? caught.message : 'VS Code indisponible' });
    }
    if (running === null) return reply.code(503).send({ error: 'VS Code démarre' });
    const target = new URL(`http://${LOOPBACK}:${running.port}${match[1] ?? '/'}${url.search}`);
    const headers = relayHeaders(request, filteredHeaders(request.headers, ['host', 'authorization']));
    relayHttp(request, reply, target, headers, { unreachable: 'VS Code injoignable' });
  });

  app.get<{ Params: { '*': string } }>('/vscode/*', { websocket: true }, (socket, request) => {
    const url = new URL(request.raw.url ?? request.url, 'http://localhost');
    const target = vscode.ensure().then((running) => {
      if (running === null) throw new Error('VS Code indisponible');
      return new URL(`ws://${LOOPBACK}:${running.port}/${request.params['*']}${url.search}`);
    });
    relayWebSocket(socket, target, relayHeaders(request, websocketHeaders(request.headers, ['authorization'])));
  });
}
