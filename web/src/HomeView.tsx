import { Worktrees } from './Worktrees.tsx';
import { LlmUsageStats } from './LlmUsageStats.tsx';
import { CouncilLaunch } from './CouncilLaunch.tsx';
import { useState } from 'react';
import { NewProjectForm } from './NewProjectForm.tsx';
import { useNow } from './polling.tsx';
import { useStore } from './store.tsx';
import { SessionList } from './SessionList.tsx';

export function HomeView() {
  const { projects, sessions } = useStore();
  const now = useNow();
  const [error, setError] = useState<string | null>(null);

  const running = sessions.filter((s) => s.status === 'running' || s.status === 'starting').length;
  const waiting = sessions.filter((s) => s.status === 'waiting').length;
  const idle = sessions.filter((s) => s.status === 'idle').length;
  const live = sessions.filter((s) => s.status !== 'exited' || s.pendingFindings > 0);

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
        <NewProjectForm className="card home-create" heading="Créer un projet" submitLabel="Créer un projet" onError={setError} />
      ) : null}

      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <div className="home-panels">
        <Worktrees />
        <LlmUsageStats sessions={sessions} now={now} />
        <section className="card home-council" aria-label="Council">
          <h2>Council</h2>
          <p className="hint">Soumettez une question à plusieurs conseillers, relus anonymement puis synthétisés.</p>
          <CouncilLaunch />
        </section>
        <section className="session-table-wrap">
          <h2>Sessions vivantes et reviews à traiter</h2>
          {live.length === 0 ? (
            <p className="empty-hint">Aucune session en cours.</p>
          ) : (
            <SessionList sessions={live} now={now} showProject onError={setError} />
          )}
        </section>
      </div>
    </div>
  );
}
