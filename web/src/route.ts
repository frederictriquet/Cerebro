import { useEffect, useState } from 'react';

export type Route =
  | { kind: 'home' }
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; sessionId: string };

export function parseHash(hash: string): Route {
  const trimmed = hash.replace(/^#/, '');
  const parts = trimmed.split('/').filter((p) => p.length > 0);
  if (parts[0] === 'p' && parts[1] !== undefined && parts[1].length > 0) {
    return { kind: 'project', projectId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 's' && parts[1] !== undefined && parts[1].length > 0) {
    return { kind: 'session', sessionId: decodeURIComponent(parts[1]) };
  }
  return { kind: 'home' };
}

export function go(path: string): void {
  const hash = path.startsWith('#') ? path : `#${path}`;
  if (window.location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHash = (): void => {
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
