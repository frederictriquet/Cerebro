/*
 * Écran `#/s/<id>` de la vue mobile. Ne monte jamais Term.tsx (voir MobileShell.tsx) : l'écran est lu par
 * GET /api/sessions/:id/screen et les touches partent par POST /api/sessions/:id/input, sans toucher à la taille
 * du PTY partagé avec le desktop.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { AgentLabel } from '../AgentLabel.tsx';
import { api, apiPath } from '../api.ts';
import { DelayedActionButton } from '../DelayedActionButton.tsx';
import { displayStatus, errorMessage, isAwaiting, STATUS_LABEL } from '../format.ts';
import { useNow, usePolling } from '../polling.tsx';
import { go, href } from '../route.ts';
import { attentionTone } from '../SessionMeta.tsx';
import { StatusDot } from '../StatusDot.tsx';
import { useStore } from '../store.tsx';
import { useLatest } from '../use-latest.ts';
import { parseScreenLines, type Session } from '../../../shared/types.ts';
import { SessionCommit } from './MobileGit.tsx';

const SCREEN_LINES = 120;
const SCREEN_POLL_MS = 2000;
// Laisse à la TUI le temps de redessiner avant de relire l'écran.
const REFRESH_AFTER_SEND_MS = 250;
// Texte puis Entrée en deux envois : certaines TUI ignorent l'Entrée collée au texte.
const ENTER_DELAY_MS = 150;
// Écart au bas sous lequel l'écran reste collé en bas à chaque rafraîchissement.
const PINNED_SLACK_PX = 32;

const QUICK_KEYS: readonly { label: string; data: string; name?: string; confirm?: boolean }[] = [
  { label: 'Entrée', data: '\r' },
  { label: 'Échap', data: '\x1b' },
  { label: '↑', data: '\x1b[A', name: 'Flèche haut' },
  { label: '↓', data: '\x1b[B', name: 'Flèche bas' },
  { label: '1', data: '1' },
  { label: '2', data: '2' },
  { label: '3', data: '3' },
  { label: 'y', data: 'y' },
  { label: 'n', data: 'n' },
  { label: 'Ctrl+C', data: '\x03', confirm: true },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function fetchScreen(sessionId: string): Promise<string[]> {
  const lines = parseScreenLines(await api(apiPath`/api/sessions/${sessionId}/screen?lines=${SCREEN_LINES}`));
  if (lines === null) throw new Error('réponse inattendue du serveur');
  return lines;
}

/** Dernières lignes du terminal, collées en bas sauf si l'utilisateur a remonté. */
function ScreenText({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={ref}
      className="m-screen"
      tabIndex={0}
      aria-label="Écran de la session"
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_SLACK_PX;
      }}
    >
      {lines.join('\n')}
    </pre>
  );
}

function InstructionForm({ send }: { send: (data: string, failure: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const value = text.trimEnd();

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (sending || value.trim() === '') return;
    setSending(true);
    try {
      // Texte conservé si l'envoi échoue ; sans texte reçu, pas d'Entrée.
      if (!(await send(value, 'Envoi impossible'))) return;
      setText('');
      await delay(ENTER_DELAY_MS);
      await send('\r', 'Texte envoyé, mais Entrée non envoyée');
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="m-instruction" onSubmit={(event) => void onSubmit(event)}>
      <textarea
        className="m-textarea"
        rows={2}
        value={text}
        placeholder="Consigne pour l'agent"
        aria-label="Consigne pour l'agent"
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="m-button primary" disabled={sending || value.trim() === ''}>
        {sending ? 'Envoi…' : 'Envoyer'}
      </button>
    </form>
  );
}

function SessionDetail({ session }: { session: Session }) {
  const { projects, sendSessionInput, killSession, resumeSession, markSeen } = useStore();
  const now = useNow();
  const id = session.id;
  const exited = session.status === 'exited';
  const status = displayStatus(session, now);
  const project = projects.find((candidate) => candidate.id === session.projectId);
  const [lines, setLines] = useState<string[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const exitedRef = useLatest(exited);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetcher = useCallback(() => fetchScreen(id), [id]);
  const refresh = usePolling(fetcher, SCREEN_POLL_MS, {
    enabled: !exited,
    onData: (value) => {
      setLines(value);
      setReadError(null);
    },
    onError: (cause) => setReadError(errorMessage(cause)),
  });

  // À l'ouverture, puis à chaque nouvelle attention : acquittée page visible, sinon au retour au premier plan.
  // sessionIsWatched (store) exige aussi le focus de la fenêtre, peu fiable sur un téléphone.
  const attention = session.attention;
  useEffect(() => {
    if (!attention) return;
    const acknowledge = (): void => {
      if (document.visibilityState === 'visible') void markSeen(id);
    };
    acknowledge();
    document.addEventListener('visibilitychange', acknowledge);
    return () => document.removeEventListener('visibilitychange', acknowledge);
  }, [attention, id, markSeen]);

  const send = async (data: string, failure: string): Promise<boolean> => {
    try {
      await sendSessionInput(id, data);
    } catch (cause) {
      if (mounted.current) setError(`${failure} : ${errorMessage(cause)}`);
      return false;
    }
    // Sans effet une fois l'écran quitté.
    window.setTimeout(() => void refresh(), REFRESH_AFTER_SEND_MS);
    return true;
  };

  // Ctrl+C part 5 s après le tap : abandonné si l'écran a été quitté ou la session terminée entre-temps.
  const press = (data: string): void => {
    if (!mounted.current || exitedRef.current) return;
    setError(null);
    void send(data, 'Envoi impossible');
  };

  const act = async (failure: string, action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      if (mounted.current) setError(`${failure} : ${errorMessage(cause)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="m-session">
      <div className="m-session-meta">
        <span className="m-session-status">
          <StatusDot status={status} />
          {STATUS_LABEL[status]}
        </span>
        {project === undefined ? null : <a href={href(`#/p/${project.id}`)}>{project.name}</a>}
        <AgentLabel agent={session.agent} />
        <span className="m-session-actions">
          <SessionCommit key={id} session={session} />
          {exited ? (
            <button
              type="button"
              className="m-button primary"
              disabled={busy}
              onClick={() =>
                void act('Reprise impossible', async () => {
                  const live = await resumeSession(id);
                  go(`#/s/${live.id}`);
                })
              }
            >
              {busy ? 'Reprise…' : 'Reprendre'}
            </button>
          ) : (
            <DelayedActionButton
              className="m-button m-session-kill"
              cancelLabel="Annuler"
              disabled={busy}
              onAction={() => void act('Arrêt impossible', () => killSession(id))}
            >
              Arrêter
            </DelayedActionButton>
          )}
        </span>
      </div>
      {isAwaiting(session) && session.attentionReason ? (
        <p className={`m-card-reason ${attentionTone(session)}`}>{session.attentionReason}</p>
      ) : null}
      {error === null ? null : (
        <p className="m-form-error" role="alert">
          {error}
        </p>
      )}
      {exited ? (
        <p className="m-session-ended" role="status">
          Session terminée{session.exitCode === null ? '' : ` (code ${session.exitCode})`}. « Reprendre » la relance.
        </p>
      ) : null}
      {readError === null ? null : <p className="m-form-error">Lecture de l'écran impossible : {readError}</p>}
      <div className="m-screen-wrap">
        {lines !== null && lines.length > 0 ? (
          <ScreenText lines={lines} />
        ) : exited ? null : (
          <p className="m-hint">{lines === null ? "Chargement de l'écran…" : "Écran vide pour l'instant."}</p>
        )}
      </div>
      {exited ? null : (
        <>
          <div className="m-keys" role="group" aria-label="Touches rapides">
            {QUICK_KEYS.map((key) =>
              key.confirm === true ? (
                <DelayedActionButton
                  key={key.label}
                  className="m-button m-key"
                  cancelLabel="Annuler"
                  title={`Envoie ${key.label} après 5 s (second tap pour annuler)`}
                  onAction={() => press(key.data)}
                >
                  {key.label}
                </DelayedActionButton>
              ) : (
                <button
                  key={key.label}
                  type="button"
                  className="m-button m-key"
                  aria-label={key.name}
                  onClick={() => press(key.data)}
                >
                  {key.label}
                </button>
              ),
            )}
          </div>
          <InstructionForm send={send} />
        </>
      )}
    </div>
  );
}

/** Écran d'une session : état, commit / push, dernières lignes du terminal, touches rapides et consigne. */
export function SessionScreen({ sessionId }: { sessionId: string }) {
  const { sessions, loaded } = useStore();
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) {
    return (
      <section className="m-content">
        <p className="m-hint">{loaded ? 'Session introuvable.' : 'Chargement…'}</p>
      </section>
    );
  }
  return <SessionDetail session={session} />;
}
