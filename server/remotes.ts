import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadRemotes, MACHINE_NAME, type RemoteMachine } from './config.ts';
import { filteredHeaders, relayHttp, relayWebSocket } from './proxy.ts';

const RESPONSE_TIMEOUT_MS = 10_000;

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

export function registerRemoteGateway(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const incomingUrl = new URL(request.raw.url ?? request.url, 'http://localhost');
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

    const headers = { ...filteredHeaders(request.headers, ['host', 'cookie', 'authorization']), ...authorization(remote) };
    relayHttp(request, reply, upstreamUrl(remote, `/api/${rest}`, incomingSearch(request)), headers, {
      unreachable: `Machine ${remote.name} injoignable`,
      unauthorized: `Jeton refusé par ${remote.name}`,
      responseTimeoutMs: RESPONSE_TIMEOUT_MS,
      dropResponseHeaders: ['set-cookie'],
    });
  });

  app.get('/api/machines', async () => ({
    local: { name: MACHINE_NAME },
    remotes: loadRemotes().map(({ id, name }) => ({ id, name })),
  }));

  app.get<{ Params: { id: string; '*': string } }>('/m/:id/ws/*', { websocket: true }, (socket, request) => {
    const remote = loadRemotes().find((candidate) => candidate.id === request.params.id);
    if (remote === undefined) {
      socket.close(1008, 'Machine inconnue');
      return;
    }
    relayWebSocket(socket, upstreamUrl(remote, `/ws/${request.params['*']}`, incomingSearch(request), true), authorization(remote));
  });
}
