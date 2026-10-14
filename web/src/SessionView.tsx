import { useEffect, useState } from 'react';
import { AGENT_LABEL, MODE_LABEL, STATUS_LABEL, sessionTitle } from './format.ts';
import { go } from './route.ts';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import { Term } from './Term.tsx';

export function SessionView({ sessionId }: { sessionId: string }) {
  const { sessions, projects, killSession, resumeSession, deleteSession, markSeen } = useStore();
  const session = sessions.find((s) => s.id === sessionId);
  const project = session ? projects.find((p) => p.id === session.projectId) : undefined;
  const [error, setError] = useState<string | null>(null);
  const live = session !== undefined && session.status !== 'exited';

  useEffect(() => {
    void markSeen(sessionId);
  }, [sessionId, markSeen]);

  if (!session) {
    return (
      <div className="pane padded">
        <p className="empty-hint">Session introuvable.</p>
        <a href="#/">Retour</a>
      </div>
    );
  }

  const act = async (fn: () => Promise<unknown>, thenHome = false): Promise<void> => {
    setError(null);
    try {
      await fn();
      if (thenHome) go('#/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action impossible');
    }
  };

  return (
    <div className="pane session-pane">
      <header className="session-head">
        <div className="session-head-main">
          <div className="session-title-row">
            <StatusDot status={session.status} title={STATUS_LABEL[session.status]} />
            <h1>{sessionTitle(session.title)}</h1>
          </div>
          <p className="session-meta">
            <span className="pill">{AGENT_LABEL[session.agent]}</span>
            <span className="pill">{MODE_LABEL[session.mode]}</span>
            <span className={`pill status ${session.status}`}>{STATUS_LABEL[session.status]}</span>
            {project ? (
              <a className="project-crumb" href={`#/p/${project.id}`}>
                {project.name}
              </a>
            ) : null}
            {session.attentionReason ? (
              <span className="reason">{session.attentionReason}</span>
            ) : null}
            {session.status === 'exited' && session.exitCode !== null ? (
              <span className="pill">code {session.exitCode}</span>
            ) : null}
          </p>
        </div>
        <div className="row-actions">
          {session.status !== 'exited' ? (
            <button type="button" className="btn" onClick={() => void act(() => killSession(session.id))}>
              Arrêter
            </button>
          ) : null}
          {session.status === 'exited' && session.agentSessionId ? (
            <button type="button" className="btn primary" onClick={() => void act(() => resumeSession(session.id))}>
              Reprendre
            </button>
          ) : null}
          <button
            type="button"
            className="btn danger-ghost"
            onClick={() => {
              if (!window.confirm(`Supprimer « ${sessionTitle(session.title)} » ?`)) return;
              void act(() => deleteSession(session.id), true);
            }}
          >
            Supprimer
          </button>
        </div>
      </header>
      {error ? <p className="form-error session-error">{error}</p> : null}
      <div className="term-wrap">
        <Term key={`${session.id}:${live ? 'live' : 'exited'}`} sessionId={session.id} />
      </div>
    </div>
  );
}
