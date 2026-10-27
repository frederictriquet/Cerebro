import { useEffect, useState } from 'react';

export type Route =
  | { kind: 'home' }
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; sessionId: string; panel?: 'findings' }
  | { kind: 'council'; councilId: string };

const MACHINE_ID = /^[a-z0-9-]{1,32}$/;

function hashParts(hash: string): string[] {
  return hash.replace(/^#/, '').split('/').filter((part) => part.length > 0);
}

function machineIdFromParts(parts: string[]): string | null {
  const id = parts[0] === 'm' ? parts[1] : undefined;
  if (id === undefined || id === 'local' || !MACHINE_ID.test(id)) return null;
  return id;
}

export function parseMachine(hash: string): string | null {
  return machineIdFromParts(hashParts(hash));
}

export function parseHash(hash: string): Route {
  const parts = hashParts(hash);
  const machine = machineIdFromParts(parts);
  const routeParts = machine === null ? parts : parts.slice(2);
  if (routeParts[0] === 'p' && routeParts[1] !== undefined && routeParts[1].length > 0) {
    return { kind: 'project', projectId: decodeURIComponent(routeParts[1]) };
  }
  if (routeParts[0] === 's' && routeParts[1] !== undefined && routeParts[1].length > 0) {
    return { kind: 'session', sessionId: decodeURIComponent(routeParts[1]), ...(routeParts[2] === 'findings' ? { panel: 'findings' as const } : {}) };
  }
  if (routeParts[0] === 'c' && routeParts[1] !== undefined && routeParts[1].length > 0) {
    return { kind: 'council', councilId: decodeURIComponent(routeParts[1]) };
  }
  return { kind: 'home' };
}

function assignHash(hash: string): void {
  if (window.location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = hash;
}

export function href(path: string): string {
  const hash = path.startsWith('#') ? path : `#${path}`;
  const machine = parseMachine(window.location.hash);
  if (machine === null || hash.startsWith('#/m/')) return hash;
  const rest = hash.slice(1);
  if (rest === '' || rest === '/') return `#/m/${machine}/`;
  return `#/m/${machine}${rest.startsWith('/') ? rest : `/${rest}`}`;
}

export function go(path: string): void {
  assignHash(href(path));
}

export function goMachine(id: string | null): void {
  assignHash(id === null || id === 'local' ? '#/' : `#/m/${id}/`);
}

// replaceState ne déclenche pas hashchange : cet événement resynchronise les hooks du routeur
// sans réveiller les écouteurs hashchange, réservés aux navigations.
const ROUTE_REPLACED = 'cerebro:route-replaced';

export function replaceRoute(path: string): void {
  const hash = href(path);
  if (window.location.hash === hash) return;
  window.history.replaceState(window.history.state, '', hash);
  window.dispatchEvent(new Event(ROUTE_REPLACED));
}

function useHashState<T>(read: (hash: string) => T): T {
  const [value, setValue] = useState<T>(() => read(window.location.hash));
  useEffect(() => {
    const sync = (): void => {
      setValue(read(window.location.hash));
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener(ROUTE_REPLACED, sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener(ROUTE_REPLACED, sync);
    };
  }, [read]);
  return value;
}

export function useRoute(): Route {
  return useHashState(parseHash);
}

export function useMachine(): string | null {
  return useHashState(parseMachine);
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
