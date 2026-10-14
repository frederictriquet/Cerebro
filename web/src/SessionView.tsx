import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AGENT_LABEL, MODE_LABEL, STATUS_LABEL, sessionTitle } from './format.ts';
import { go } from './route.ts';
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

function QuickReply({
  disabled,
  send,
  sendArrow,
}: {
  disabled: boolean;
  send: (data: string) => boolean;
  sendArrow: (direction: 'up' | 'down') => boolean;
}) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
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

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (disabled || sending || text.length === 0) return;
    const value = text;
    setNote(null);
    if (!send(value)) {
      setNote('Terminal non connecté');
      return;
    }
    setText('');
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
          value={text}
          disabled={disabled || sending}
          autoComplete="off"
          placeholder="Envoyer un message"
          aria-label="Envoyer un message"
          onChange={(e) => {
            setText(e.target.value);
            setNote(null);
          }}
        />
        <button type="submit" className="btn primary" disabled={disabled || sending || text.length === 0}>
          Envoyer
        </button>
      </form>
      {note ? <p className="form-error">{note}</p> : null}
    </div>
  );
}

export function SessionView({ sessionId }: { sessionId: string }) {
  const { sessions, projects, killSession, resumeSession, deleteSession, markSeen } = useStore();
  const session = sessions.find((s) => s.id === sessionId);
  const project = session ? projects.find((p) => p.id === session.projectId) : undefined;
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    void markSeen(sessionId);
  }, [sessionId, markSeen]);

  if (!session) {
    return (
      <div className="pane padded">
        <p className="empty-hint">Session introuvable.</p>
        <a href="#/">Retour</a>
      </div>
    );
  }

  const act = async (fn: () => Promise<unknown>, thenHome = false): Promise<void> => {
    setError(null);
    try {
      await fn();
      if (thenHome) go('#/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action impossible');
    }
  };

  return (
    <div className="pane session-pane">
      <header className="session-head">
        <div className="session-head-main">
          <div className="session-title-row">
            <StatusDot status={session.status} title={STATUS_LABEL[session.status]} />
            <TitleEditor key={session.id} sessionId={session.id} title={session.title} />
          </div>
          <p className="session-meta">
            <span className="pill">{AGENT_LABEL[session.agent]}</span>
            <span className="pill">{MODE_LABEL[session.mode]}</span>
            <span className={`pill status ${session.status}`}>{STATUS_LABEL[session.status]}</span>
            {project ? (
              <a className="project-crumb" href={`#/p/${project.id}`}>
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
          <button
            type="button"
            className="btn danger-ghost"
            onClick={() => {
              if (!window.confirm(`Supprimer « ${sessionTitle(session.title)} » ?`)) return;
              void act(() => deleteSession(session.id), true);
            }}
          >
            Supprimer
          </button>
        </div>
      </header>
      {error ? <p className="form-error session-error">{error}</p> : null}
      <div className="term-wrap">
        <Term key={`${session.id}:${live ? 'live' : 'exited'}`} sessionId={session.id} onApi={onApi} />
      </div>
      <QuickReply key={session.id} disabled={!live} send={send} sendArrow={sendArrow} />
    </div>
  );
}
