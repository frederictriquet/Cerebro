import { ADDRCONFIG, lookup as systemLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { RemoteMachine } from './config.ts';
import { isRecord } from './util.ts';

/*
 * Connexions sortantes vers les machines de remotes.json : résolution de leur nom et requêtes JSON.
 *
 * Node résout un nom par getaddrinfo dans le pool libuv, qui n'exécute que deux résolutions à la fois (la moitié de
 * ses quatre threads) et n'en annule aucune : une requête abandonnée laisse la sienne occuper son emplacement jusqu'à
 * son terme. Un nom MagicDNS que le résolveur local ne servait plus (20 s, puis EAI_AGAIN) a suffi : synchronisation
 * des pairs et relais de l'interface occupaient les deux emplacements en permanence, et toute autre résolution du
 * serveur, celle de slack.com comprise, attendait derrière eux. Pour les pairs, donc :
 * - une seule résolution en cours, tous pairs confondus : l'autre emplacement reste libre pour Slack et le reste du
 *   serveur, même avec plusieurs pairs injoignables ;
 * - une seule par nom : les connexions simultanées vers un pair partagent la sienne ;
 * - un nom résolu est gardé RESOLVED_TTL_MS, puis resservi pendant qu'on le résout de nouveau (STALE_MS au plus) ;
 * - un échec est gardé 1 min, durée doublée à chaque échec suivant jusqu'à 5 min : d'ici là, les connexions vers ce
 *   pair échouent aussitôt, sans résolution ;
 * - une connexion attend une première résolution WAIT_MS au plus ; la résolution, elle, va à son terme et compte
 *   jusque-là dans la limite.
 * getaddrinfo reste la référence (fichier hosts, mDNS, domaines de recherche). dns.resolve* (c-ares) ne passe pas par
 * le pool, mais n'interroge que les serveurs DNS de resolv.conf : il ignorerait une entrée du fichier hosts ajoutée
 * pour contourner le DNS, et n'aurait pas mieux résolu ce nom, que le serveur DNS ne servait plus.
 */

const CONCURRENCY = 1;
const RESOLVED_TTL_MS = 60_000;
const STALE_MS = 5 * 60_000;
const WAIT_MS = 4_000;
const FAILURE_MIN_MS = 60_000;
const FAILURE_MAX_MS = 5 * 60_000;

/** Échec de résolution d'un pair, avec le code de getaddrinfo (`EAI_AGAIN`, `ENOTFOUND`…) ou `ETIMEOUT`. */
export class PeerLookupError extends Error {
  readonly code: string;
  readonly hostname: string;
  readonly syscall = 'getaddrinfo';

  constructor(message: string, code: string, hostname: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PeerLookupError';
    this.code = code;
    this.hostname = hostname;
  }
}

interface Attempt {
  /** Début de la résolution système ; null tant qu'elle attend son tour. */
  startedAt: number | null;
  /** Résolue une fois le résultat enregistré. */
  done: Promise<void>;
}

interface HostState {
  addresses: LookupAddress[] | null;
  expiresAt: number;
  error: PeerLookupError | null;
  failures: number;
  /** Pas de nouvelle tentative avant cette date après un échec. */
  retryAt: number;
  attempt: Attempt | null;
}

function familyOf(value: LookupOptions['family']): 0 | 4 | 6 {
  if (value === 4 || value === 'IPv4') return 4;
  if (value === 6 || value === 'IPv6') return 6;
  return 0;
}

export class PeerResolver {
  private readonly hosts = new Map<string, HostState>();
  private readonly queue: (() => void)[] = [];
  private running = 0;

  /** Option `lookup` de net.connect, http.request et ws. Une adresse IP est rendue telle quelle. */
  readonly lookup: LookupFunction = (hostname, options, callback) => {
    const literal = isIP(hostname);
    const resolved = literal === 0 ? this.resolve(hostname) : Promise.resolve([{ address: hostname, family: literal }]);
    resolved.then(
      (addresses) => {
        const family = familyOf(options.family);
        const matching = family === 0 ? addresses : addresses.filter((entry) => entry.family === family);
        const first = matching[0];
        if (first === undefined) {
          callback(new PeerLookupError(`Nom ${hostname} sans adresse IPv${family}`, 'ENOTFOUND', hostname), '');
        } else if (options.all === true) callback(null, matching);
        else callback(null, first.address, first.family);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), ''),
    );
  };

  /** Résolution par le système (getaddrinfo, dans le pool libuv) ; remplacée dans les tests. */
  systemLookup(hostname: string): Promise<LookupAddress[]> {
    return new Promise((resolve, reject) => {
      systemLookup(hostname, { all: true, hints: process.platform === 'win32' ? 0 : ADDRCONFIG }, (error, found) => {
        if (error === null) resolve(found);
        else reject(error);
      });
    });
  }

  /** Adresses de `hostname`, ou l'erreur de sa dernière résolution tant qu'une nouvelle tentative n'a pas abouti. */
  async resolve(hostname: string): Promise<LookupAddress[]> {
    const name = hostname.toLowerCase();
    const state = this.stateOf(name);
    const arrival = Date.now();
    if (state.addresses !== null && arrival < state.expiresAt) return state.addresses;
    if (state.attempt === null && arrival >= state.retryAt) this.begin(name, state);
    if (state.addresses !== null && arrival < state.expiresAt + STALE_MS) return state.addresses;
    // Nom en échec : on n'attend pas la nouvelle tentative, son résultat servira aux connexions suivantes.
    if (state.error !== null) throw state.error;
    const attempt = state.attempt;
    if (attempt !== null) await this.settled(attempt, arrival);
    if (state.addresses !== null) return state.addresses;
    if (state.error !== null) throw state.error;
    throw attempt?.startedAt === null
      ? new PeerLookupError(
          `Résolution de ${name} en attente depuis plus de ${WAIT_MS / 1_000} s, derrière celle d'un autre pair`,
          'ETIMEOUT',
          name,
        )
      : new PeerLookupError(`Résolution de ${name} trop lente (plus de ${WAIT_MS / 1_000} s)`, 'ETIMEOUT', name);
  }

  private stateOf(name: string): HostState {
    let state = this.hosts.get(name);
    if (state === undefined) {
      state = { addresses: null, expiresAt: 0, error: null, failures: 0, retryAt: 0, attempt: null };
      this.hosts.set(name, state);
    }
    return state;
  }

  /** Attend la fin de la tentative : WAIT_MS au plus depuis l'arrivée, ou depuis son début s'il est antérieur. */
  private async settled(attempt: Attempt, arrival: number): Promise<void> {
    const left = Math.min(arrival, attempt.startedAt ?? arrival) + WAIT_MS - Date.now();
    if (left <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, left);
    });
    await Promise.race([attempt.done, timeout]);
    clearTimeout(timer);
  }

  private begin(name: string, state: HostState): void {
    let finish = (): void => {};
    const attempt: Attempt = {
      startedAt: null,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    state.attempt = attempt;
    this.enqueue(() => {
      attempt.startedAt = Date.now();
      void Promise.resolve()
        .then(() => this.systemLookup(name))
        .then(
          (addresses) => this.record(name, state, addresses, null),
          (error: unknown) => this.record(name, state, null, error),
        )
        .finally(() => {
          state.attempt = null;
          finish();
          this.dequeue();
        });
    });
  }

  private enqueue(start: () => void): void {
    if (this.running < CONCURRENCY) {
      this.running += 1;
      start();
    } else this.queue.push(start);
  }

  /** L'emplacement libéré passe à la tentative suivante. */
  private dequeue(): void {
    const next = this.queue.shift();
    if (next === undefined) this.running -= 1;
    else next();
  }

  private record(name: string, state: HostState, addresses: LookupAddress[] | null, error: unknown): void {
    const now = Date.now();
    if (addresses !== null && addresses.length > 0) {
      state.addresses = addresses;
      state.expiresAt = now + RESOLVED_TTL_MS;
      state.error = null;
      state.failures = 0;
      state.retryAt = 0;
      return;
    }
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'ENOTFOUND';
    state.addresses = null;
    state.failures += 1;
    state.retryAt = now + Math.min(FAILURE_MAX_MS, FAILURE_MIN_MS * 2 ** (state.failures - 1));
    state.error = new PeerLookupError(`Nom ${name} non résolu (${code})`, code, name, { cause: error });
  }
}

/** Résolveur commun à toutes les connexions vers les pairs : sa limite vaut pour tout le processus. */
export const peerResolver = new PeerResolver();

/** URL de `path` sous le chemin de base de la machine distante. */
export function remoteUrl(remote: RemoteMachine, path: string): URL {
  const url = new URL(remote.url);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  url.search = '';
  url.hash = '';
  return url;
}

export interface RemoteResponse {
  status: number;
  /** Corps JSON ; null s'il est vide ou illisible. */
  body: unknown;
}

/**
 * Requête JSON vers une machine de remotes.json, avec son jeton, son nom résolu par `peerResolver`. Rejette sur
 * erreur réseau ou de résolution, ou après `timeoutMs` ; tout statut HTTP est rendu à l'appelant.
 */
export function remoteRequest(
  remote: RemoteMachine,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
): Promise<RemoteResponse> {
  const url = remoteUrl(remote, path);
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: OutgoingHttpHeaders = {
    accept: 'application/json',
    ...(payload === undefined
      ? {}
      : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
    ...(remote.token === undefined ? {} : { authorization: `Bearer ${remote.token}` }),
  };
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const signal = AbortSignal.timeout(options.timeoutMs);
  return new Promise((resolve, reject) => {
    const fail = (error: unknown): void => {
      reject(signal.aborted ? new Error(`pas de réponse en ${options.timeoutMs / 1_000} s`, { cause: error }) : error);
    };
    const request = transport(
      url,
      { method: options.method ?? 'GET', headers, lookup: peerResolver.lookup, signal },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', fail);
        response.on('close', () => {
          if (!response.complete) fail(new Error('réponse interrompue'));
        });
        response.on('end', () => {
          let body: unknown = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // Corps vide ou illisible : null, à l'appelant de juger avec le statut.
          }
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.on('error', fail);
    request.end(payload);
  });
}
