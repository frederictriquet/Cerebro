import { Worktrees } from './worktrees/Worktrees.tsx';
import { LlmUsageStats } from './LlmUsageStats.tsx';
import { CouncilLaunch } from './CouncilLaunch.tsx';
import { useState } from 'react';
import { NewProjectForm } from './NewProjectForm.tsx';
import { useNow } from './polling.tsx';
import { useStore } from './store.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { SessionList } from './SessionList.tsx';
import { TabBar, tabIds, useStoredTab } from './TabBar.tsx';

// Onglets de l'accueil, dans l'ordre d'affichage ; les statistiques en dernier.
const HOME_TABS = ['sessions', 'worktrees', 'councils', 'stats'] as const;
type HomeTab = (typeof HOME_TABS)[number];

export function HomeView() {
  const { projects, sessions } = useStore();
  const now = useNow();
  const [error, setError] = useState<string | null>(null);
  const [tab, selectTab] = useStoredTab<HomeTab>('cerebro.home-tab', HOME_TABS);

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
        <NewProjectForm
          className="card home-create"
          heading="Créer un projet"
          submitLabel="Créer un projet"
          onError={setError}
        />
      ) : null}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <TabBar<HomeTab>
        idPrefix="home"
        label="Sections de l’accueil"
        tabs={[
          {
            id: 'sessions',
            label: 'Sessions',
            count: { value: live.length, title: 'Sessions vivantes et reviews à traiter' },
          },
          { id: 'worktrees', label: 'Copies de travail' },
          { id: 'councils', label: 'Council' },
          { id: 'stats', label: 'Statistiques' },
        ]}
        selected={tab}
        onSelect={selectTab}
      />
      <div
        className="view-tab-panel"
        role="tabpanel"
        id={tabIds('home', tab).panel}
        aria-labelledby={tabIds('home', tab).tab}
      >
        {tab === 'sessions' ? (
          <section className="session-table-wrap">
            <h2>Sessions vivantes et reviews à traiter</h2>
            {live.length === 0 ? (
              <p className="empty-hint">Aucune session en cours.</p>
            ) : (
              <ErrorBoundary zone="Sessions">
                <SessionList sessions={live} now={now} showProject onError={setError} />
              </ErrorBoundary>
            )}
          </section>
        ) : tab === 'worktrees' ? (
          <ErrorBoundary zone="Copies de travail">
            <Worktrees />
          </ErrorBoundary>
        ) : tab === 'councils' ? (
          <section className="card home-council" aria-label="Council">
            <h2>Council</h2>
            <p className="hint">Soumettez une question à plusieurs conseillers, relus anonymement puis synthétisés.</p>
            <ErrorBoundary zone="Council">
              <CouncilLaunch />
            </ErrorBoundary>
          </section>
        ) : (
          <ErrorBoundary zone="Statistiques">
            <LlmUsageStats sessions={sessions} now={now} />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
