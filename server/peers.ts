import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR, loadRemotes, MACHINE_NAME } from './config.ts';
import type { CerebroDatabase, Project } from './db.ts';

/*
 * Coordination entre instances Cerebro qui partagent le même bot Slack. Un projet présent sur
 * plusieurs machines (même nom, même origin git) n'est traité sur Slack que par une seule d'entre
 * elles : celle qui détient le « claim » du nom. Les claims se fusionnent en dernier-écrit-gagne,
 * si bien qu'un seul sens de connexion (remotes.json d'un côté) suffit à faire converger les deux.
 */

const execFileAsync = promisify(execFile);
const ID_FILE = join(DATA_DIR, 'instance-id');
const STATE_FILE = join(DATA_DIR, 'peers.json');
const SYNC_INTERVAL_MS = 15_000;
const SYNC_TIMEOUT_MS = 5_000;
const PEER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_NOTICES = 50;

export interface Claim {
  owner: string;
  ownerName: string;
  at: number;
  auto: boolean;
}

export interface PeerProject {
  name: string;
  origin: string | null;
  appearedAt: number;
}

interface PeerInfo {
  machine: string;
  projects: PeerProject[];
  lastSeen: number;
}

export interface PeerNotice {
  id: string;
  at: number;
  projectName: string;
  text: string;
}

interface PeerState {
  claims: Record<string, Claim>;
  renamedAt: Record<string, number>;
  peers: Record<string, PeerInfo>;
  notices: PeerNotice[];
  // Conflits de nom déjà signalés : on n'avertit qu'une fois tant qu'ils durent.
  announced: string[];
}

export interface SyncPayload {
  instanceId: string;
  machine: string;
  projects: PeerProject[];
  claims: Record<string, Claim>;
}

export interface ProjectSlackStatus {
  shared: boolean;
  conflict: boolean;
  peerMachine: string | null;
  owner: 'local' | 'remote' | null;
  ownerMachine: string | null;
}

export function normalizeProjectName(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLocaleLowerCase('fr-FR');
}

// git@github.com:a/b.git, https://user@github.com/a/b et ssh://git@github.com/a/b désignent le même dépôt.
export function normalizeOrigin(value: string): string | null {
  let url = value.trim();
  if (url === '') return null;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(url);
  if (scp !== null) url = `${scp[1] ?? ''}/${scp[2] ?? ''}`;
  else url = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '');
  url = url.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const slash = url.indexOf('/');
  const host = (slash < 0 ? url : url.slice(0, slash)).toLowerCase().replace(/:\d+$/, '');
  return slash < 0 ? host : `${host}${url.slice(slash)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function claimFrom(value: unknown): Claim | null {
  if (!isRecord(value) || typeof value.owner !== 'string' || value.owner === ''
    || typeof value.ownerName !== 'string' || !finiteNumber(value.at) || typeof value.auto !== 'boolean') return null;
  return { owner: value.owner, ownerName: value.ownerName, at: value.at, auto: value.auto };
}

function claimsFrom(value: unknown): Record<string, Claim> {
  const claims: Record<string, Claim> = {};
  if (!isRecord(value)) return claims;
  for (const [name, raw] of Object.entries(value)) {
    const claim = claimFrom(raw);
    if (claim !== null && name !== '') claims[name] = claim;
  }
  return claims;
}

function peerProjectsFrom(value: unknown): PeerProject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.name !== 'string' || !finiteNumber(raw.appearedAt)
      || (raw.origin !== null && typeof raw.origin !== 'string')) return [];
    return [{ name: raw.name, origin: raw.origin, appearedAt: raw.appearedAt }];
  });
}

export function syncPayloadFrom(value: unknown): SyncPayload | null {
  if (!isRecord(value) || typeof value.instanceId !== 'string' || value.instanceId === ''
    || typeof value.machine !== 'string' || !Array.isArray(value.projects)) return null;
  return {
    instanceId: value.instanceId,
    machine: value.machine,
    projects: peerProjectsFrom(value.projects),
    claims: claimsFrom(value.claims),
  };
}

function stateFrom(value: unknown): PeerState {
  const state: PeerState = { claims: {}, renamedAt: {}, peers: {}, notices: [], announced: [] };
  if (!isRecord(value)) return state;
  state.claims = claimsFrom(value.claims);
  if (isRecord(value.renamedAt)) {
    for (const [id, at] of Object.entries(value.renamedAt)) if (finiteNumber(at)) state.renamedAt[id] = at;
  }
  if (isRecord(value.peers)) {
    for (const [id, raw] of Object.entries(value.peers)) {
      if (!isRecord(raw) || typeof raw.machine !== 'string' || !finiteNumber(raw.lastSeen)) continue;
      state.peers[id] = { machine: raw.machine, projects: peerProjectsFrom(raw.projects), lastSeen: raw.lastSeen };
    }
  }
  if (Array.isArray(value.notices)) {
    state.notices = value.notices.filter((raw): raw is PeerNotice => isRecord(raw)
      && typeof raw.id === 'string' && finiteNumber(raw.at)
      && typeof raw.projectName === 'string' && typeof raw.text === 'string');
  }
  if (Array.isArray(value.announced)) {
    state.announced = value.announced.filter((key): key is string => typeof key === 'string');
  }
  return state;
}

// Dernier écrit gagne ; à date égale, le plus grand identifiant, pour que tout le monde tranche pareil.
function newer(candidate: Claim, current: Claim | undefined): boolean {
  if (current === undefined) return true;
  if (candidate.at !== current.at) return candidate.at > current.at;
  return candidate.owner > current.owner;
}

function loadInstanceId(): string {
  try {
    const id = readFileSync(ID_FILE, 'utf8').trim();
    if (id !== '') return id;
  } catch {
    // Première exécution : identifiant créé ci-dessous.
  }
  const id = randomUUID();
  writeFileSync(ID_FILE, `${id}\n`);
  return id;
}

async function gitOrigin(path: string): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['-C', path, 'remote', 'get-url', 'origin']);
    return normalizeOrigin(result.stdout);
  } catch {
    return null;
  }
}

interface PeerMatch {
  id: string;
  machine: string;
  sameRepository: boolean;
}

export class PeerSync {
  readonly instanceId = loadInstanceId();
  private readonly db: CerebroDatabase;
  private readonly onChange: () => void;
  private readonly origins = new Map<string, string | null>();
  private readonly remoteErrors = new Map<string, string>();
  private readonly timer: NodeJS.Timeout;
  private state: PeerState;
  private syncing: Promise<void> | null = null;
  private slackPoster: ((text: string) => Promise<void>) | null = null;
  private markReady: () => void = () => {};
  /** Résolue une fois les origins locaux lus : avant, impossible de comparer les dépôts. */
  readonly ready = new Promise<void>((resolve) => {
    this.markReady = resolve;
  });

  constructor(db: CerebroDatabase, onChange: () => void) {
    this.db = db;
    this.onChange = onChange;
    this.state = existsSync(STATE_FILE) ? this.loadState() : stateFrom(null);
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
    this.timer.unref();
    void this.sync();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Messages d'information sur Slack (attribution automatique, conflit de nom). */
  setSlackPoster(poster: (text: string) => Promise<void>): void {
    this.slackPoster = poster;
  }

  /** Lance une synchronisation (ou attend celle en cours). */
  sync(): Promise<void> {
    if (this.syncing === null) {
      this.syncing = this.runSync().finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  /** Échange reçu d'une machine qui nous a déclarée dans son remotes.json. */
  receive(payload: SyncPayload): SyncPayload {
    if (payload.instanceId !== this.instanceId) {
      this.mutate(() => this.absorb(payload));
    }
    return this.payload();
  }

  renamed(projectId: string): void {
    this.state.renamedAt[projectId] = Date.now();
    this.save();
    void this.sync();
  }

  /** Prend la main sur Slack pour ce projet ; null si le projet n'est pas commun à plusieurs machines. */
  acquire(project: Project): ProjectSlackStatus | null {
    const status = this.projectStatus(project);
    if (!status.shared || status.conflict) return null;
    this.mutate(() => {
      this.state.claims[normalizeProjectName(project.name)] = {
        owner: this.instanceId,
        ownerName: MACHINE_NAME,
        at: Math.max(Date.now(), (this.state.claims[normalizeProjectName(project.name)]?.at ?? 0) + 1),
        auto: false,
      };
    });
    void this.sync();
    return this.projectStatus(project);
  }

  projectStatus(project: Project): ProjectSlackStatus {
    const name = normalizeProjectName(project.name);
    const matches = this.matches(name, this.origins.get(project.id));
    const shared = matches.find((match) => match.sameRepository);
    const conflicting = matches.find((match) => !match.sameRepository);
    const owner = this.ownerOf(name);
    return {
      shared: shared !== undefined,
      conflict: conflicting !== undefined,
      peerMachine: (conflicting ?? shared)?.machine ?? null,
      owner: owner === null ? null : owner === this.instanceId ? 'local' : 'remote',
      ownerMachine: owner === null ? null : owner === this.instanceId ? MACHINE_NAME : this.state.peers[owner]?.machine ?? null,
    };
  }

  /** Cette machine doit-elle traiter les commandes Slack de ce projet ? */
  owns(projectName: string): boolean {
    const owner = this.ownerOf(normalizeProjectName(projectName));
    return owner === null || owner === this.instanceId;
  }

  /** Machines où un projet du même nom pointe vers un autre dépôt (vide : pas de conflit). */
  conflictMachines(project: Project): string[] {
    return this.matches(normalizeProjectName(project.name), this.origins.get(project.id))
      .filter((match) => !match.sameRepository)
      .map((match) => match.machine);
  }

  /** En cas de conflit, une seule machine (le plus petit identifiant) répond sur Slack. */
  conflictResponder(project: Project): boolean {
    return this.matches(normalizeProjectName(project.name), this.origins.get(project.id))
      .filter((match) => !match.sameRepository)
      .every((match) => this.instanceId < match.id);
  }

  /** Un pair connaît-il un projet désigné par ce nom (exact, ou aussi par préfixe comme les commandes Slack) ? */
  knownRemotely(projectName: string, exact: boolean): boolean {
    const name = normalizeProjectName(projectName);
    return Object.entries(this.state.peers).some(([id, peer]) => id !== this.instanceId
      && peer.projects.some((project) => {
        const candidate = normalizeProjectName(project.name);
        return exact ? candidate === name : candidate.startsWith(name);
      }));
  }

  notices(): PeerNotice[] {
    return this.state.notices;
  }

  dismissNotice(id: string): boolean {
    const before = this.state.notices.length;
    this.state.notices = this.state.notices.filter((notice) => notice.id !== id);
    if (this.state.notices.length === before) return false;
    this.save();
    this.onChange();
    return true;
  }

  private async runSync(): Promise<void> {
    await this.refreshOrigins();
    for (const remote of loadRemotes()) {
      try {
        const response = await fetch(`${remote.url}/api/peer/sync`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(remote.token === undefined ? {} : { authorization: `Bearer ${remote.token}` }),
          },
          body: JSON.stringify(this.payload()),
          signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = syncPayloadFrom(await response.json());
        if (payload === null) throw new Error('réponse invalide');
        if (payload.instanceId !== this.instanceId) this.mutate(() => this.absorb(payload));
        if (this.remoteErrors.delete(remote.id)) console.log(`[peers] ${remote.name} de nouveau joignable`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Une machine éteinte échoue à chaque tour : ne journaliser que les changements.
        if (this.remoteErrors.get(remote.id) !== message) console.warn(`[peers] ${remote.name} : ${message}`);
        this.remoteErrors.set(remote.id, message);
      }
    }
    // Projets créés, renommés ou supprimés localement depuis le dernier tour.
    this.mutate(() => {});
  }

  private async refreshOrigins(): Promise<void> {
    const projects = this.db.listProjects();
    const entries = await Promise.all(projects.map(async (project) => [project.id, await gitOrigin(project.path)] as const));
    this.origins.clear();
    for (const [id, origin] of entries) this.origins.set(id, origin);
    this.markReady();
  }

  private payload(): SyncPayload {
    return {
      instanceId: this.instanceId,
      machine: MACHINE_NAME,
      projects: this.db.listProjects().map((project) => ({
        name: project.name,
        origin: this.origins.get(project.id) ?? null,
        appearedAt: this.appearedAt(project),
      })),
      claims: this.state.claims,
    };
  }

  private appearedAt(project: Project): number {
    return Math.max(project.createdAt, this.state.renamedAt[project.id] ?? 0);
  }

  private absorb(payload: SyncPayload): void {
    this.state.peers[payload.instanceId] = { machine: payload.machine, projects: payload.projects, lastSeen: Date.now() };
    for (const [name, claim] of Object.entries(payload.claims)) {
      if (newer(claim, this.state.claims[name])) this.state.claims[name] = claim;
    }
  }

  private matches(name: string, origin: string | null | undefined): PeerMatch[] {
    const result: PeerMatch[] = [];
    // Origin pas encore lu (démarrage, projet tout juste créé) : ni partage ni conflit établis.
    if (origin === undefined) return result;
    for (const [id, peer] of Object.entries(this.state.peers)) {
      if (id === this.instanceId) continue;
      const project = peer.projects.find((candidate) => normalizeProjectName(candidate.name) === name);
      if (project === undefined) continue;
      result.push({ id, machine: peer.machine, sameRepository: origin != null && project.origin === origin });
    }
    return result;
  }

  /** Propriétaire effectif : un claim ne compte que si son détenteur a toujours le même projet. */
  private ownerOf(name: string): string | null {
    const claim = this.state.claims[name];
    if (claim === undefined) return null;
    const project = this.db.listProjects().find((candidate) => normalizeProjectName(candidate.name) === name);
    if (project === undefined) return null;
    const matches = this.matches(name, this.origins.get(project.id));
    if (matches.some((match) => !match.sameRepository)) return null;
    if (claim.owner === this.instanceId) return matches.length > 0 ? claim.owner : null;
    return matches.some((match) => match.id === claim.owner) ? claim.owner : null;
  }

  // Le projet apparu le plus récemment prend la main : connexion de deux machines qui l'avaient déjà
  // (choix automatique), ou création / renommage pendant qu'elles sont connectées.
  private applyAutoClaims(): void {
    for (const project of this.db.listProjects()) {
      const name = normalizeProjectName(project.name);
      const origin = this.origins.get(project.id);
      if (origin == null) continue;
      for (const [id, peer] of Object.entries(this.state.peers)) {
        if (id === this.instanceId) continue;
        const remote = peer.projects.find((candidate) => normalizeProjectName(candidate.name) === name);
        if (remote === undefined || remote.origin !== origin) continue;
        const local = this.appearedAt(project);
        const localWins = local !== remote.appearedAt ? local > remote.appearedAt : this.instanceId > id;
        const claim: Claim = {
          owner: localWins ? this.instanceId : id,
          ownerName: localWins ? MACHINE_NAME : peer.machine,
          at: Math.max(local, remote.appearedAt),
          auto: true,
        };
        if (newer(claim, this.state.claims[name])) this.state.claims[name] = claim;
      }
    }
  }

  private mutate(change: () => void): void {
    const projects = this.db.listProjects();
    const before = new Map(projects.map((project) => [project.id, this.ownerOf(normalizeProjectName(project.name))]));
    const serialized = JSON.stringify(this.state);
    change();
    for (const [id, peer] of Object.entries(this.state.peers)) {
      if (Date.now() - peer.lastSeen > PEER_MAX_AGE_MS) delete this.state.peers[id];
    }
    this.applyAutoClaims();
    for (const project of this.db.listProjects()) {
      if (before.has(project.id)) this.announceOwnership(project, before.get(project.id) ?? null);
    }
    this.announceConflicts();
    if (JSON.stringify(this.state) === serialized) return;
    this.save();
    this.onChange();
  }

  private announceOwnership(project: Project, previous: string | null): void {
    const name = normalizeProjectName(project.name);
    const owner = this.ownerOf(name);
    if (owner === previous || owner === null) return;
    const claim = this.state.claims[name];
    if (claim === undefined) return;
    const peerMachine = this.matches(name, this.origins.get(project.id))[0]?.machine ?? 'une autre machine';
    if (owner === this.instanceId) {
      // Prise de main manuelle : l'utilisateur vient de cliquer, inutile de le lui dire.
      if (!claim.auto) return;
      const text = `« ${project.name} » existe aussi sur ${peerMachine} (même dépôt) : Cerebro a choisi ${MACHINE_NAME} pour traiter ses commandes Slack.`;
      this.addNotice(project.name, text);
      void this.slackPoster?.(`:twisted_rightwards_arrows: ${text}`).catch((error: unknown) => this.logError(error));
      return;
    }
    const ownerMachine = this.state.peers[owner]?.machine ?? claim.ownerName;
    this.addNotice(project.name, claim.auto
      ? `« ${project.name} » existe aussi sur ${ownerMachine} (même dépôt) : Cerebro lui a confié les commandes Slack, cette machine les ignore.`
      : `${ownerMachine} a pris la main sur « ${project.name} » : cette machine ignore désormais ses commandes Slack.`);
  }

  private announceConflicts(): void {
    const active = new Set<string>();
    for (const project of this.db.listProjects()) {
      for (const match of this.matches(normalizeProjectName(project.name), this.origins.get(project.id))) {
        if (match.sameRepository) continue;
        const key = `${project.id}:${match.id}`;
        active.add(key);
        if (this.state.announced.includes(key)) continue;
        const text = `« ${project.name} » existe aussi sur ${match.machine} mais pointe vers un autre dépôt git : ses commandes Slack sont bloquées sur les deux machines tant que l'un des projets n'est pas renommé.`;
        this.addNotice(project.name, text);
        if (this.instanceId < match.id) {
          void this.slackPoster?.(`:no_entry: ${text}`).catch((error: unknown) => this.logError(error));
        }
      }
    }
    this.state.announced = [...active];
  }

  private addNotice(projectName: string, text: string): void {
    this.state.notices = [{ id: randomUUID(), at: Date.now(), projectName, text }, ...this.state.notices].slice(0, MAX_NOTICES);
  }

  private loadState(): PeerState {
    try {
      return stateFrom(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
    } catch (error) {
      this.logError(error);
      return stateFrom(null);
    }
  }

  private save(): void {
    try {
      writeFileSync(STATE_FILE, `${JSON.stringify(this.state, null, 2)}\n`);
    } catch (error) {
      this.logError(error);
    }
  }

  private logError(error: unknown): void {
    console.error('[peers]', error instanceof Error ? error.message : error);
  }
}
