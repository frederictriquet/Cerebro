import { useEffect, useState } from 'react';
import { getSessionRequests, type SessionRequests as Requests } from '../api.ts';
import { errorMessage } from '../format.ts';

// Beyond this, a request is shown cut to a few lines with « Afficher tout ».
const LONG_CHARS = 280;
const LONG_LINES = 4;

function isLong(text: string): boolean {
  return text.length > LONG_CHARS || text.split('\n').length > LONG_LINES;
}

/**
 * « Demandes » tab of the mobile session screen: the messages sent to the agent, newest first, read from its
 * transcript. [SPEC: vue mobile, écran de session] Loaded when the tab is shown and again when `refreshKey` changes
 * while it is; `onReuse` (null once the session has ended) copies a request into the instruction field.
 */
export function SessionRequests({
  sessionId,
  active,
  refreshKey,
  onReuse,
}: {
  sessionId: string;
  active: boolean;
  refreshKey: string;
  onReuse: ((text: string) => void) | null;
}) {
  const [data, setData] = useState<Requests | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  // Positions counted from the oldest request, so a new request at the top keeps the others' state.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    getSessionRequests(sessionId).then(
      (value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, sessionId, refreshKey, retry]);

  const toggle = (position: number): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(position)) next.add(position);
      return next;
    });

  return (
    <>
      {error === null ? null : (
        <div className="m-reply-block">
          <p className="m-form-error" role="alert">
            Lecture des demandes impossible : {error}
          </p>
          <button type="button" className="m-button" onClick={() => setRetry((count) => count + 1)}>
            Réessayer
          </button>
        </div>
      )}
      {data === null ? (
        error === null ? (
          <p className="m-hint">Chargement…</p>
        ) : null
      ) : (
        <>
          {data.complete ? null : (
            <p className="m-hint">Historique de l’agent introuvable : seule la demande de lancement est affichée.</p>
          )}
          {data.requests.length === 0 ? (
            <p className="m-hint">Aucune demande envoyée.</p>
          ) : (
            <ol className="m-requests" aria-label="Dernières demandes, de la plus récente à la plus ancienne">
              {data.requests.map((text, index) => {
                const position = data.requests.length - index;
                const long = isLong(text);
                const open = expanded.has(position);
                return (
                  <li key={`${position}:${text.slice(0, 40)}`} className="m-request">
                    <p className={`m-request-text${long && !open ? ' clamped' : ''}`}>{text}</p>
                    <div className="m-request-actions">
                      {long ? (
                        <button
                          type="button"
                          className="m-button"
                          aria-expanded={open}
                          onClick={() => toggle(position)}
                        >
                          {open ? 'Réduire' : 'Afficher tout'}
                        </button>
                      ) : null}
                      {onReuse === null ? null : (
                        <button
                          type="button"
                          className="m-button"
                          title="Ajoute cette demande au champ de consigne, sans l’envoyer"
                          onClick={() => onReuse(text)}
                        >
                          Réutiliser
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </>
  );
}
