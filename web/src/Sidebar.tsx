import { useRef, useState, type FormEvent } from 'react';
import { AGENT_LABEL, relativeTime, sessionTitle } from './format.ts';
import { go, useNow, type Route } from './route.ts';
import { PathInput } from './PathInput.tsx';
import { PreviewButton, ScreenPopover, usePreviewController } from './ScreenPreview.tsx';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import type { Session } from './types.ts';

export function Sidebar({ route, onNavigate }: { route: Route; onNavigate: () => void }) {
  const { sessions, connected, muted, setMuted, createProject } = useStore();
  const now = useNow();
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attention = sessions.filter((s) => s.attention);
  const activeSessionId = route.kind === 'session' ? route.sessionId : null;

  const onCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const project = await createProject(name.trim(), path.trim());
      setName('');
      setPath('');
      setShowNew(false);
      go(`#/p/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="sidebar" id="sidebar">
      <header className="sidebar-head">
        <a className="brand" href="#/" onClick={() => { onNavigate(); go('#/'); }}>
          <span className="brand-mark" aria-hidden="true" />
          Cerebro
        </a>
        <button
          type="button"
          className="btn-mute"
          aria-pressed={muted}
          title={muted ? 'Activer le son' : 'Couper le son'}
          onClick={() => setMuted(!muted)}
        >
          {muted ? 'Muet' : 'Son'}
        </button>
      </header>
      <div className={`ws-pill ${connected ? 'on' : 'off'}`}>
        {connected ? 'connecté' : 'reconnexion…'}
      </div>

      <section className="side-section">
        <h2>
          À traiter
          {attention.length > 0 ? <span className="count">{attention.length}</span> : null}
        </h2>
        {attention.length === 0 ? (
          <p className="empty-hint">Rien pour le moment</p>
        ) : (
          <ul className="side-list">
            {attention.map((s) => (
              <AttentionItem
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                now={now}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="side-section side-projects">
        <h2>Nouveau projet</h2>
        {showNew ? (
          <form className="new-project" onSubmit={(e) => void onCreate(e)}>
            <input
              required
              autoComplete="off"
              placeholder="Nom"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <PathInput required value={path} onChange={setPath} />
            {error ? <p className="form-error">{error}</p> : null}
            <div className="row-actions">
              <button type="submit" className="btn primary" disabled={busy}>
                Créer
              </button>
              <button type="button" className="btn" onClick={() => setShowNew(false)}>
                Annuler
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn add-project" onClick={() => setShowNew(true)}>
            + Projet
          </button>
        )}
      </section>
    </aside>
  );
}

function AttentionItem({
  session,
  active,
  now,
  onNavigate,
}: {
  session: Session;
  active: boolean;
  now: number;
  onNavigate: () => void;
}) {
  const tone = session.status === 'waiting' ? 'waiting' : 'idle';
  const preview = usePreviewController();
  const anchorRef = useRef<HTMLSpanElement>(null);
  return (
    <li className="attention-item" {...preview.hoverProps}>
      <a
        href={`#/s/${session.id}`}
        className={`attention-link ${tone} ${active ? 'active' : ''}`}
        onClick={onNavigate}
      >
        <StatusDot status={session.status === 'waiting' ? 'waiting' : 'idle'} />
        <span className="session-link-title">{sessionTitle(session.title)}</span>
        <span className="meta">
          {AGENT_LABEL[session.agent]} · {relativeTime(session.updatedAt, now)}
        </span>
      </a>
      <div className="attention-extra">
        {session.attentionReason ? <p className={`reason-line ${tone}`}>{session.attentionReason}</p> : null}
        <PreviewButton pressed={preview.open} onToggle={preview.toggle} anchorRef={anchorRef} />
      </div>
      {preview.open ? (
        <ScreenPopover sessionId={session.id} anchorRef={anchorRef} hoverProps={preview.hoverProps} />
      ) : null}
    </li>
  );
}
