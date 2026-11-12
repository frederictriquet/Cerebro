import { AgentLabel } from '../AgentLabel.tsx';
import { AttentionDetail } from '../AttentionDetail.tsx';
import { displayStatus, isAwaiting, relativeTime, sessionTitle, STATUS_LABEL } from '../format.ts';
import { useNow } from '../polling.tsx';
import { href } from '../route.ts';
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
    <div className="m-card">
      <a className="m-card-link" href={href(`#/s/${session.id}`)}>
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
      </a>
      {/* Hors du lien : les boutons de réponse ne doivent pas ouvrir la session. */}
      {isAwaiting(session) && (session.attentionReason || session.attentionDetail) ? (
        <AttentionDetail session={session} reason={session.attentionReason} withKeys />
      ) : null}
    </div>
  );
}
