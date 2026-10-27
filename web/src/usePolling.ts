import { useCallback, useEffect, useRef } from 'react';

export interface PollingOptions<T> {
  onData: (value: T) => void;
  onError?: (cause: unknown) => void;
  // Onglet caché : aucune requête ; une requête part dès qu'il redevient visible.
  pauseHidden?: boolean;
  // Une réponse plus ancienne que la dernière appliquée (minuteur ou refresh) est ignorée.
  latestOnly?: boolean;
}

// Interroge fetcher toutes les `ms` millisecondes (null : pas de minuteur), une requête à la fois,
// et passe chaque résultat à onData. Retourne refresh, qui lance une requête immédiate et ne rejette jamais.
// Changer fetcher (nouvelle clé) redémarre le cycle et écarte les réponses de l'ancien.
export function usePolling<T>(
  fetcher: () => Promise<T>,
  ms: number | null,
  { pauseHidden = true, latestOnly = true, ...handlers }: PollingOptions<T>,
): () => Promise<void> {
  const callbacks = useRef(handlers);
  callbacks.current = handlers;
  const issued = useRef(0);
  const applied = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++issued.current;
    const stale = (): boolean => fetcherRef.current !== fetcher || (latestOnly && sequence < applied.current);
    try {
      const value = await fetcher();
      if (stale()) return;
      applied.current = sequence;
      callbacks.current.onData(value);
    } catch (cause) {
      if (stale()) return;
      applied.current = sequence;
      callbacks.current.onError?.(cause);
    }
  }, [fetcher, latestOnly]);

  useEffect(() => {
    if (ms === null) return;
    let disposed = false;
    let loading = false;
    let timer: number | undefined;
    const tick = async (): Promise<void> => {
      timer = undefined;
      if (disposed || loading || (pauseHidden && document.hidden)) return;
      loading = true;
      try {
        await refresh();
      } finally {
        loading = false;
        if (!disposed) timer = window.setTimeout(() => void tick(), ms);
      }
    };
    const onVisibility = (): void => {
      if (document.hidden || loading || disposed) return;
      if (timer !== undefined) window.clearTimeout(timer);
      void tick();
    };
    if (pauseHidden) document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh, ms, pauseHidden]);

  return refresh;
}
