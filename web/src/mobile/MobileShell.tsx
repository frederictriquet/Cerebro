/*
 * Vue mobile de Cerebro, servie à /mobile.
 *
 * Règle : ne jamais monter Term.tsx dans la vue mobile, ni un composant qui le monte (SessionView). Term réclame
 * la taille du PTY à la connexion, au focus et à chaque envoi (`claim` dans web/src/Term.tsx), et le serveur
 * applique une taille unique à tous les postes (`SessionManager.resize`, server/sessions.ts) : le terminal du
 * desktop prendrait la largeur du téléphone. La vue mobile lit l'écran par GET /api/sessions/:id/screen et écrit
 * par POST /api/sessions/:id/input, qui ne touchent pas à la taille.
 */
import { useEffect, useState } from 'react';
import { formatDateTime, sessionTitle } from '../format.ts';
import { MachineSwitcher } from '../MachineSwitcher.tsx';
import { useRoute, type Route } from '../route.ts';
import { useStore } from '../store.tsx';
import { mobileBack, trackMobileHistory } from './back.ts';
import { CouncilScreen } from './CouncilScreen.tsx';
import { CouncilsTab } from './CouncilsTab.tsx';
import { ProjectList } from './ProjectList.tsx';
import { ProjectScreen } from './ProjectScreen.tsx';
import { forgetFullVersion, openFullVersion } from './redirect.ts';
import { SessionScreen } from './SessionScreen.tsx';
import { TodoTab } from './TodoTab.tsx';
import './mobile.css';

// Version servie, pour vérifier depuis le téléphone que le dernier build est chargé.
const BUILD_LABEL =
  __CEREBRO_BUILD__ === null ? 'dev' : `${__CEREBRO_BUILD__.sha} · ${formatDateTime(__CEREBRO_BUILD__.at)}`;

type HomeTab = 'todo' | 'projects' | 'councils';

const HOME_TABS: readonly { id: HomeTab; label: string }[] = [
  { id: 'todo', label: 'À traiter' },
  { id: 'projects', label: 'Projets' },
  { id: 'councils', label: 'Councils' },
];

function useRouteTitle(route: Route): string {
  const { projects, sessions } = useStore();
  switch (route.kind) {
    case 'home':
      return 'Cerebro';
    case 'project':
      return projects.find((project) => project.id === route.projectId)?.name ?? 'Projet';
    case 'session': {
      const session = sessions.find((candidate) => candidate.id === route.sessionId);
      return session === undefined ? 'Session' : sessionTitle(session.title);
    }
    case 'council':
      return 'Council';
  }
}

function HomeScreen({ tab, onTab }: { tab: HomeTab; onTab: (tab: HomeTab) => void }) {
  const current = HOME_TABS.find((candidate) => candidate.id === tab) ?? HOME_TABS[0];
  return (
    <>
      <div className="m-tabs" role="tablist" aria-label="Accueil">
        {HOME_TABS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            id={`m-tab-${candidate.id}`}
            aria-selected={candidate.id === tab}
            aria-controls="m-tab-panel"
            className="m-tab"
            onClick={() => onTab(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <section className="m-content" role="tabpanel" id="m-tab-panel" aria-labelledby={`m-tab-${current.id}`}>
        <h2 className="m-screen-title">{current.label}</h2>
        {current.id === 'projects' ? <ProjectList /> : current.id === 'councils' ? <CouncilsTab /> : <TodoTab />}
      </section>
    </>
  );
}

export function MobileShell() {
  const route = useRoute();
  const title = useRouteTitle(route);
  // Onglet de l'accueil : retrouvé en revenant d'une session ou d'un projet.
  const [homeTab, setHomeTab] = useState<HomeTab>('todo');
  const [fullVersionError, setFullVersionError] = useState<string | null>(null);

  // Ouvrir la vue mobile annule un choix antérieur de la version complète : `/` redirige de nouveau ce téléphone.
  // Un échec d'effacement est journalisé par writeStored ; le stockage qui le cause empêche aussi de relire le choix.
  useEffect(() => {
    forgetFullVersion();
  }, []);

  useEffect(() => trackMobileHistory(), []);

  return (
    <div className="m-app">
      <header className="m-topbar">
        {route.kind === 'home' ? null : (
          <button type="button" className="m-back" aria-label="Retour" onClick={mobileBack}>
            ‹
          </button>
        )}
        <h1 className="m-title">{title}</h1>
        {route.kind === 'home' ? <span className="m-build">{BUILD_LABEL}</span> : null}
        <a
          className="m-full-version"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            setFullVersionError(openFullVersion());
          }}
        >
          Version complète
        </a>
      </header>
      {/* Choisir une machine ouvre son projet épinglé, sinon son accueil ; rien ne s'affiche sans machine distante. */}
      <MachineSwitcher />
      {fullVersionError === null ? null : (
        <p className="m-error" role="alert">
          Version complète indisponible : le choix n'a pas pu être enregistré ({fullVersionError}).
        </p>
      )}
      <main className="m-main">
        {route.kind === 'home' ? (
          <HomeScreen tab={homeTab} onTab={setHomeTab} />
        ) : route.kind === 'project' ? (
          <ProjectScreen projectId={route.projectId} />
        ) : route.kind === 'council' ? (
          <CouncilScreen key={route.councilId} councilId={route.councilId} />
        ) : (
          <SessionScreen key={route.sessionId} sessionId={route.sessionId} />
        )}
      </main>
    </div>
  );
}
