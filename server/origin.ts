import type { IncomingHttpHeaders } from 'node:http';
import { BIND_TOKEN, HOST, PORT, PUBLIC_URL } from './config.ts';
import { VITE_DEV_HOST, VITE_DEV_PORT } from './ports.ts';

// Protection contre les requêtes intersites : une page web quelconque ouverte dans le navigateur
// peut ouvrir un WebSocket ou envoyer un POST au serveur local. Le navigateur joint alors toujours
// l'en-tête Origin, que la page ne peut pas falsifier ; les clients hors navigateur (bins d'agents,
// hooks, passerelle entre machines) n'en envoient pas.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginPolicy {
  // Origines de l'interface, normalisées (`new URL(…).origin`).
  trusted: ReadonlySet<string>;
  // Avec un jeton, une page de même origine que l'hôte demandé est acceptée : un rebinding DNS
  // donne bien la même origine, mais sans le cookie ni le jeton, la requête reste refusée.
  tokenProtected: boolean;
}

function normalizedOrigin(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

export function originPolicy(options: {
  host: string;
  port: number;
  publicUrl: string;
  tokenProtected: boolean;
}): OriginPolicy {
  const candidates = [
    options.publicUrl,
    `http://${urlHost(options.host)}:${options.port}`,
    ...['127.0.0.1', 'localhost', '[::1]'].map((host) => `http://${host}:${options.port}`),
    ...[VITE_DEV_HOST, 'localhost'].map((host) => `http://${host}:${VITE_DEV_PORT}`),
  ];
  const trusted = new Set(candidates.map(normalizedOrigin).filter((origin) => origin !== null));
  return { trusted, tokenProtected: options.tokenProtected };
}

export const DEFAULT_ORIGIN_POLICY = originPolicy({
  host: HOST,
  port: PORT,
  publicUrl: PUBLIC_URL,
  tokenProtected: BIND_TOKEN !== undefined,
});

function firstHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(',', 1)[0]?.trim().toLowerCase() || undefined;
}

/**
 * Refuse les upgrades WebSocket et les mutations venant d'une origine étrangère.
 * `explicitToken` : la requête porte le jeton en en-tête Authorization ou en paramètre, ce qu'une
 * page tierce ne peut pas fournir (contrairement au cookie, joint automatiquement).
 */
export function originAllowed(
  request: { method: string; headers: IncomingHttpHeaders },
  explicitToken: boolean,
  policy: OriginPolicy = DEFAULT_ORIGIN_POLICY,
): boolean {
  const header = request.headers.origin;
  if (header === undefined) return true;
  const upgrade = request.headers.upgrade?.toLowerCase() === 'websocket';
  if (!upgrade && SAFE_METHODS.has(request.method.toUpperCase())) return true;
  if (explicitToken) return true;
  const origin = normalizedOrigin(header);
  if (origin === null) return false;
  if (policy.trusted.has(origin)) return true;
  if (!policy.tokenProtected) return false;
  const host = new URL(origin).host;
  return [request.headers.host, request.headers['x-forwarded-host']].some((value) => firstHeader(value) === host);
}
