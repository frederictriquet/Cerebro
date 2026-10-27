import type { FastifyServerOptions } from 'fastify';

// Les journaux du service (journalctl) ne doivent jamais contenir de jeton : `/?token=` sert à la
// connexion initiale et les WebSocket le portent aussi en paramètre. L'éditeur VS Code est chargé
// avec `?tkn=` (jeton de connexion persistant) et ses WebSocket portent `reconnectionToken`. Les
// en-têtes (Authorization, Cookie, x-cerebro-token) ne sont pas journalisés du tout.

const REDACTED = '[REDACTED]';
const SECRET_PARAMS = new Set(['token', 'tkn', 'reconnectiontoken']);

function isSecretParam(name: string): boolean {
  return SECRET_PARAMS.has(name.toLowerCase());
}

export function redactUrl(url: string): string {
  const index = url.indexOf('?');
  if (index === -1) return url;
  const params = new URLSearchParams(url.slice(index + 1));
  if (![...params.keys()].some(isSecretParam)) return url;
  const redacted = [...params].map(([name, value]) => [name, isSecretParam(name) ? REDACTED : value]);
  return `${url.slice(0, index)}?${new URLSearchParams(redacted)}`;
}

// Messages libres de Fastify qui citent l'URL brute (« Reply was already sent … "/ws/…?token=…" »).
export function redactText(text: string): string {
  return text.replace(/([?&][^=&\s"'#]+=)([^&\s"'#]*)/g, (match, prefix: string) => {
    let name = prefix.slice(1, -1);
    try {
      name = decodeURIComponent(name.replaceAll('+', ' '));
    } catch {
      // Nom mal encodé : comparé tel quel.
    }
    return isSecretParam(name) ? `${prefix}${REDACTED}` : match;
  });
}

interface LoggedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

// Mêmes champs que le sérialiseur par défaut de Fastify, URL masquée et sans aucun en-tête.
export function serializeRequest(request: LoggedRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactUrl(request.url),
    version: request.headers['accept-version'],
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

// Copie de l'erreur (même prototype, donc même type pour le sérialiseur `err` de pino) dont les
// chaînes sont masquées : Fastify y cite l'URL brute (FST_ERR_REP_ALREADY_SENT), dans le message
// comme dans la pile. L'erreur d'origine n'est pas modifiée.
function redactError(error: Error, seen = new Set<Error>()): Error {
  seen.add(error);
  const copy = Object.create(Object.getPrototypeOf(error)) as Error;
  for (const key of Reflect.ownKeys(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    let value: unknown = Reflect.get(error, key);
    if (typeof value === 'string') value = redactText(value);
    else if (value instanceof Error && !seen.has(value)) value = redactError(value, seen);
    Object.defineProperty(copy, key, { value, enumerable: descriptor?.enumerable ?? false, writable: true, configurable: true });
  }
  return copy;
}

function redactLogValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) return redactError(value);
  return value;
}

// Objet de fusion (`log.warn({ err })`, `log.info({ path: url }, …)` de @fastify/websocket) : ses
// valeurs de premier niveau sont masquées, sans toucher à l'objet de l'appelant.
function redactLogArg(arg: unknown): unknown {
  if (arg === null || typeof arg !== 'object' || arg instanceof Error) return redactLogValue(arg);
  if (Object.getPrototypeOf(arg) !== Object.prototype) return arg;
  return Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, redactLogValue(value)]));
}

export const LOGGER_OPTIONS = {
  serializers: { req: serializeRequest },
  hooks: {
    logMethod(this: unknown, args: unknown[], method: (...args: unknown[]) => void) {
      method.apply(this, args.map(redactLogArg));
    },
  },
} satisfies FastifyServerOptions['logger'];
