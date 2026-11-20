/*
 * Vue mobile de Cerebro, servie à /mobile.
 *
 * Règle : ne jamais monter Term.tsx dans la vue mobile, ni un composant qui le monte (SessionView). Term réclame
 * la taille du PTY à la connexion, au focus et à chaque envoi (`claim` dans web/src/Term.tsx), et le serveur
 * applique une taille unique à tous les postes (`SessionManager.resize`, server/sessions.ts). La vue mobile lit
 * l'écran par GET /api/sessions/:id/screen, écrit par POST /api/sessions/:id/input et n'impose la taille du
 * téléphone, par POST /api/sessions/:id/resize, qu'aux moments décidés dans SessionScreen.tsx.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatDateTime, plural, sessionTitle } from '../format.ts';
import { MachineSwitcher } from '../MachineSwitcher.tsx';
import { replaceRoute, useRoute, type Route } from '../route.ts';
import { useStore } from '../store.tsx';
import { mobileBack, trackMobileHistory } from './back.ts';
import { CouncilScreen } from './CouncilScreen.tsx';
import { CouncilsTab } from './CouncilsTab.tsx';
import { ProjectList } from './ProjectList.tsx';
import { ProjectHeaderActions, ProjectScreen, type ProjectTab } from './ProjectScreen.tsx';
import { forgetFullVersion, openFullVersion, pinnedProjectHash } from './redirect.ts';
import { SessionScreen } from './SessionScreen.tsx';
import { SwipeTabs, type SwipeTab } from './SwipeTabs.tsx';
import { TodoTab } from './TodoTab.tsx';
import './mobile.css';

// Version servie, pour vérifier depuis le téléphone que le dernier build est chargé.
const BUILD_LABEL =
  __CEREBRO_BUILD__ === null ? 'dev' : `${__CEREBRO_BUILD__.sha} · ${formatDateTime(__CEREBRO_BUILD__.at)}`;

type HomeTab = 'todo' | 'projects' | 'councils';

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

/** Accueil : onglets « À traiter », « Projets » et « Councils », changés au tap ou au balayage. [SPEC: vue mobile, accueil] */
function HomeScreen({ tab, onTab }: { tab: HomeTab; onTab: (tab: HomeTab) => void }) {
  const { projects, projectBehind } = useStore();
  const pullProjects = projects.filter((project) => !project.paused && (projectBehind?.[project.id] ?? 0) > 0).length;
  const tabs: SwipeTab<HomeTab>[] = [
    { id: 'todo', label: 'À traiter', content: <TodoTab />, className: 'm-content' },
    {
      id: 'projects',
      label: 'Projets',
      badge:
        pullProjects > 0 ? (
          <span className="m-tab-pull" aria-label={`${plural(pullProjects, 'projet')} à mettre à jour`}>
            ↓{pullProjects}
          </span>
        ) : undefined,
      content: <ProjectList />,
      className: 'm-content',
    },
    { id: 'councils', label: 'Councils', content: <CouncilsTab />, className: 'm-content' },
  ];
  return <SwipeTabs label="Accueil" idPrefix="m-home" tabs={tabs} value={tab} onChange={onTab} />;
}

/**
 * Ouvre le projet épinglé de la machine quand la vue mobile s'ouvre sans route. Décidé une fois, au premier
 * snapshot : épingler depuis le desktop n'emmène pas un téléphone resté sur l'accueil. Le shell remonte à chaque
 * changement de machine, mais le hash n'est vide qu'à l'ouverture. replaceRoute garde la marque `entry` de
 * l'historique : ‹ mène ensuite à l'accueil (`#/`), qui ne redirige plus.
 */
function usePinnedProjectOnOpen(): void {
  const { projects, loaded } = useStore();
  const decided = useRef(false);
  // Avant l'affichage : l'accueil rempli ne s'affiche pas avant la redirection.
  useLayoutEffect(() => {
    if (decided.current || !loaded) return;
    decided.current = true;
    const hash = pinnedProjectHash(window.location.hash, projects);
    if (hash !== null) replaceRoute(hash);
  }, [loaded, projects]);
}

export function MobileShell() {
  const route = useRoute();
  const title = useRouteTitle(route);
  usePinnedProjectOnOpen();
  // Onglet de l'accueil : retrouvé en revenant d'une session ou d'un projet.
  const [homeTab, setHomeTab] = useState<HomeTab>('todo');
  // Onglet de chaque page projet : retrouvé en revenant d'une session lancée depuis « Lancer » ou « Backlog ».
  const [projectTabs, setProjectTabs] = useState<Readonly<Record<string, ProjectTab>>>({});
  const [fullVersionError, setFullVersionError] = useState<string | null>(null);
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const projectId = route.kind === 'project' ? route.projectId : null;
  useEffect(() => setProjectActionError(null), [projectId]);

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
        {projectId === null ? null : <ProjectHeaderActions projectId={projectId} onError={setProjectActionError} />}
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
      {projectActionError === null ? null : (
        <p className="m-error" role="alert">
          {projectActionError}
        </p>
      )}
      <main className="m-main">
        {route.kind === 'home' ? (
          <HomeScreen tab={homeTab} onTab={setHomeTab} />
        ) : route.kind === 'project' ? (
          <ProjectScreen
            projectId={route.projectId}
            tab={projectTabs[route.projectId] ?? 'sessions'}
            onTab={(next) => setProjectTabs((current) => ({ ...current, [route.projectId]: next }))}
          />
        ) : route.kind === 'council' ? (
          <CouncilScreen key={route.councilId} councilId={route.councilId} />
        ) : (
          <SessionScreen key={route.sessionId} sessionId={route.sessionId} />
        )}
      </main>
    </div>
  );
}
