import { useEffect, useState, type FormEvent } from 'react';
import { setApiBase, subscribeUnauthorized } from './api.ts';
import { HomeView } from './HomeView.tsx';
import { ProjectTabs } from './ProjectTabs.tsx';
import { ProjectView } from './ProjectView.tsx';
import { SessionView } from './SessionView.tsx';
import { MachineWatchProvider } from './MachineSwitcher.tsx';
import { Sidebar } from './Sidebar.tsx';
import { StoreProvider } from './store.tsx';
import { useMachine, useRoute } from './route.ts';

function TokenScreen() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem('token');
    const value = field instanceof HTMLInputElement ? field.value.trim() : '';
    if (value.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      // Le serveur pose un cookie persistant : plus besoin de ressaisir le jeton.
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: value }),
      });
      if (res.ok) {
        window.location.reload();
        return;
      }
      setError(res.status === 401 ? 'Jeton invalide' : `Erreur ${res.status}`);
    } catch {
      setError('Serveur injoignable');
    }
    setBusy(false);
  };

  return (
    <div className="token-screen">
      <form className="card token-card" onSubmit={(e) => void submit(e)}>
        <h1>Token requis</h1>
        <p>Cette instance exige un jeton pour accéder à l'API. Il est mémorisé par ce navigateur.</p>
        <label>
          Jeton
          <input
            name="token"
            type="password"
            required
            autoFocus
            autoComplete="current-password"
            spellCheck={false}
          />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button type="submit" className="btn primary" disabled={busy}>
          Continuer
        </button>
      </form>
    </div>
  );
}

function Shell() {
  const route = useRoute();
  const [navOpen, setNavOpen] = useState(false);
  const routeKey =
    route.kind === 'home' ? 'home' : route.kind === 'project' ? `p:${route.projectId}` : `s:${route.sessionId}`;

  useEffect(() => {
    setNavOpen(false);
  }, [routeKey]);

  return (
    <div className={`app${navOpen ? ' nav-open' : ''}`}>
      <div className="mobile-bar">
        <button
          type="button"
          className="btn nav-toggle"
          aria-expanded={navOpen}
          aria-controls="sidebar"
          onClick={() => setNavOpen((open) => !open)}
        >
          Menu
        </button>
        <span className="mobile-title">Cerebro</span>
      </div>
      {navOpen ? (
        <button type="button" className="nav-backdrop" aria-label="Fermer le menu" onClick={() => setNavOpen(false)} />
      ) : null}
      <Sidebar route={route} onNavigate={() => setNavOpen(false)} />
      <main className="main">
        <ProjectTabs route={route} />
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
  const machine = useMachine();
  // Avant les enfants : leurs fetch et WebSocket lisent cette base dès le premier effet.
  setApiBase(machine);
  const [locked, setLocked] = useState(false);

  useEffect(() => subscribeUnauthorized(() => setLocked(true)), []);

  if (locked) return <TokenScreen />;

  return (
    <MachineWatchProvider>
      <StoreProvider key={machine ?? 'local'}>
        <Shell />
      </StoreProvider>
    </MachineWatchProvider>
  );
}
