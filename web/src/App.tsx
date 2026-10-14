import { ProjectView } from './ProjectView.tsx';
import { SessionView } from './SessionView.tsx';
import { Sidebar } from './Sidebar.tsx';
import { StoreProvider } from './store.tsx';
import { useRoute } from './route.ts';

function HomeView() {
  return (
    <div className="pane padded home">
      <h1>Cerebro</h1>
      <p>
        Pilotez des sessions <strong>claude</strong>, <strong>codex</strong> et <strong>grok</strong> par
        projet.
      </p>
      <p className="empty-hint">Choisissez un projet dans la barre latérale, ou créez-en un.</p>
    </div>
  );
}

function Shell() {
  const route = useRoute();
  return (
    <div className="app">
      <Sidebar route={route} />
      <main className="main">
        {route.kind === 'project' ? (
          <ProjectView projectId={route.projectId} />
        ) : route.kind === 'session' ? (
          <SessionView sessionId={route.sessionId} />
        ) : (
          <HomeView />
        )}
      </main>
    </div>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
