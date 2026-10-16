import type { Agent } from './types.ts';

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

function errorMessage(parsed: unknown): string | null {
  if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
    const err = (parsed as { error: unknown }).error;
    if (typeof err === 'string' && err.length > 0) return err;
  }
  return null;
}

async function request<T>(url: string, local: boolean, init?: RequestInit): Promise<T> {
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
    throw new ApiError(res.status, errorMessage(parsed) ?? res.statusText);
  }
  return parsed as T;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const local = base === '';
  return request<T>(`${base}${path}`, local, init);
}

export interface MachinesInfo {
  local: { name: string };
  remotes: { id: string; name: string }[];
}

export function getMachines(): Promise<MachinesInfo> {
  return request<MachinesInfo>('/api/machines', true);
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
  return postImage(`/api/sessions/${sessionId}/attachments`, image);
}

// Variante pour le prompt d'une nouvelle session : la session n'existe pas encore.
export async function uploadProjectImage(projectId: string, image: Blob): Promise<string> {
  return postImage(`/api/projects/${projectId}/attachments`, image);
}

export interface SlackSettings {
  waiting: boolean;
  idle: boolean;
  agentMessages: boolean;
  delaySeconds: number;
}

export type SlackStatus = { enabled: boolean } & SlackSettings;

export function getSlackStatus(): Promise<SlackStatus> {
  return api<SlackStatus>('/api/slack');
}

export function updateSlackSettings(patch: Partial<SlackSettings>): Promise<SlackStatus> {
  return api<SlackStatus>('/api/slack', { method: 'PATCH', body: JSON.stringify(patch) });
}

/** Prise de main Slack d'un projet présent sur plusieurs machines. */
export interface ProjectSlackStatus {
  shared: boolean;
  conflict: boolean;
  peerMachine: string | null;
  owner: 'local' | 'remote' | null;
  ownerMachine: string | null;
}

export interface PeerNotice {
  id: string;
  at: number;
  projectName: string;
  text: string;
}

export function getProjectSlack(projectId: string): Promise<ProjectSlackStatus> {
  return api<ProjectSlackStatus>(`/api/projects/${projectId}/slack`);
}

export function acquireProjectSlack(projectId: string): Promise<ProjectSlackStatus> {
  return api<ProjectSlackStatus>(`/api/projects/${projectId}/slack/acquire`, { method: 'POST' });
}

export function getPeerNotices(): Promise<PeerNotice[]> {
  return api<PeerNotice[]>('/api/peer/notices');
}

export function dismissPeerNotice(id: string): Promise<void> {
  return api<void>(`/api/peer/notices/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
}

export interface UsageWindow {
  label: string;
  percent: number;
  minutes: number | null;
  resetsAt: string | null;
}

export interface AgentAuth {
  loginExpiresAt: string | null;
  accessExpiresAt: string | null;
  renewedAt: string | null;
  error: string | null;
}

export interface AgentUsage {
  agent: Agent;
  windows: UsageWindow[];
  auth: AgentAuth | null;
  updatedAt: string | null;
  error: string | null;
}

export function getUsage(): Promise<AgentUsage[]> {
  return api<AgentUsage[]>('/api/usage');
}

export interface AgentUpdate {
  agent: Agent;
  installed: string | null;
  latest: string | null;
  available: boolean;
  auto: boolean;
  updating: boolean;
  checkedAt: string | null;
  lastRun: { at: string; ok: boolean; output: string } | null;
  error: string | null;
}

export function getUpdates(): Promise<AgentUpdate[]> {
  return api<AgentUpdate[]>('/api/updates');
}

export function checkUpdates(): Promise<AgentUpdate[]> {
  return api<AgentUpdate[]>('/api/updates/check', { method: 'POST' });
}

export function startUpdate(agent: Agent): Promise<AgentUpdate> {
  return api<AgentUpdate>(`/api/updates/${agent}`, { method: 'POST' });
}

export function setAutoUpdate(agent: Agent, auto: boolean): Promise<AgentUpdate> {
  return api<AgentUpdate>(`/api/updates/${agent}`, { method: 'PATCH', body: JSON.stringify({ auto }) });
}

async function postImage(url: string, image: Blob): Promise<string> {
  const { path } = await api<{ path: string }>(url, {
    method: 'POST',
    headers: { 'Content-Type': image.type },
    body: image,
  });
  return path;
}
