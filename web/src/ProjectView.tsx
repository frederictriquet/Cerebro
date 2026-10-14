import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AGENT_LABEL, MODE_LABEL, relativeTime, sessionTitle, STATUS_LABEL } from './format.ts';
import { go, useNow } from './route.ts';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import { isAgent, isMode, MODES, type Agent, type Mode, type Session } from './types.ts';

export function ProjectView({ projectId }: { projectId: string }) {
  const { projects, sessions, agents, createSession, killSession, resumeSession, deleteSession, deleteProject } =
    useStore();
  const project = projects.find((p) => p.id === projectId);
  const kids = sessions.filter((s) => s.projectId === projectId);
  const available = agents.filter((a) => a.available);
  const now = useNow();

  const [agent, setAgent] = useState<Agent>('claude');
  const [mode, setMode] = useState<Mode>('default');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const list = agents.filter((a) => a.available);
    if (list.some((a) => a.agent === agent)) return;
    const first = list[0];
    if (first) setAgent(first.agent);
  }, [agents, agent]);

  if (!project) {
    return (
      <div className="pane padded">
        <p className="empty-hint">Projet introuvable.</p>
        <a href="#/">Retour</a>
      </div>
    );
  }

  const launch = async (): Promise<void> => {
    if (available.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const session = await createSession(project.id, agent, mode, prompt);
      setPrompt('');
      go(`#/s/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lancement impossible');
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void launch();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      void launch();
    }
  };

  const onDeleteProject = (): void => {
    if (!window.confirm(`Supprimer le projet « ${project.name} » et ses sessions ?`)) return;
    void (async () => {
      try {
        await deleteProject(project.id);
        go('#/');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Suppression impossible');
      }
    })();
  };

  return (
    <div className="pane padded">
      <header className="pane-head">
        <div>
          <h1>{project.name}</h1>
          <p className="path">{project.path}</p>
        </div>
        <button type="button" className="btn danger-ghost" onClick={onDeleteProject}>
          Supprimer
        </button>
      </header>

      <form className="card new-session" onSubmit={onSubmit}>
        <h2>Nouvelle session</h2>
        <div className="form-grid">
          <label>
            Agent
            <select
              value={agent}
              onChange={(e) => {
                const v = e.target.value;
                if (isAgent(v)) setAgent(v);
              }}
              disabled={available.length === 0}
            >
              {available.length === 0 ? (
                <option value={agent}>Aucun agent disponible</option>
              ) : (
                available.map((a) => (
                  <option key={a.agent} value={a.agent}>
                    {AGENT_LABEL[a.agent]}
                  </option>
                ))
              )}
            </select>
          </label>
          <label>
            Mode
            <select
              value={mode}
              onChange={(e) => {
                const v = e.target.value;
                if (isMode(v)) setMode(v);
              }}
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {mode === 'bypass' ? (
          <p className="warn-bypass">Mode bypass : permissions et sandbox désactivés.</p>
        ) : null}
        <label className="block">
          Prompt
          <textarea
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ctrl+Entrée pour lancer"
          />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="row-actions">
          <button type="submit" className="btn primary" disabled={busy || available.length === 0}>
            Lancer
          </button>
          <span className="hint">Ctrl+Entrée</span>
        </div>
      </form>

      <section className="session-table-wrap">
        <h2>Sessions</h2>
        {kids.length === 0 ? (
          <p className="empty-hint">Aucune session pour ce projet.</p>
        ) : (
          <ul className="session-table">
            {kids.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                now={now}
                onKill={() => {
                  void killSession(s.id).catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : 'Arrêt impossible');
                  });
                }}
                onResume={() => {
                  void (async () => {
                    try {
                      const live = await resumeSession(s.id);
                      go(`#/s/${live.id}`);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Reprise impossible');
                    }
                  })();
                }}
                onDelete={() => {
                  if (!window.confirm(`Supprimer « ${sessionTitle(s.title)} » ?`)) return;
                  void deleteSession(s.id).catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : 'Suppression impossible');
                  });
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SessionRow({
  session,
  now,
  onKill,
  onResume,
  onDelete,
}: {
  session: Session;
  now: number;
  onKill: () => void;
  onResume: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="session-row">
      <a href={`#/s/${session.id}`} className="session-main">
        <StatusDot status={session.status} title={STATUS_LABEL[session.status]} />
        <span className="session-row-title">{sessionTitle(session.title)}</span>
        <span className="pill">{AGENT_LABEL[session.agent]}</span>
        <span className={`pill status ${session.status}`}>{STATUS_LABEL[session.status]}</span>
        <span className="meta">{relativeTime(session.updatedAt, now)}</span>
      </a>
      <div className="row-actions">
        {session.status !== 'exited' ? (
          <button type="button" className="btn" onClick={onKill}>
            Arrêter
          </button>
        ) : null}
        {session.status === 'exited' && session.agentSessionId ? (
          <button type="button" className="btn" onClick={onResume}>
            Reprendre
          </button>
        ) : null}
        <button type="button" className="btn danger-ghost" onClick={onDelete}>
          Supprimer
        </button>
      </div>
    </li>
  );
}
