import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api.ts';
import { Backlog } from './Backlog.tsx';
import { AGENT_LABEL, isAwaiting, relativeTime, sessionTitle, STATUS_LABEL } from './format.ts';
import { NewSessionForm } from './NewSessionForm.tsx';
import { go, href, useNow } from './route.ts';
import { PathInput } from './PathInput.tsx';
import { PreviewButton, ScreenPopover, usePreviewController } from './ScreenPreview.tsx';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import { parseGitInfo, type GitInfo, type Session } from './types.ts';

function formatDirty(count: number): string {
  const n = Math.max(0, Math.trunc(count));
  return n === 1 ? '1 fichier modifié' : `${n} fichiers modifiés`;
}

function GitStatus({ projectId }: { projectId: string }) {
  const [git, setGit] = useState<GitInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGit(null);
    const load = (): void => {
      void (async () => {
        try {
          const raw = await api<unknown>(`/api/projects/${projectId}/git`);
          const parsed = parseGitInfo(raw);
          if (!cancelled && parsed) setGit(parsed);
        } catch {
          /* garder la dernière valeur connue */
        }
      })();
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId]);

  if (!git) return null;
  if (git.branch === null) return <p className="git-line meta">Pas un dépôt git</p>;
  return (
    <p className="git-line">
      <span className="pill">{git.branch}</span>
      <span className={git.dirty > 0 ? 'git-dirty' : 'meta'}>{formatDirty(git.dirty)}</span>
    </p>
  );
}

export function ProjectView({ projectId }: { projectId: string }) {
  const {
    projects,
    sessions,
    createSession,
    killSession,
    resumeSession,
    deleteSession,
    purgeProjectSessions,
    deleteProject,
    updateProject,
    sendSessionInput,
  } = useStore();
  const project = projects.find((p) => p.id === projectId);
  const kids = sessions.filter((s) => s.projectId === projectId);
  const inactiveCount = kids.filter((s) => s.status === 'exited' || s.status === 'idle').length;
  const now = useNow();

  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPath, setEditPath] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  useEffect(() => {
    setEditing(false);
    setError(null);
  }, [projectId]);

  if (!project) {
    return (
      <div className="pane padded">
        <p className="empty-hint">Projet introuvable.</p>
        <a href={href('#/')}>Retour</a>
      </div>
    );
  }

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

  const onPurge = (): void => {
    if (!window.confirm(`Supprimer les ${inactiveCount} session(s) inactive(s) de « ${project.name} » ? Les sessions en attente (idle) seront arrêtées.`)) return;
    void purgeProjectSessions(project.id).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Purge impossible');
    });
  };

  const startEdit = (): void => {
    setEditName(project.name);
    setEditPath(project.path);
    setEditing(true);
    setError(null);
  };

  const onSaveProject = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const name = editName.trim();
    const path = editPath.trim();
    if (name.length === 0 || path.length === 0) {
      setError('Le nom et le chemin sont requis');
      return;
    }
    setEditBusy(true);
    setError(null);
    try {
      await updateProject(project.id, { name, path });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Modification impossible');
    } finally {
      setEditBusy(false);
    }
  };

  return (
    <div className="pane padded">
      <header className="pane-head">
        <div className="pane-head-main">
          {editing ? (
            <form className="edit-project" onSubmit={(e) => void onSaveProject(e)}>
              <label>
                Nom
                <input required value={editName} onChange={(e) => setEditName(e.target.value)} />
              </label>
              <label>
                Chemin
                <PathInput required value={editPath} onChange={setEditPath} />
              </label>
              <div className="row-actions">
                <button type="submit" className="btn primary" disabled={editBusy}>
                  Enregistrer
                </button>
                <button type="button" className="btn" onClick={() => setEditing(false)}>
                  Annuler
                </button>
              </div>
            </form>
          ) : (
            <>
              <h1>{project.name}</h1>
              <p className="path">{project.path}</p>
            </>
          )}
          <GitStatus key={project.id} projectId={project.id} />
        </div>
        <div className="row-actions">
          {editing ? null : (
            <button type="button" className="btn" onClick={startEdit}>
              Éditer
            </button>
          )}
          <button type="button" className="btn danger-ghost" onClick={onDeleteProject}>
            Supprimer
          </button>
        </div>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <NewSessionForm
        key={project.id}
        heading="Nouvelle session"
        projectId={project.id}
        onLaunch={async (agent, mode, prompt) => {
          await createSession(project.id, agent, mode, prompt);
        }}
      />

      <div className="project-columns">
        <section className="session-table-wrap">
          <div className="session-table-head">
            <h2>Sessions</h2>
            {inactiveCount > 0 ? (
              <button type="button" className="btn danger-ghost" onClick={onPurge}>
                Purger les inactives ({inactiveCount})
              </button>
            ) : null}
          </div>
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
                  onInput={(data) => {
                    void sendSessionInput(s.id, data).catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : 'Envoi impossible');
                    });
                  }}
                />
              ))}
            </ul>
          )}
        </section>

        <Backlog projectId={project.id} />
      </div>
    </div>
  );
}

function SessionRow({
  session,
  now,
  onKill,
  onResume,
  onDelete,
  onInput,
}: {
  session: Session;
  now: number;
  onKill: () => void;
  onResume: () => void;
  onDelete: () => void;
  onInput: (data: string) => void;
}) {
  const awaiting = isAwaiting(session);
  const preview = usePreviewController();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tone = session.status === 'waiting' ? 'waiting' : 'idle';

  return (
    <li className="session-row" {...(awaiting ? preview.hoverProps : {})}>
      <div className="session-row-main">
        <a href={href(`#/s/${session.id}`)} className="session-main">
          <span className="session-row-titleline">
            <StatusDot status={session.status} title={STATUS_LABEL[session.status]} />
            <span className="session-row-title">{sessionTitle(session.title)}</span>
          </span>
          <span className="session-row-meta">
            <span className="pill">{AGENT_LABEL[session.agent]}</span>
            <span className={`pill status ${session.status}`}>{STATUS_LABEL[session.status]}</span>
            <span className="meta">{relativeTime(session.updatedAt, now)}</span>
          </span>
        </a>
        {awaiting && session.attentionReason ? (
          <p className={`reason-line ${tone}`}>{session.attentionReason}</p>
        ) : null}
      </div>
      <div className="row-actions">
        {awaiting ? (
          <>
            {session.status !== 'exited' ? (
              <>
                <button type="button" className="btn" onClick={() => onInput('\r')}>
                  Entrée
                </button>
                <button type="button" className="btn" onClick={() => onInput('\x1b')}>
                  Échap
                </button>
              </>
            ) : null}
            <a className="btn" href={href(`#/s/${session.id}`)}>
              Ouvrir
            </a>
            <PreviewButton pressed={preview.open} onToggle={preview.toggle} anchorRef={anchorRef} />
          </>
        ) : null}
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
      {awaiting && preview.open ? (
        <ScreenPopover sessionId={session.id} anchorRef={anchorRef} hoverProps={preview.hoverProps} />
      ) : null}
    </li>
  );
}
