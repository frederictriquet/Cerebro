/*
 * Écran `#/s/<id>` de la vue mobile. Ne monte jamais Term.tsx (voir MobileShell.tsx) : l'écran est lu par
 * GET /api/sessions/:id/screen et les touches partent par POST /api/sessions/:id/input. Le PTY prend la taille
 * du téléphone par POST /api/sessions/:id/resize à l'ouverture, au retour au premier plan, à chaque envoi et
 * quand le cadre change de largeur ; le desktop la reprend dès qu'on y clique ou tape.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { AgentLabel } from '../AgentLabel.tsx';
import { AttentionDetail, EpicStepValidation } from '../AttentionDetail.tsx';
import { api, apiPath, uploadImage } from '../api.ts';
import { AttachmentStrip, PhotoButtons, useAttachedField } from '../attachments.tsx';
import { DelayedActionButton } from '../DelayedActionButton.tsx';
import { displayStatus, errorMessage, isAwaiting, STATUS_LABEL } from '../format.ts';
import { useNow, usePolling } from '../polling.tsx';
import { go, href } from '../route.ts';
import { attentionTone } from '../SessionMeta.tsx';
import { StatusDot } from '../StatusDot.tsx';
import { useStore } from '../store.tsx';
import { Markdown } from '../Markdown.tsx';
import { useLatest } from '../use-latest.ts';
import { SessionFilesBrowser } from '../SessionFiles.tsx';
import { appendToMessage } from '../session-files.ts';
import { parseScreenLines, type Session } from '../../../shared/types.ts';
import { quickKeyGroups, type QuickKey } from './keys.ts';
import { SessionCommit } from './MobileGit.tsx';
import { SessionRequests } from './SessionRequests.tsx';
import { SwipeTabs, type SwipeTab } from './SwipeTabs.tsx';

const SCREEN_LINES = 120;
const SCREEN_POLL_MS = 2000;
// Laisse à la TUI le temps de redessiner avant de relire l'écran.
const REFRESH_AFTER_SEND_MS = 250;
// Texte puis Entrée en deux envois : certaines TUI ignorent l'Entrée collée au texte.
const ENTER_DELAY_MS = 150;
// Écart au bas sous lequel l'écran reste collé en bas à chaque rafraîchissement.
const PINNED_SLACK_PX = 32;
// Texte du gabarit invisible qui mesure la largeur d'une colonne et la hauteur d'une rangée.
const PROBE_TEXT = '0123456789';
// En deçà, le cadre n'est pas encore mis en page : aucune taille n'est imposée.
const MIN_COLS = 20;
const MIN_ROWS = 5;

type SessionTab = 'reply' | 'terminal' | 'requests' | 'files';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Colonnes et rangées que le cadre de l'écran affiche sans recouper les lignes, d'après son gabarit. */
function measureScreen(probe: HTMLElement): { cols: number; rows: number } | null {
  const glyphs = probe.firstElementChild?.getBoundingClientRect();
  if (glyphs === undefined || glyphs.width <= 0 || glyphs.height <= 0) return null;
  const style = getComputedStyle(probe);
  const width = probe.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = probe.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const cols = Math.floor(width / (glyphs.width / PROBE_TEXT.length));
  const rows = Math.floor(height / glyphs.height);
  return cols >= MIN_COLS && rows >= MIN_ROWS ? { cols, rows } : null;
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

/** Instruction for the agent, with images from the gallery or the camera. [SPEC: vue mobile, images jointes] */
function InstructionForm({
  sessionId,
  send,
  text,
  setText,
  fieldRef,
  onSent,
}: {
  sessionId: string;
  send: (data: string, failure: string) => Promise<boolean>;
  /** Owned by the screen, so the « Demandes » tab can reuse a request in it. */
  text: string;
  setText: (change: (text: string) => string) => void;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  onSent: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  const value = text.trimEnd();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // "[Image #N]" in the text; the file's path on the server replaces it when sending.
  const { images, attach, fieldProps, stripProps } = useAttachedField({
    upload: (image) => uploadImage(sessionId, image),
    text,
    setText: (change) => {
      setText(change);
      setNote(null);
    },
    onError: (message) => {
      if (mounted.current) setNote(message);
    },
    disabled: sending,
  });

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (sending || images.pending || value.trim() === '') return;
    setSending(true);
    try {
      // Text and images are kept if sending fails; no Enter without the text.
      if (!(await send(images.expand(value), 'Envoi impossible'))) return;
      setText(() => '');
      images.reset();
      await delay(ENTER_DELAY_MS);
      await send('\r', 'Texte envoyé, mais Entrée non envoyée');
      onSent();
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  return (
    <form className="m-instruction-form" onSubmit={(event) => void onSubmit(event)}>
      <div className="m-instruction">
        <textarea
          ref={fieldRef}
          className="m-textarea"
          rows={2}
          value={text}
          placeholder="Consigne pour l'agent"
          aria-label="Consigne pour l'agent"
          {...fieldProps}
        />
        <button type="submit" className="m-button primary" disabled={sending || images.pending || value.trim() === ''}>
          {sending ? 'Envoi…' : images.pending ? 'Images…' : 'Envoyer'}
        </button>
      </div>
      <div className="m-photo-row">
        <PhotoButtons disabled={sending} onPick={(files) => files.forEach((file) => attach(file, null))} />
      </div>
      <AttachmentStrip {...stripProps} />
      {note === null ? null : (
        <p className="m-form-error" role="alert">
          {note}
        </p>
      )}
    </form>
  );
}

function SessionDetail({ session }: { session: Session }) {
  const { projects, sendSessionInput, resizeSession, killSession, resumeSession, markSeen } = useStore();
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
  const probeRef = useRef<HTMLPreElement>(null);
  // Le clavier virtuel réduit le cadre : on garde le plus grand nombre de rangées vu, pour que la TUI ne
  // rapetisse pas à chaque saisie.
  const maxRows = useRef(0);
  const claimed = useRef('');
  const detail = session.attentionDetail;
  // A question or a permission is answered in « Réponse » only while the agent waits for it.
  const pending = session.status === 'waiting' && (detail?.kind === 'questions' || detail?.kind === 'permission');
  const hasReply = pending || detail?.kind === 'turn';
  // [SPEC: vue mobile, écran de session] Opens on « Réponse » when there is something to read or answer there.
  const [tab, setTab] = useState<SessionTab>(() => (exited || hasReply ? 'reply' : 'terminal'));
  const [draft, setDraft] = useState('');
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // Each instruction sent from here reloads « Demandes »; a status change covers the other sources.
  const [sentCount, setSentCount] = useState(0);

  const focusDraftEnd = (): void => {
    window.setTimeout(() => {
      const field = fieldRef.current;
      if (field === null) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }, 0);
  };
  // [SPEC: vue mobile, écran de session] Added after a draft in progress, never in place of it.
  const reuse = (request: string): void => {
    setDraft((current) => (current.trim() === '' ? request : `${current.trimEnd()}\n\n${request}`));
    focusDraftEnd();
  };
  // [SPEC: vue mobile, écran de session] « Fichiers »: the quote follows the draft after one space, as on desktop.
  const cite = (quote: string): void => {
    setDraft((current) => appendToMessage(current, quote));
    focusDraftEnd();
  };

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

  // Ce téléphone impose sa taille au PTY ; sans `force`, seulement si elle diffère de la dernière imposée.
  const claimSize = useCallback(
    async (force: boolean): Promise<boolean> => {
      const probe = probeRef.current;
      if (probe === null || exitedRef.current) return false;
      const size = measureScreen(probe);
      if (size === null) return false;
      maxRows.current = Math.max(maxRows.current, size.rows);
      const key = `${size.cols}x${maxRows.current}`;
      if (!force && key === claimed.current) return false;
      claimed.current = key;
      try {
        await resizeSession(id, size.cols, maxRows.current);
      } catch (cause) {
        claimed.current = '';
        if (mounted.current) setError(`Taille du terminal non transmise : ${errorMessage(cause)}`);
        return false;
      }
      return true;
    },
    [exitedRef, id, resizeSession],
  );

  useEffect(() => {
    const probe = probeRef.current;
    if (exited || probe === null) return;
    claimed.current = '';
    const claim = (force: boolean): void => {
      void claimSize(force).then((done) => {
        if (done) window.setTimeout(() => void refresh(), REFRESH_AFTER_SEND_MS);
      });
    };
    // Premier appel à l'ouverture, puis à chaque changement de largeur (rotation).
    const observer = new ResizeObserver(() => claim(false));
    observer.observe(probe);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') claim(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [claimSize, exited, refresh]);

  const send = async (data: string, failure: string): Promise<boolean> => {
    void claimSize(true);
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

  const keyButton = (key: QuickKey, tone: 'now' | 'other') =>
    key.confirm === true ? (
      <DelayedActionButton
        key={key.label}
        className={`m-button m-key ${tone}`}
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
        className={`m-button m-key ${tone}`}
        aria-label={key.name}
        onClick={() => press(key.data)}
      >
        {key.label}
      </button>
    );
  const keys = quickKeyGroups(session);

  const terminal = (
    <>
      <div className="m-screen-wrap">
        {exited ? null : (
          <pre ref={probeRef} className="m-screen m-screen-probe" aria-hidden="true">
            <span>{PROBE_TEXT}</span>
          </pre>
        )}
        {lines !== null && lines.length > 0 ? (
          <ScreenText lines={lines} />
        ) : exited ? null : (
          <p className="m-hint">{lines === null ? "Chargement de l'écran…" : "Écran vide pour l'instant."}</p>
        )}
      </div>
      {exited ? null : keys.now.length === 0 ? (
        <div className="m-keys" role="group" aria-label="Touches rapides">
          {keys.other.map((key) => keyButton(key, 'other'))}
        </div>
      ) : (
        <>
          <div className="m-keys now" role="group" aria-label="Touches utiles maintenant">
            {keys.now.map((key) => keyButton(key, 'now'))}
          </div>
          <div className="m-keys other" role="group" aria-label="Autres touches">
            {keys.other.map((key) => keyButton(key, 'other'))}
          </div>
        </>
      )}
    </>
  );

  const reply = (
    <>
      {pending ? (
        <section
          className="m-reply-block"
          aria-label={detail?.kind === 'questions' ? "Question de l'agent" : undefined}
        >
          {detail?.kind === 'questions' ? <h2 className="m-reply-title">Question de l’agent</h2> : null}
          <AttentionDetail session={session} reason={session.attentionReason} withKeys explicitKeys />
        </section>
      ) : null}
      {detail?.kind === 'turn' ? (
        <section className="m-reply-block" aria-label="Dernier message de l'agent">
          <h2 className="m-reply-title">Dernier message de l’agent</h2>
          <Markdown className="m-reply-message" text={detail.message} />
          {session.epic === null ? null : <EpicStepValidation session={session} epicId={session.epic.id} />}
        </section>
      ) : null}
      {hasReply ? null : (
        <p className="m-hint">
          {exited
            ? 'Aucun message à afficher.'
            : 'Rien à lire ici pour l’instant : l’écran de l’agent est dans l’onglet Terminal.'}
        </p>
      )}
      {/* Arrêter reste différé de 5 s. */}
      <div className="m-session-actions">
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
      </div>
    </>
  );

  const tabs: SwipeTab<SessionTab>[] = [
    { id: 'reply', label: 'Réponse', content: reply, className: 'm-reply' },
    { id: 'terminal', label: 'Terminal', content: terminal, className: 'm-session-terminal' },
    {
      id: 'requests',
      label: 'Demandes',
      className: 'm-reply',
      content: (
        <SessionRequests
          sessionId={id}
          active={tab === 'requests'}
          refreshKey={`${session.status}:${sentCount}`}
          onReuse={exited ? null : reuse}
        />
      ),
    },
    {
      id: 'files',
      label: 'Fichiers',
      className: 'm-files',
      content: (
        <SessionFilesBrowser
          sessionId={id}
          live={!exited}
          active={tab === 'files'}
          focusSearch={false}
          onCite={cite}
          citeLabel="Citer dans la consigne"
        />
      ),
    },
  ];

  return (
    <div className="m-session">
      <div className="m-session-meta">
        <span className="m-session-status">
          <StatusDot status={status} />
          {STATUS_LABEL[status]}
        </span>
        {project === undefined ? null : <a href={href(`#/p/${project.id}`)}>{project.name}</a>}
        <AgentLabel agent={session.agent} />
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
      <SwipeTabs label="Session" idPrefix="m-session" tabs={tabs} value={tab} onChange={setTab} />
      {exited ? null : (
        <InstructionForm
          sessionId={id}
          send={send}
          text={draft}
          setText={setDraft}
          fieldRef={fieldRef}
          onSent={() => setSentCount((count) => count + 1)}
        />
      )}
    </div>
  );
}

/**
 * Écran d'une session : état, onglets « Réponse » (question, autorisation ou dernier message, commit / push, arrêt),
 * « Terminal » (écran et touches), « Demandes » (messages envoyés à l'agent) et « Fichiers » (dossier de la session),
 * consigne fixée en bas.
 * [SPEC: vue mobile, écran de session]
 */
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
