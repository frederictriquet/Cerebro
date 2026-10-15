import type { Agent } from './types.ts';

const unauthorizedListeners = new Set<() => void>();
let unauthorized = false;

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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(path, { ...init, headers });
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
    if (res.status === 401) notifyUnauthorized();
    throw new ApiError(res.status, errorMessage(parsed) ?? res.statusText);
  }
  return parsed as T;
}

export function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
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

export interface UsageWindow {
  label: string;
  percent: number;
  minutes: number | null;
  resetsAt: string | null;
}

export interface AgentUsage {
  agent: Agent;
  windows: UsageWindow[];
  updatedAt: string | null;
  error: string | null;
}

export function getUsage(): Promise<AgentUsage[]> {
  return api<AgentUsage[]>('/api/usage');
}

async function postImage(url: string, image: Blob): Promise<string> {
  const { path } = await api<{ path: string }>(url, {
    method: 'POST',
    headers: { 'Content-Type': image.type },
    body: image,
  });
  return path;
}
