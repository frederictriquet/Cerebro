import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { clipboardImage, uploadImage } from './api.ts';
import { AttachmentStrip, insertToken, removeToken, useImageAttachments } from './attachments.tsx';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import { AddTaskDialog, LaunchSessionDialog } from './Dialog.tsx';
import { AGENT_LABEL, displayStatus, MODE_LABEL, STATUS_LABEL, sessionTitle } from './format.ts';
import { go, href, useNow } from './route.ts';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import { Term, type TermApi } from './Term.tsx';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

const QUICK_KEYS: readonly { label: string; data: string; confirm: boolean; arrow?: 'up' | 'down' }[] = [
  { label: 'Entrée', data: '\r', confirm: false },
  { label: 'Échap', data: '\x1b', confirm: false },
  { label: '↑', data: '', confirm: false, arrow: 'up' },
  { label: '↓', data: '', confirm: false, arrow: 'down' },
  { label: '1', data: '1', confirm: false },
  { label: '2', data: '2', confirm: false },
  { label: '3', data: '3', confirm: false },
  { label: 'y', data: 'y', confirm: false },
  { label: 'n', data: 'n', confirm: false },
  { label: 'Ctrl+C', data: '\x03', confirm: true },
];

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function TitleEditor({ sessionId, title }: { sessionId: string; title: string }) {
  const { renameSession } = useStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  const cancel = (): void => {
    saving.current = false;
    setEditing(false);
    setDraft(title);
    setError(null);
  };

  const save = async (): Promise<void> => {
    const next = draft.trim();
    if (next.length === 0) {
      saving.current = false;
      setError('Le titre ne peut pas être vide');
      return;
    }
    if (next.length > 120) {
      saving.current = false;
      setError('120 caractères maximum');
      return;
    }
    if (next === title) {
      setEditing(false);
      setError(null);
      return;
    }
    saving.current = true;
    setError(null);
    try {
      await renameSession(sessionId, next);
      setEditing(false);
    } catch (err) {
      saving.current = false;
      setError(err instanceof Error ? err.message : 'Renommage impossible');
    }
  };

  if (!editing) {
    return (
      <>
        <h1 title="Double-clic pour renommer" onDoubleClick={() => setEditing(true)}>
          {sessionTitle(title)}
        </h1>
        <button type="button" className="btn icon" aria-label="Renommer" onClick={() => setEditing(true)}>
          <PencilIcon />
        </button>
      </>
    );
  }

  return (
    <form
      className="title-edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        className="title-edit"
        autoFocus
        value={draft}
        maxLength={120}
        aria-label="Titre de la session"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!saving.current) cancel();
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            saving.current = true;
            void save();
          }
        }}
      />
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}

function ImageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}

function QuickReply({
  sessionId,
  disabled,
  send,
  sendArrow,
}: {
  sessionId: string;
  disabled: boolean;
  send: (data: string) => boolean;
  sendArrow: (direction: 'up' | 'down') => boolean;
}) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const press = (key: (typeof QUICK_KEYS)[number]): void => {
    if (disabled) return;
    if (key.confirm && !window.confirm('Envoyer Ctrl+C à cette session ?')) return;
    setNote(null);
    const ok = key.arrow !== undefined ? sendArrow(key.arrow) : send(key.data);
    if (!ok) setNote('Terminal non connecté');
  };

  const images = useImageAttachments((image) => uploadImage(sessionId, image));

  // « [Image #N] » est inséré au curseur ; le chemin réel est substitué à l'envoi.
  const attach = (image: File): void => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? start;
    setNote(null);
    const token = images.add(image, (failed, message) => {
      if (!mounted.current) return;
      setText((current) => removeToken(current, failed));
      setNote(message);
    });
    setText((current) => insertToken(current, start, end, token));
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    const image = clipboardImage(e.clipboardData);
    if (!image) return;
    e.preventDefault();
    attach(image);
  };

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (disabled || sending || images.pending || text.trim().length === 0) return;
    const value = images.expand(text);
    setNote(null);
    if (!send(value)) {
      setNote('Terminal non connecté');
      return;
    }
    setText('');
    images.reset();
    setSending(true);
    // Deux messages distincts : certaines TUI ignorent l'Entrée collée au texte.
    await delay(150);
    if (!mounted.current) return;
    if (!disabledRef.current && !send('\r')) setNote('Entrée non envoyée');
    setSending(false);
  };

  return (
    <div className="quick-bar">
      <div className="quick-keys">
        {QUICK_KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            className="btn"
            disabled={disabled}
            onClick={() => press(key)}
          >
            {key.label}
          </button>
        ))}
      </div>
      <form className="quick-send" onSubmit={(e) => void onSubmit(e)}>
        <input
          ref={inputRef}
          value={text}
          disabled={disabled || sending}
          autoComplete="off"
          placeholder="Envoyer un message (Ctrl+V pour joindre une capture d’écran)"
          aria-label="Envoyer un message"
          onPaste={onPaste}
          onChange={(e) => {
            setText(e.target.value);
            images.prune(e.target.value);
            setNote(null);
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) attach(file);
          }}
        />
        <button
          type="button"
          className="btn icon"
          aria-label="Joindre une image"
          title="Joindre une image"
          disabled={disabled || sending}
          onClick={() => fileRef.current?.click()}
        >
          <ImageIcon />
        </button>
        <button type="submit" className="btn primary" disabled={disabled || sending || images.pending || text.trim().length === 0}>
          Envoyer
        </button>
      </form>
      <AttachmentStrip
        items={images.items}
        onRemove={(item) => {
          images.remove(item.n);
          setText((current) => removeToken(current, item.token));
        }}
      />
      {note ? <p className="form-error">{note}</p> : null}
    </div>
  );
}

export function SessionView({ sessionId }: { sessionId: string }) {
  const { sessions, projects, agents, killSession, resumeSession, deleteSession, markSeen, createSession } = useStore();
  const session = sessions.find((s) => s.id === sessionId);
  const project = session ? projects.find((p) => p.id === session.projectId) : undefined;
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  const live = session !== undefined && session.status !== 'exited';
  const termApi = useRef<TermApi | null>(null);
  const onApi = useCallback((api: TermApi | null) => {
    termApi.current = api;
  }, []);
  const send = useCallback((data: string): boolean => {
    const api = termApi.current;
    if (!api) return false;
    return api.sendInput(data);
  }, []);
  const sendArrow = useCallback((direction: 'up' | 'down'): boolean => {
    const api = termApi.current;
    if (!api) return false;
    return api.sendArrow(direction);
  }, []);
  const [hasSelection, setHasSelection] = useState(false);
  // Texte capturé au clic : la sélection xterm peut changer pendant que la modale est ouverte.
  const [selectionAction, setSelectionAction] = useState<{ kind: 'session' | 'task'; text: string } | null>(null);
  const openSelection = (kind: 'session' | 'task'): void => {
    const text = termApi.current?.getSelection() ?? '';
    if (text !== '') setSelectionAction({ kind, text });
  };

  useEffect(() => {
    void markSeen(sessionId);
  }, [sessionId, markSeen]);

  if (!session) {
    return (
      <div className="pane padded">
        <p className="empty-hint">Session introuvable.</p>
        <a href={href('#/')}>Retour</a>
      </div>
    );
  }

  const shown = displayStatus(session, now);

  const act = async (fn: () => Promise<unknown>, thenGo?: string): Promise<void> => {
    setError(null);
    try {
      await fn();
      if (thenGo !== undefined) go(thenGo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action impossible');
    }
  };

  return (
    <div className="pane session-pane">
      <header className="session-head">
        <div className="session-head-main">
          <div className="session-title-row">
            <StatusDot status={shown} title={STATUS_LABEL[shown]} />
            <TitleEditor key={session.id} sessionId={session.id} title={session.title} />
          </div>
          <p className="session-meta">
            <span className="pill">{AGENT_LABEL[session.agent]}</span>
            <span className="pill">{MODE_LABEL[session.mode]}</span>
            {session.model !== null ? <span className="pill">{agents.find((a) => a.agent === session.agent)?.models.find((m) => m.value === session.model)?.label ?? session.model}</span> : null}
            {session.effort !== null ? <span className="pill">effort {session.effort}</span> : null}
            <span className={`pill status ${shown}`}>{STATUS_LABEL[shown]}</span>
            {project ? (
              <a className="project-crumb" href={href(`#/p/${project.id}`)}>
                {project.name}
              </a>
            ) : null}
            {session.attentionReason ? (
              <span className="reason">{session.attentionReason}</span>
            ) : null}
            {session.status === 'exited' && session.exitCode !== null ? (
              <span className="pill">code {session.exitCode}</span>
            ) : null}
          </p>
        </div>
        <div className="row-actions">
          {session.status !== 'exited' ? (
            <button type="button" className="btn" onClick={() => void act(() => killSession(session.id))}>
              Arrêter
            </button>
          ) : null}
          {session.status === 'exited' && session.agentSessionId ? (
            <button type="button" className="btn primary" onClick={() => void act(() => resumeSession(session.id))}>
              Reprendre
            </button>
          ) : null}
          <DelayedActionButton onAction={() => void act(() => deleteSession(session.id), project ? `#/p/${project.id}` : '#/')}>
            Supprimer
          </DelayedActionButton>
        </div>
      </header>
      {error ? <p className="form-error session-error">{error}</p> : null}
      <div className="term-wrap">
        <Term
          key={`${session.id}:${live ? 'live' : 'exited'}`}
          sessionId={session.id}
          onApi={onApi}
          onSelectionChange={setHasSelection}
        />
        {hasSelection ? (
          // preventDefault au mousedown : le clic ne doit pas effacer la sélection du terminal.
          <div className="selection-bar" onMouseDown={(e) => e.preventDefault()}>
            <button type="button" className="btn" onClick={() => openSelection('session')}>
              Nouvelle session
            </button>
            <button type="button" className="btn" onClick={() => openSelection('task')}>
              Ajouter au backlog
            </button>
          </div>
        ) : null}
      </div>
      {selectionAction?.kind === 'session' ? (
        <LaunchSessionDialog
          title="Nouvelle session depuis la sélection"
          projectId={session.projectId}
          initialPrompt={selectionAction.text}
          onClose={() => setSelectionAction(null)}
          onLaunch={async (spec) => {
            const created = await createSession(session.projectId, spec);
            setSelectionAction(null);
            go(`#/s/${created.id}`);
          }}
        />
      ) : null}
      {selectionAction?.kind === 'task' ? (
        <AddTaskDialog
          projectId={session.projectId}
          initialText={selectionAction.text}
          sourceSessionId={session.id}
          onClose={() => setSelectionAction(null)}
        />
      ) : null}
      <QuickReply key={session.id} sessionId={session.id} disabled={!live} send={send} sendArrow={sendArrow} />
    </div>
  );
}
