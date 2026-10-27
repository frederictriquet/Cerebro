import {
  parseAgentUpdate,
  parseAgentUpdates,
  parseAgentUsages,
  parseGeneralSlackStatus,
  parseMachinesInfo,
  parsePeerNotices,
  parseProjectSlackStatus,
  parseSessionTokenUsages,
  parseSlackStatus,
  type AgentUpdate,
  type AgentUsage,
  type GeneralSlackStatus,
  type MachinesInfo,
  type PeerNotice,
  type ProjectSlackStatus,
  type SessionTokenUsage,
  type SlackSettings,
  type SlackStatus,
} from '../../shared/machine.ts';
import { object, parser, string, type Parser } from '../../shared/parse.ts';
import {
  parseCouncilRun,
  parseCouncilRunList,
  parseCouncilSettings,
  parsePersona,
  parsePersonaList,
  type Agent,
  type CouncilImage,
  type CouncilRun,
  type CouncilSettings,
  type Participant,
  type Persona,
  type PersonaInput,
} from '../../shared/types.ts';

const unauthorizedListeners = new Set<() => void>();
let unauthorized = false;
let base = '';

export function setApiBase(machineId: string | null): void {
  base = machineId === null || machineId === 'local' ? '' : `/m/${machineId}`;
}

export function apiBase(): string {
  return base;
}

export function subscribeUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  if (unauthorized) listener();
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function notifyUnauthorized(): void {
  unauthorized = true;
  for (const listener of unauthorizedListeners) listener();
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function bodyError(parsed: unknown): string | null {
  if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
    const err = (parsed as { error: unknown }).error;
    if (typeof err === 'string' && err.length > 0) return err;
  }
  return null;
}

async function request(url: string, local: boolean, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let parsed: unknown;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    // Un 401 relayé ne doit pas ouvrir l'écran « Token requis » de la machine locale.
    if (res.status === 401 && local) notifyUnauthorized();
    throw new ApiError(res.status, bodyError(parsed) ?? res.statusText);
  }
  return parsed;
}

function validated<T>(value: unknown, parse: Parser<T>, path: string): T {
  const result = parse(value);
  if (result === null) throw new Error(`Réponse du serveur invalide (${path})`);
  return result;
}

// Réponse brute, que l'appelant ignore ou valide avec un parseur partagé (shared/) : jamais de cast.
export async function api(path: string, init?: RequestInit): Promise<unknown> {
  const local = base === '';
  return request(`${base}${path}`, local, init);
}

/** Construit un chemin d'API en encodant chaque valeur interpolée : apiPath`/api/sessions/${id}/kill`. */
export function apiPath(strings: TemplateStringsArray, ...params: (string | number)[]): string {
  return strings.reduce((path, part, i) => `${path}${encodeURIComponent(params[i - 1])}${part}`);
}

/** Réponse validée par un parseur partagé : une réponse hors contrat (autre machine, autre version) est une erreur. */
export async function apiParsed<T>(path: string, parse: Parser<T>, init?: RequestInit): Promise<T> {
  return validated(await api(path, init), parse, path);
}

export async function getMachines(): Promise<MachinesInfo> {
  return validated(await request('/api/machines', true), parseMachinesInfo, '/api/machines');
}

export function wsUrl(path: string, machineBase = base): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${machineBase}${path}`;
}

export function clipboardImage(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  for (const file of Array.from(data.files)) {
    if (file.type.startsWith('image/')) return file;
  }
  return null;
}

// Repli quand l'événement paste n'expose pas l'image (selon navigateur et source de la copie).
export async function readClipboardImage(): Promise<Blob | null> {
  if (!navigator.clipboard?.read) return null;
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) return item.getType(type);
  }
  return null;
}

// Stocke l'image côté serveur et renvoie son chemin absolu, que l'agent sait lire.
export async function uploadImage(sessionId: string, image: Blob): Promise<string> {
  return postImage(apiPath`/api/sessions/${sessionId}/attachments`, image);
}

// Variante pour le prompt d'une nouvelle session : la session n'existe pas encore.
export async function uploadProjectImage(projectId: string, image: Blob): Promise<string> {
  return postImage(apiPath`/api/projects/${projectId}/attachments`, image);
}

// Image collée dans un council : dossier du projet, ou dossier commun des councils hors projet.
export async function uploadCouncilImage(projectId: string | null, image: Blob): Promise<string> {
  return projectId === null ? postImage('/api/council/attachments', image) : uploadProjectImage(projectId, image);
}

export function getSlackStatus(): Promise<SlackStatus> {
  return apiParsed('/api/slack', parseSlackStatus);
}

export function updateSlackSettings(patch: Partial<SlackSettings>): Promise<SlackStatus> {
  return apiParsed('/api/slack', parseSlackStatus, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function getGeneralSlack(): Promise<GeneralSlackStatus> {
  return apiParsed('/api/slack/general', parseGeneralSlackStatus);
}

export function acquireGeneralSlack(): Promise<GeneralSlackStatus> {
  return apiParsed('/api/slack/general/acquire', parseGeneralSlackStatus, { method: 'POST' });
}

export function getProjectSlack(projectId: string): Promise<ProjectSlackStatus> {
  return apiParsed(apiPath`/api/projects/${projectId}/slack`, parseProjectSlackStatus);
}

export function acquireProjectSlack(projectId: string): Promise<ProjectSlackStatus> {
  return apiParsed(apiPath`/api/projects/${projectId}/slack/acquire`, parseProjectSlackStatus, { method: 'POST' });
}

export function getPeerNotices(): Promise<PeerNotice[]> {
  return apiParsed('/api/peer/notices', parsePeerNotices);
}

export async function dismissPeerNotice(id: string): Promise<void> {
  await api(`/api/peer/notices/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
}

export function getUsage(): Promise<AgentUsage[]> {
  return apiParsed('/api/usage', parseAgentUsages);
}

export function getSessionTokenUsage(): Promise<SessionTokenUsage[]> {
  return apiParsed('/api/usage/tokens', parseSessionTokenUsages);
}

export function getUpdates(): Promise<AgentUpdate[]> {
  return apiParsed('/api/updates', parseAgentUpdates);
}

export function checkUpdates(): Promise<AgentUpdate[]> {
  return apiParsed('/api/updates/check', parseAgentUpdates, { method: 'POST' });
}

export function startUpdate(agent: Agent): Promise<AgentUpdate> {
  return apiParsed(apiPath`/api/updates/${agent}`, parseAgentUpdate, { method: 'POST' });
}

export function setAutoUpdate(agent: Agent, auto: boolean): Promise<AgentUpdate> {
  return apiParsed(apiPath`/api/updates/${agent}`, parseAgentUpdate, { method: 'PATCH', body: JSON.stringify({ auto }) });
}

const parseAttachment = parser(object<{ path: string }>({ path: string }));

async function postImage(url: string, image: Blob): Promise<string> {
  const { path } = await apiParsed(url, parseAttachment, {
    method: 'POST',
    headers: { 'Content-Type': image.type },
    body: image,
  });
  return path;
}

export async function listPersonas(): Promise<Persona[]> {
  return parsePersonaList(await api('/api/personas'));
}

export function createPersona(input: PersonaInput): Promise<Persona> {
  return apiParsed('/api/personas', parsePersona, { method: 'POST', body: JSON.stringify(input) });
}

export function updatePersona(id: string, patch: Partial<PersonaInput>): Promise<Persona> {
  return apiParsed(`/api/personas/${encodeURIComponent(id)}`, parsePersona, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function deletePersona(id: string): Promise<void> {
  await api(`/api/personas/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function getCouncilSettings(): Promise<CouncilSettings> {
  return apiParsed('/api/council/settings', parseCouncilSettings);
}

// Réglages appliqués au lancement : surcharge du projet, sinon réglages globaux (projectId null).
export function getEffectiveCouncilSettings(projectId: string | null): Promise<CouncilSettings> {
  const query = projectId === null ? '' : `?projectId=${encodeURIComponent(projectId)}`;
  return apiParsed(`/api/council/settings/effective${query}`, parseCouncilSettings);
}

export function putCouncilSettings(settings: CouncilSettings): Promise<CouncilSettings> {
  return apiParsed('/api/council/settings', parseCouncilSettings, { method: 'PUT', body: JSON.stringify(settings) });
}

export interface CouncilStartInput {
  // Rend le lancement idempotent et devient l'identifiant du run.
  requestId: string;
  projectId: string | null;
  question: string;
  context?: string;
  readProject?: boolean;
  // Absent : participants par défaut des réglages effectifs.
  participants?: Participant[];
  // Images jointes, désignées par « [Image #n] » dans la question ou le contexte.
  images?: CouncilImage[];
}

export function startCouncil(input: CouncilStartInput): Promise<CouncilRun> {
  return apiParsed('/api/councils', parseCouncilRun, { method: 'POST', body: JSON.stringify(input) });
}

export function getCouncil(id: string): Promise<CouncilRun> {
  return apiParsed(`/api/councils/${encodeURIComponent(id)}`, parseCouncilRun);
}

// projectId absent : tous les councils ; null : ceux lancés hors projet.
export async function listCouncils(projectId?: string | null): Promise<CouncilRun[]> {
  const query = projectId === undefined ? '' : `?projectId=${projectId === null ? 'none' : encodeURIComponent(projectId)}`;
  return parseCouncilRunList(await api(`/api/councils${query}`));
}

export function cancelCouncil(id: string): Promise<CouncilRun> {
  return apiParsed(`/api/councils/${encodeURIComponent(id)}/cancel`, parseCouncilRun, { method: 'POST' });
}

export async function deleteCouncil(id: string): Promise<void> {
  await api(`/api/councils/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function councilImageUrl(id: string, n: number): string {
  return base + apiPath`/api/councils/${id}/images/${n}`;
}

export function councilExportUrl(id: string): string {
  return base + apiPath`/api/councils/${id}/export`;
}
