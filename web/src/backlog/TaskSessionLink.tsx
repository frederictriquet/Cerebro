import type { Session } from '../../../shared/types.ts';
import { STATUS_LABEL, sessionTitle } from '../format.ts';
import { href } from '../route.ts';
import { StatusDot } from '../StatusDot.tsx';

// Session qui traite une tâche ou un epic : son statut et un lien vers son terminal.
export function TaskSessionLink({ session }: { session: Session }) {
  return (
    <a className="task-session" href={href(`#/s/${session.id}`)} title={STATUS_LABEL[session.status]}>
      <StatusDot status={session.status} title={STATUS_LABEL[session.status]} />
      {sessionTitle(session.title)}
    </a>
  );
}
