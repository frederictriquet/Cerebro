import { useCallback, useEffect, useState } from 'react';
import { ApiError, getPeerName } from './api.ts';
import { errorMessage } from './format.ts';
import { usePolling } from './polling.tsx';
import type { Session } from '../../shared/types.ts';

const REFRESH_MS = 10_000;
const COPIED_MS = 1_500;

// Nom sous lequel les autres sessions Claude joignent celle-ci (« envoie un message à <nom> ») : un clic le copie.
// Le nom n'existe qu'une fois Claude démarré et change si la session est renommée : il est relu régulièrement,
// et le bouton n'apparaît que lorsqu'un processus vivant porte la session.
export function SessionPeerName({ session, onError }: { session: Session; onError: (message: string) => void }) {
  const [name, setName] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const claude = session.agent === 'claude' && session.status !== 'exited';
  const sessionId = session.id;

  const fetcher = useCallback(() => getPeerName(sessionId), [sessionId]);
  usePolling(fetcher, REFRESH_MS, {
    enabled: claude,
    onData: setName,
    onError: (cause) => {
      // 404 : pas (encore) de processus qui porte la session, ce n'est pas une panne.
      if (cause instanceof ApiError && cause.status === 404) setName(null);
      else onError(errorMessage(cause));
    },
  });

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!claude || name === null) return null;
  return (
    <button
      type="button"
      className="btn peer-name"
      title={`${name} : nom à donner à une autre session Claude pour lui faire écrire à celle-ci. Cliquer pour le copier`}
      onClick={() => {
        if (!navigator.clipboard) {
          onError('Copie impossible : le presse-papier exige une page en HTTPS ou localhost');
          return;
        }
        navigator.clipboard.writeText(name).then(
          () => setCopied(true),
          (cause: unknown) => onError(errorMessage(cause)),
        );
      }}
    >
      {copied ? 'Copié' : name}
    </button>
  );
}
