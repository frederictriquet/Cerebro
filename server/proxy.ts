import { request as httpRequest } from 'node:http';
import type { ClientRequest, IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { FastifyReply, FastifyRequest } from 'fastify';
import WebSocket, { type RawData } from 'ws';

// Relais HTTP et WebSocket vers un autre serveur : passerelle multi-machines et VS Code.

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

// Gérés par la bibliothèque `ws` lors de la poignée de main amont.
const WEBSOCKET_HANDSHAKE_HEADERS = [
  'host',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
];

function connectionHeaders(headers: IncomingHttpHeaders): string[] {
  const value = headers.connection;
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values
    .flatMap((part) => part.split(','))
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export function filteredHeaders(headers: IncomingHttpHeaders, excluded: readonly string[]): OutgoingHttpHeaders {
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaders(headers), ...excluded]);
  const filtered: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !blocked.has(name.toLowerCase())) filtered[name] = value;
  }
  return filtered;
}

export function websocketHeaders(headers: IncomingHttpHeaders, excluded: readonly string[]): OutgoingHttpHeaders {
  return filteredHeaders(headers, [...WEBSOCKET_HANDSHAKE_HEADERS, ...excluded]);
}

// Retire un cookie de l'en-tête Cookie (ex. le jeton Cerebro, qui n'a rien à faire en amont).
export function withoutCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith(`${name}=`));
  return kept.length > 0 ? kept.join('; ') : undefined;
}

export function jsonAfterHijack(reply: FastifyReply, statusCode: number, message: string): void {
  if (reply.raw.headersSent || reply.raw.destroyed) return;
  const body = JSON.stringify({ error: message });
  reply.raw.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  reply.raw.end(body);
}

export interface RelayHttpOptions {
  // Message des erreurs 502.
  unreachable: string;
  // Délai maximal avant les en-têtes de réponse ; aucun par défaut.
  responseTimeoutMs?: number;
  // En-têtes de réponse à ne pas relayer.
  dropResponseHeaders?: readonly string[];
  // Réponse amont 401 remplacée par un 502 portant ce message.
  unauthorized?: string;
}

export function relayHttp(
  request: FastifyRequest,
  reply: FastifyReply,
  target: URL,
  headers: OutgoingHttpHeaders,
  options: RelayHttpOptions,
): void {
  reply.hijack();

  let receivedResponse = false;
  let responseTimeout: NodeJS.Timeout | undefined;
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  let upstreamRequest: ClientRequest;
  try {
    upstreamRequest = transport(target, { method: request.method, headers }, (upstreamResponse) => {
      receivedResponse = true;
      clearTimeout(responseTimeout);
      upstreamResponse.on('error', (caught) => {
        if (!reply.raw.headersSent) jsonAfterHijack(reply, 502, options.unreachable);
        else if (!reply.raw.writableEnded) reply.raw.destroy(caught);
      });
      if (upstreamResponse.statusCode === 401 && options.unauthorized !== undefined) {
        upstreamResponse.resume();
        jsonAfterHijack(reply, 502, options.unauthorized);
        return;
      }
      if (reply.raw.destroyed) {
        upstreamResponse.destroy();
        return;
      }
      reply.raw.writeHead(
        upstreamResponse.statusCode ?? 502,
        filteredHeaders(upstreamResponse.headers, options.dropResponseHeaders ?? []),
      );
      upstreamResponse.pipe(reply.raw);
    });
  } catch {
    jsonAfterHijack(reply, 502, options.unreachable);
    return;
  }
  if (options.responseTimeoutMs !== undefined) {
    responseTimeout = setTimeout(() => {
      if (!receivedResponse) upstreamRequest.destroy(new Error('Délai de réponse dépassé'));
    }, options.responseTimeoutMs);
    responseTimeout.unref();
  }

  upstreamRequest.on('error', (caught) => {
    clearTimeout(responseTimeout);
    if (!reply.raw.headersSent) jsonAfterHijack(reply, 502, options.unreachable);
    else if (!reply.raw.writableEnded) reply.raw.destroy(caught);
  });
  request.raw.once('aborted', () => upstreamRequest.destroy());
  request.raw.once('error', (caught) => upstreamRequest.destroy(caught));
  reply.raw.once('close', () => {
    if (!receivedResponse) upstreamRequest.destroy();
  });
  request.raw.pipe(upstreamRequest);
}

function closeCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

function closeSocket(socket: WebSocket, code: number, reason: Buffer | string, relay = true): void {
  if (socket.readyState === WebSocket.OPEN) socket.close(relay ? closeCode(code) : code, reason);
  else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
}

// La cible peut être en cours de résolution : les messages du client sont mis en file d'ici là.
export function relayWebSocket(socket: WebSocket, target: URL | Promise<URL>, headers: OutgoingHttpHeaders): void {
  let upstream: WebSocket | null = null;
  const queued: { data: RawData; isBinary: boolean }[] = [];
  let ending = false;

  const flush = (): void => {
    if (upstream === null) return;
    for (const message of queued.splice(0)) {
      if (upstream.readyState !== WebSocket.OPEN) break;
      upstream.send(message.data, { binary: message.isBinary });
    }
  };
  const fail = (): void => {
    if (ending) return;
    ending = true;
    queued.length = 0;
    closeSocket(socket, 1011, 'Erreur de connexion distante', false);
    if (upstream !== null) closeSocket(upstream, 1011, 'Erreur de connexion distante', false);
  };

  socket.on('message', (data, isBinary) => {
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream === null || upstream.readyState === WebSocket.CONNECTING) queued.push({ data, isBinary });
  });
  socket.on('error', fail);
  socket.on('close', (code, reason) => {
    if (ending) return;
    ending = true;
    queued.length = 0;
    if (upstream !== null) closeSocket(upstream, code, reason);
  });

  const connect = (url: URL): void => {
    if (ending) return;
    let opened: WebSocket;
    try {
      opened = new WebSocket(url, { headers });
    } catch {
      fail();
      return;
    }
    upstream = opened;
    opened.on('open', flush);
    opened.on('message', (data, isBinary) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: isBinary });
    });
    opened.on('error', fail);
    opened.on('close', (code, reason) => {
      if (ending) return;
      ending = true;
      queued.length = 0;
      closeSocket(socket, code, reason);
    });
  };
  if (target instanceof URL) connect(target);
  else target.then(connect, fail);
}

export function isWebSocketUpgrade(request: FastifyRequest): boolean {
  return request.headers.upgrade?.toLowerCase() === 'websocket';
}
