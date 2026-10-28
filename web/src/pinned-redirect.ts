import { useLayoutEffect, useRef } from 'react';
import { replaceRoute, type Route } from './route.ts';
import { useStore } from './store.tsx';

/**
 * Arriver sur un projet dont une session est épinglée ouvre cette session, sauf en venant d'elle :
 * depuis la session épinglée, le lien du projet (onglet, fil d'Ariane, Échap) mène bien à sa page.
 * La décision est prise une fois par arrivée, après le premier snapshot : épingler depuis la page
 * du projet n'en fait pas sortir.
 */
export function usePinnedSessionRedirect(route: Route): void {
  const { sessions, loaded } = useStore();
  const projectId = route.kind === 'project' ? route.projectId : null;
  const sessionId = route.kind === 'session' ? route.sessionId : null;
  // Session affichée avant la route courante, quand celle-ci n'est pas une page de projet.
  const previousSession = useRef<string | null>(null);
  const shownProject = useRef<string | null>(null);
  // Arrivée sur un projet en attente du snapshot pour être tranchée.
  const arrival = useRef<{ projectId: string; from: string | null } | null>(null);

  // Avant l'affichage : la page du projet ne clignote pas avant la redirection.
  useLayoutEffect(() => {
    if (projectId === null) {
      shownProject.current = null;
      arrival.current = null;
      previousSession.current = sessionId;
      return;
    }
    if (shownProject.current !== projectId) {
      shownProject.current = projectId;
      arrival.current = { projectId, from: previousSession.current };
      previousSession.current = null;
    }
    const pending = arrival.current;
    if (pending === null || !loaded) return;
    arrival.current = null;
    const pinned = sessions.find((session) => session.projectId === pending.projectId && session.pinned);
    if (pinned !== undefined && pinned.id !== pending.from) replaceRoute(`#/s/${pinned.id}`);
  }, [projectId, sessionId, loaded, sessions]);
}
