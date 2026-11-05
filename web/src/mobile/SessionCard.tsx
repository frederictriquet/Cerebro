import { AgentLabel } from '../AgentLabel.tsx';
import { displayStatus, isAwaiting, relativeTime, sessionTitle, STATUS_LABEL } from '../format.ts';
import { useNow } from '../polling.tsx';
import { href } from '../route.ts';
import { attentionTone } from '../SessionMeta.tsx';
import { StatusDot } from '../StatusDot.tsx';
import { useStore } from '../store.tsx';
import type { Session } from '../../../shared/types.ts';

/** Carte d'une session, ouverte au tap. `showProject` : nom du projet dans la ligne de détails. */
export function SessionCard({ session, showProject = false }: { session: Session; showProject?: boolean }) {
  const { projects } = useStore();
  const now = useNow();
  const status = displayStatus(session, now);
  const project = showProject ? projects.find((candidate) => candidate.id === session.projectId) : undefined;
  return (
    <a className="m-card" href={href(`#/s/${session.id}`)}>
      <span className="m-card-head">
        <StatusDot status={status} />
        <span className="m-card-title">{sessionTitle(session.title)}</span>
      </span>
      <span className="m-card-meta">
        {project ? <span>{project.name}</span> : null}
        <AgentLabel agent={session.agent} />
        <span>{STATUS_LABEL[status]}</span>
        <span>{relativeTime(session.updatedAt, now)}</span>
      </span>
      {isAwaiting(session) && session.attentionReason ? (
        <span className={`m-card-reason ${attentionTone(session)}`}>{session.attentionReason}</span>
      ) : null}
    </a>
  );
}
