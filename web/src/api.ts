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
