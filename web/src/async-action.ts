import { useCallback, useState } from 'react';
import { useLatest } from './use-latest.ts';
import { errorMessage } from './format.ts';

export interface AsyncActionOptions {
  /** Message affiché quand l'échec n'est pas une Error (voir errorMessage). */
  fallback?: string;
  /** Reçoit l'erreur à la place de l'état `error` du hook : null au lancement, le message en cas d'échec. */
  onError?: (message: string | null) => void;
}

export interface AsyncAction<A extends unknown[]> {
  /** Lance l'action ; résout à vrai si elle a abouti. Ne rejette jamais. Aucune garde : un appel concurrent s'exécute aussi. */
  run: (...args: A) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  setError: (message: string | null) => void;
}

/**
 * Exécute `fn` en exposant son activité et son dernier échec. Les options sont relues à chaque
 * appel : `fn` et les rappels n'ont pas besoin d'être mémoïsés, et `run` reste stable.
 */
export function useAsyncAction<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown>,
  options: AsyncActionOptions = {},
): AsyncAction<A> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useLatest({ fn, options });

  const run = useCallback(
    async (...args: A): Promise<boolean> => {
      const { fn, options } = latest.current;
      const report = options.onError ?? setError;
      setBusy(true);
      report(null);
      try {
        await fn(...args);
        return true;
      } catch (cause) {
        report(errorMessage(cause, options.fallback));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [latest],
  );

  return { run, busy, error, setError };
}
