import { request as httpRequest } from 'node:http';
import type { ClientRequest, IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { FastifyInstance, FastifyReply } from 'fastify';
import WebSocket, { type RawData } from 'ws';
import { loadRemotes, MACHINE_NAME } from './config.ts';

const RESPONSE_TIMEOUT_MS = 10_000;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function connectionHeaders(headers: IncomingHttpHeaders): string[] {
  const value = headers.connection;
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.flatMap((part) => part.split(',')).map((part) => part.trim().toLowerCase()).filter(Boolean);
}

function filteredHeaders(headers: IncomingHttpHeaders, excluded: readonly string[]): OutgoingHttpHeaders {
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaders(headers), ...excluded]);
  const filtered: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !blocked.has(name.toLowerCase())) filtered[name] = value;
  }
  return filtered;
}

function jsonAfterHijack(reply: FastifyReply, statusCode: number, message: string): void {
  if (reply.raw.headersSent || reply.raw.destroyed) return;
  const body = JSON.stringify({ error: message });
  reply.raw.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  reply.raw.end(body);
}

function closeCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

function closeSocket(socket: WebSocket, code: number, reason: Buffer | string, relay = true): void {
  if (socket.readyState === WebSocket.OPEN) socket.close(relay ? closeCode(code) : code, reason);
  else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
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

    incomingUrl.searchParams.delete('token');
    const target = new URL(remote.url);
    target.pathname = `${target.pathname.replace(/\/$/, '')}/api/${rest}`;
    target.search = incomingUrl.search;
    target.hash = '';

    const headers = filteredHeaders(request.headers, ['host', 'cookie', 'authorization']);
    if (remote.token !== undefined) headers.authorization = `Bearer ${remote.token}`;
    reply.hijack();

    let receivedResponse = false;
    const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
    let upstreamRequest: ClientRequest;
    try {
      upstreamRequest = transport(target, { method: request.method, headers }, (upstreamResponse) => {
        receivedResponse = true;
        clearTimeout(responseTimeout);
        upstreamResponse.on('error', (caught) => {
          if (!reply.raw.headersSent) jsonAfterHijack(reply, 502, `Machine ${remote.name} injoignable`);
          else if (!reply.raw.writableEnded) reply.raw.destroy(caught);
        });
        if (upstreamResponse.statusCode === 401) {
          upstreamResponse.resume();
          jsonAfterHijack(reply, 502, `Jeton refusé par ${remote.name}`);
          return;
        }
        if (reply.raw.destroyed) {
          upstreamResponse.destroy();
          return;
        }
        reply.raw.writeHead(
          upstreamResponse.statusCode ?? 502,
          filteredHeaders(upstreamResponse.headers, ['set-cookie']),
        );
        upstreamResponse.pipe(reply.raw);
      });
    } catch {
      jsonAfterHijack(reply, 502, `Machine ${remote.name} injoignable`);
      return;
    }
    const responseTimeout = setTimeout(() => {
      if (!receivedResponse) upstreamRequest.destroy(new Error('Délai de réponse dépassé'));
    }, RESPONSE_TIMEOUT_MS);
    responseTimeout.unref();

    upstreamRequest.on('error', (caught) => {
      clearTimeout(responseTimeout);
      if (!reply.raw.headersSent) jsonAfterHijack(reply, 502, `Machine ${remote.name} injoignable`);
      else if (!reply.raw.writableEnded) reply.raw.destroy(caught);
    });
    request.raw.once('aborted', () => upstreamRequest.destroy());
    request.raw.once('error', (caught) => upstreamRequest.destroy(caught));
    reply.raw.once('close', () => {
      if (!receivedResponse) upstreamRequest.destroy();
    });
    request.raw.pipe(upstreamRequest);
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

    const incomingUrl = new URL(request.raw.url ?? request.url, 'http://localhost');
    incomingUrl.searchParams.delete('token');
    const target = new URL(remote.url);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    target.pathname = `${target.pathname.replace(/\/$/, '')}/ws/${request.params['*']}`;
    target.search = incomingUrl.search;
    target.hash = '';
    const headers = remote.token === undefined ? {} : { authorization: `Bearer ${remote.token}` };
    let upstream: WebSocket;
    try {
      upstream = new WebSocket(target, { headers });
    } catch {
      socket.close(1011, 'Erreur de connexion distante');
      return;
    }
    const queued: { data: RawData; isBinary: boolean }[] = [];
    let ending = false;

    socket.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING) queued.push({ data, isBinary });
    });
    upstream.on('open', () => {
      for (const message of queued.splice(0)) {
        if (upstream.readyState !== WebSocket.OPEN) break;
        upstream.send(message.data, { binary: message.isBinary });
      }
    });
    upstream.on('message', (data, isBinary) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: isBinary });
    });

    const fail = (): void => {
      if (ending) return;
      ending = true;
      queued.length = 0;
      closeSocket(socket, 1011, 'Erreur de connexion distante', false);
      closeSocket(upstream, 1011, 'Erreur de connexion distante', false);
    };
    socket.on('error', fail);
    upstream.on('error', fail);
    socket.on('close', (code, reason) => {
      if (ending) return;
      ending = true;
      queued.length = 0;
      closeSocket(upstream, code, reason);
    });
    upstream.on('close', (code, reason) => {
      if (ending) return;
      ending = true;
      queued.length = 0;
      closeSocket(socket, code, reason);
    });
  });
}
