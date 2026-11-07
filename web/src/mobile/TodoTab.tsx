import { useStore } from '../store.tsx';
import type { Session } from '../../../shared/types.ts';
import { SessionCard } from './SessionCard.tsx';
import { todoSessions } from './todo.ts';

function Section({ id, title, sessions }: { id: string; title: string; sessions: Session[] }) {
  if (sessions.length === 0) return null;
  return (
    <section className="m-section" aria-labelledby={id}>
      <h3 className="m-section-title" id={id}>
        {title}
      </h3>
      <ul className="m-list">
        {sessions.map((session) => (
          <li key={session.id}>
            <SessionCard session={session} showProject />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Onglet « À traiter » de l'accueil : sessions de tous les projets qui attendent, puis celles en cours. */
export function TodoTab() {
  const { sessions, hasData } = useStore();
  if (!hasData) return <p className="m-hint">Chargement…</p>;
  const { awaiting, running } = todoSessions(sessions);
  if (awaiting.length === 0 && running.length === 0) return <p className="m-hint">Rien à traiter.</p>;
  return (
    <>
      <Section id="m-todo-awaiting" title="En attente" sessions={awaiting} />
      <Section id="m-todo-running" title="En cours" sessions={running} />
    </>
  );
}
