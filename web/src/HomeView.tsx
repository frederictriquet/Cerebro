import { useState, type FormEvent } from 'react';
import { AGENT_LABEL, displayStatus, isAwaiting, relativeTime, sessionTitle, STATUS_LABEL } from './format.ts';
import { go, href, useNow } from './route.ts';
import { PathInput } from './PathInput.tsx';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import type { Session } from './types.ts';

function compareLive(a: Session, b: Session): number {
  if (a.attention !== b.attention) return a.attention ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

export function HomeView() {
  const { projects, sessions, createProject } = useStore();
  const now = useNow();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const running = sessions.filter((s) => s.status === 'running' || s.status === 'starting').length;
  const waiting = sessions.filter((s) => s.status === 'waiting').length;
  const idle = sessions.filter((s) => s.status === 'idle').length;
  const live = sessions.filter((s) => s.status !== 'exited').sort(compareLive);

  const onCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const project = await createProject(name.trim(), path.trim());
      setName('');
      setPath('');
      go(`#/p/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane padded home">
      <h1>Cerebro</h1>
      <div className="stats">
        <div className="stat running">
          <b>{running}</b>
          <span>En cours</span>
        </div>
        <div className="stat waiting">
          <b>{waiting}</b>
          <span>En attente</span>
        </div>
        <div className="stat idle">
          <b>{idle}</b>
          <span>Inactives</span>
        </div>
      </div>

      {projects.length === 0 ? (
        <form className="card home-create" onSubmit={(e) => void onCreate(e)}>
          <h2>Créer un projet</h2>
          <label>
            Nom
            <input
              required
              autoComplete="off"
              placeholder="Nom"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block">
            Chemin
            <PathInput required value={path} onChange={setPath} />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button type="submit" className="btn primary" disabled={busy}>
            Créer un projet
          </button>
        </form>
      ) : null}

      <section className="session-table-wrap">
        <h2>Sessions vivantes</h2>
        {live.length === 0 ? (
          <p className="empty-hint">Aucune session en cours.</p>
        ) : (
          <ul className="session-table">
            {live.map((session) => {
              const project = projects.find((p) => p.id === session.projectId);
              const awaiting = isAwaiting(session);
              const shown = displayStatus(session, now);
              return (
                <li key={session.id} className="session-row">
                  <div className="session-row-main">
                    <a href={href(`#/s/${session.id}`)} className="session-main">
                      <StatusDot status={shown} title={STATUS_LABEL[shown]} />
                      <span className="session-row-title">{sessionTitle(session.title)}</span>
                      <span className="pill">{AGENT_LABEL[session.agent]}</span>
                      <span className={`pill status ${shown}`}>{STATUS_LABEL[shown]}</span>
                      <span className="meta">{relativeTime(session.updatedAt, now)}</span>
                    </a>
                    {awaiting && session.attentionReason ? (
                      <p className={`reason-line ${session.status === 'waiting' ? 'waiting' : 'idle'}`}>
                        {session.attentionReason}
                      </p>
                    ) : null}
                  </div>
                  {project ? (
                    <a className="meta project-jump" href={href(`#/p/${project.id}`)}>
                      {project.name}
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
