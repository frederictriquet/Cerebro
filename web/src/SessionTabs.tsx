import { useEffect, useRef } from 'react';
import { displayStatus, sessionTitle, STATUS_LABEL } from './format.ts';
import { useNow } from './polling.tsx';
import { href, type Route } from './route.ts';
import { groupedSessionTitle } from './session-groups.ts';
import { attentionTone } from './SessionMeta.tsx';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';

// Rangée affichée sous les onglets de projets quand la session ouverte partage son projet avec d'autres.
// Même ensemble que le compteur de l'onglet projet (sessions terminées comprises), dans l'ordre du store.
// Une seule ligne qui défile : un retour à la ligne prendrait la hauteur du terminal.
export function SessionTabs({ route }: { route: Route }) {
  const { sessions } = useStore();
  const now = useNow();
  const activeTab = useRef<HTMLAnchorElement>(null);
  const current = route.kind === 'session' ? sessions.find((session) => session.id === route.sessionId) : undefined;
  useEffect(() => {
    activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current?.id]);
  if (!current) return null;
  const siblings = sessions.filter((session) => session.projectId === current.projectId);
  if (siblings.length < 2) return null;

  return (
    <nav className="session-tabs" aria-label="Sessions du projet">
      {siblings.map((session) => {
        const active = session.id === current.id;
        const shown = displayStatus(session, now);
        const title = sessionTitle(session.title);
        // Une étape d'epic garde « étape i/n : … » : le préfixe commun à l'epic remplirait l'onglet tronqué.
        const label = groupedSessionTitle(session);
        const reason = session.attention && session.attentionReason ? `\n${session.attentionReason}` : '';
        return (
          <a
            key={session.id}
            ref={active ? activeTab : undefined}
            className={`session-tab${active ? ' active' : ''}${session.attention ? ` alert ${attentionTone(session)}` : ''}`}
            href={href(`#/s/${session.id}`)}
            aria-current={active ? 'page' : undefined}
            title={`${title}${reason}`}
          >
            <StatusDot status={shown} title={STATUS_LABEL[shown]} />
            <span className="session-tab-title">{label}</span>
          </a>
        );
      })}
    </nav>
  );
}
