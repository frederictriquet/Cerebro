import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadRemotes, MACHINE_NAME, type RemoteMachine } from './config.ts';
import type { PeerSync } from './peers.ts';
import {
  filteredHeaders,
  isWebSocketUpgrade,
  relayHttp,
  relayWebSocket,
  websocketHeaders,
  withoutCookie,
} from './proxy.ts';
import { VERSION_INFO } from './version.ts';

const RESPONSE_TIMEOUT_MS = 10_000;
// Au démarrage, le premier échange avec les machines distantes donne leur version.
const FIRST_SYNC_WAIT_MS = 3_000;

function upstreamUrl(remote: RemoteMachine, path: string, search: string, websocket = false): URL {
  const target = new URL(remote.url);
  if (websocket) target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  target.pathname = `${target.pathname.replace(/\/$/, '')}${path}`;
  target.search = search;
  target.hash = '';
  return target;
}

function incomingSearch(request: FastifyRequest): string {
  const incomingUrl = new URL(request.raw.url ?? request.url, 'http://localhost');
  incomingUrl.searchParams.delete('token');
  return incomingUrl.search;
}

function authorization(remote: RemoteMachine): OutgoingHttpHeaders {
  return remote.token === undefined ? {} : { authorization: `Bearer ${remote.token}` };
}

// VS Code distant : ses cookies (jeton VS Code) passent, pas celui de Cerebro. Les en-têtes x-forwarded
// lui font générer ses URLs sous /m/<id>/vscode, sur l'hôte du navigateur.
function vscodeHeaders(request: FastifyRequest, remote: RemoteMachine, base: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ...base, ...authorization(remote) };
  const cookie = withoutCookie(request.headers.cookie, 'cerebro_token');
  if (cookie === undefined) delete headers.cookie;
  else headers.cookie = cookie;
  headers['x-forwarded-host'] = request.headers['x-forwarded-host'] ?? request.headers.host;
  headers['x-forwarded-prefix'] = `/m/${remote.id}/vscode`;
  return headers;
}

export function registerRemoteGateway(app: FastifyInstance, peers: PeerSync): void {
  app.addHook('onRequest', async (request, reply) => {
    const incomingUrl = new URL(request.raw.url ?? request.url, 'http://localhost');

    const vscode = /^\/m\/([^/]+)\/vscode(\/.*)?$/.exec(incomingUrl.pathname);
    if (vscode !== null) {
      if (isWebSocketUpgrade(request)) return;
      const remote = loadRemotes().find((candidate) => candidate.id === vscode[1]);
      if (remote === undefined) return reply.code(404).send({ error: 'Machine inconnue' });
      const headers = vscodeHeaders(request, remote, filteredHeaders(request.headers, ['host', 'authorization']));
      relayHttp(request, reply, upstreamUrl(remote, `/vscode${vscode[2] ?? '/'}`, incomingUrl.search), headers, {
        unreachable: `Machine ${remote.name} injoignable`,
        unauthorized: `Jeton refusé par ${remote.name}`,
      });
      return;
    }

    const match = /^\/m\/([^/]+)\/api\/(.*)$/.exec(incomingUrl.pathname);
    if (match === null) return;

    const remote = loadRemotes().find((candidate) => candidate.id === match[1]);
    if (remote === undefined) return reply.code(404).send({ error: 'Machine inconnue' });
    const rest = match[2] ?? '';
    let decodedRest = rest;
    try {
      decodedRest = decodeURIComponent(rest);
    } catch {
      // The upstream will return the appropriate error for a malformed path.
    }
    if (/^(hook|notify|backlog)\//.test(decodedRest)) {
      return reply.code(403).send({ error: 'Route non relayée' });
    }

    const headers = {
      ...filteredHeaders(request.headers, ['host', 'cookie', 'authorization']),
      ...authorization(remote),
    };
    relayHttp(request, reply, upstreamUrl(remote, `/api/${rest}`, incomingSearch(request)), headers, {
      unreachable: `Machine ${remote.name} injoignable`,
      unauthorized: `Jeton refusé par ${remote.name}`,
      responseTimeoutMs: RESPONSE_TIMEOUT_MS,
      dropResponseHeaders: ['set-cookie'],
    });
  });

  app.get('/api/machines', async () => {
    await Promise.race([peers.synced, new Promise((resolve) => setTimeout(resolve, FIRST_SYNC_WAIT_MS).unref())]);
    return {
      local: { name: MACHINE_NAME, version: VERSION_INFO },
      // status null : pas encore d'échange avec cette machine.
      remotes: loadRemotes().map(({ id, name }) => ({ id, name, status: peers.remoteVersion(id) })),
    };
  });

  app.get<{ Params: { id: string; '*': string } }>('/m/:id/ws/*', { websocket: true }, (socket, request) => {
    const remote = loadRemotes().find((candidate) => candidate.id === request.params.id);
    if (remote === undefined) {
      socket.close(1008, 'Machine inconnue');
      return;
    }
    relayWebSocket(
      socket,
      upstreamUrl(remote, `/ws/${request.params['*']}`, incomingSearch(request), true),
      authorization(remote),
    );
  });

  app.get<{ Params: { id: string; '*': string } }>('/m/:id/vscode/*', { websocket: true }, (socket, request) => {
    const remote = loadRemotes().find((candidate) => candidate.id === request.params.id);
    if (remote === undefined) {
      socket.close(1008, 'Machine inconnue');
      return;
    }
    const search = new URL(request.raw.url ?? request.url, 'http://localhost').search;
    const headers = vscodeHeaders(request, remote, websocketHeaders(request.headers, ['authorization']));
    relayWebSocket(socket, upstreamUrl(remote, `/vscode/${request.params['*']}`, search, true), headers);
  });
}
