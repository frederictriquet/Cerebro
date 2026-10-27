import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLatest } from './use-latest.ts';

export interface PollingOptions<T> {
  /** Réponse retenue (ni périmée, ni obsolète). */
  onData?: (value: T) => void;
  /** Échec retenu. Sans ce handler, les ticks ignorent l'erreur et `refresh()` la rejette. */
  onError?: (cause: unknown) => void;
  /** Faux : aucun tick programmé ; `refresh()` reste utilisable. */
  enabled?: boolean;
  /** Premier chargement dès l'activation plutôt qu'après un intervalle. */
  immediate?: boolean;
  /** Suspend les ticks quand l'onglet est masqué ; reprend par un chargement immédiat au retour. */
  pauseHidden?: boolean;
  /** Ignore une réponse arrivée après celle d'une requête plus récente. */
  latestOnly?: boolean;
}

/**
 * Interroge `fetcher` toutes les `intervalMs` millisecondes, l'intervalle partant de la fin de la
 * requête précédente : deux ticks ne se chevauchent jamais. Un nouveau `fetcher` (à mémoïser avec
 * useCallback) relance le cycle et rend périmées les réponses encore attendues de l'ancien.
 * Renvoie `refresh()`, un chargement immédiat soumis aux mêmes règles ; sans effet une fois
 * le composant démonté ou le `fetcher` remplacé.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  options: PollingOptions<T> = {},
): () => Promise<void> {
  const { enabled = true, immediate = true, pauseHidden = true, latestOnly = true } = options;
  const handlers = useLatest(options);
  const requested = useRef(0);
  const applied = useRef(0);
  // Génération du `request` monté. Toute autre (fetcher remplacé, composant démonté) est périmée :
  // elle n'émet plus rien et ignore les réponses encore attendues.
  const live = useRef<object | null>(null);

  const request = useMemo(() => {
    const generation = {};
    const run = async (): Promise<void> => {
      if (live.current !== generation) return;
      const id = ++requested.current;
      const stale = (): boolean => live.current !== generation || (latestOnly && id < applied.current);
      let value: T;
      try {
        value = await fetcher();
      } catch (cause) {
        if (stale()) return;
        applied.current = id;
        const { onError } = handlers.current;
        if (!onError) throw cause;
        onError(cause);
        return;
      }
      if (stale()) return;
      applied.current = id;
      handlers.current.onData?.(value);
    };
    return { generation, run };
  }, [fetcher, latestOnly, handlers]);

  useEffect(() => {
    live.current = request.generation;
    return () => {
      live.current = null;
    };
  }, [request]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let inFlight = false;
    let timer: number | undefined;
    const tick = async (): Promise<void> => {
      timer = undefined;
      // En pause : le retour au premier plan relance le cycle.
      if (pauseHidden && document.hidden) return;
      inFlight = true;
      try {
        await request.run();
      } catch {
        /* sans onError, un tick en échec attend simplement le suivant */
      } finally {
        inFlight = false;
      }
      if (!disposed) timer = window.setTimeout(() => void tick(), intervalMs);
    };
    const onVisibility = (): void => {
      if (!document.hidden && timer === undefined && !inFlight) void tick();
    };
    if (immediate) void tick();
    else timer = window.setTimeout(() => void tick(), intervalMs);
    if (pauseHidden) document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      if (pauseHidden) document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [request, intervalMs, enabled, immediate, pauseHidden]);

  return request.run;
}

const NOW_REFRESH_MS = 30_000;
const NowContext = createContext<number | null>(null);

// Horloge commune des durées relatives (« il y a 5 min ») : un seul intervalle pour toute l'interface.
export function NowProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = (): void => setNow(Date.now());
    const timer = window.setInterval(tick, NOW_REFRESH_MS);
    const onVisibility = (): void => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}

export function useNow(): number {
  return useContext(NowContext) ?? Date.now();
}
