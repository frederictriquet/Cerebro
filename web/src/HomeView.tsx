import { Worktrees } from './Worktrees.tsx';
import { LlmUsageStats } from './LlmUsageStats.tsx';
import { useState, type FormEvent } from 'react';
import { go, useNow } from './route.ts';
import { PathInput } from './PathInput.tsx';
import { useStore } from './store.tsx';
import { SessionRow } from './SessionRow.tsx';

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
  const live = sessions.filter((s) => s.status !== 'exited');

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
      <header className="home-head">
        <h1>Cerebro</h1>
        <div className="stats" aria-label="État des sessions">
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
      </header>

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
          <button type="submit" className="btn primary" disabled={busy}>
            Créer un projet
          </button>
        </form>
      ) : null}

      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <div className="home-panels">
        <Worktrees />
        <LlmUsageStats sessions={sessions} now={now} />
      </div>

      <section className="session-table-wrap">
        <h2>Sessions vivantes</h2>
        {live.length === 0 ? (
          <p className="empty-hint">Aucune session en cours.</p>
        ) : (
          <ul className="session-table">
            {live.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                now={now}
                project={projects.find((project) => project.id === session.projectId)}
                onError={setError}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
