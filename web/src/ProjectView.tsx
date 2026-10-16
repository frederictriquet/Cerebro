import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { acquireProjectSlack, api, getProjectSlack, type ProjectSlackStatus } from './api.ts';
import { Backlog } from './Backlog.tsx';
import { CodeEditor } from './CodeEditor.tsx';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import { GitActions } from './GitActions.tsx';
import { AGENT_LABEL, displayStatus, isAwaiting, isDormant, relativeTime, sessionTitle, STATUS_LABEL } from './format.ts';
import { NewSessionForm } from './NewSessionForm.tsx';
import { go, href, useNow } from './route.ts';
import { PathInput } from './PathInput.tsx';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import { parseGitInfo, type GitInfo, type Session } from './types.ts';
import { PreviewButton, ScreenPopover, usePreviewController } from './ScreenPreview.tsx';

const PROJECT_COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f'];

function formatDirty(count: number): string {
  const n = Math.max(0, Math.trunc(count));
  return n === 1 ? '1 fichier modifié' : `${n} fichiers modifiés`;
}

function formatAhead(count: number): string {
  return count === 1 ? '1 commit à pousser' : `${count} commits à pousser`;
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
      {git.ahead ? <span className="meta">{formatAhead(git.ahead)}</span> : null}
      {!git.hasUpstream ? <span className="meta">pas d'upstream</span> : null}
      <GitActions projectId={projectId} git={git} />
    </p>
  );
}

// Projet présent sur plusieurs machines : une seule traite ses commandes Slack. On prend la main, on ne la rend pas.
function SlackLead({ projectId }: { projectId: string }) {
  const { peersVersion } = useStore();
  const [status, setStatus] = useState<ProjectSlackStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void getProjectSlack(projectId)
        .then((value) => {
          if (!cancelled) setStatus(value);
        })
        .catch(() => {
          /* machine sans cette fonctionnalité ou injoignable : garder la dernière valeur */
        });
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, peersVersion]);

  if (!status || (!status.shared && !status.conflict)) return null;
  if (status.conflict) {
    return (
      <p className="peer-conflict" role="alert">
        Même nom que sur {status.peerMachine ?? 'une autre machine'}, mais un autre dépôt git : les commandes Slack de ce
        projet sont bloquées sur les deux machines. Renomme l'un des projets.
      </p>
    );
  }

  const local = status.owner === 'local';
  const acquire = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await acquireProjectSlack(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Prise de main impossible');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="slack-lead">
      <label
        className="slack-toggle"
        title={local ? "On ne rend pas la main : prends-la depuis l'autre machine." : 'Traiter ici les commandes Slack de ce projet'}
      >
        <input type="checkbox" checked={local} disabled={local || busy} onChange={() => void acquire()} />
        Slack
      </label>
      <span className="meta">
        {local
          ? `Cette machine traite les commandes Slack (projet aussi présent sur ${status.peerMachine ?? 'une autre machine'})`
          : status.owner === 'remote'
            ? `Traité par ${status.ownerMachine ?? status.peerMachine ?? 'une autre machine'}`
            : 'Attribution en cours…'}
      </span>
      {error ? <span className="form-error">{error}</span> : null}
    </div>
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
  const now = useNow();
  const dormantCount = kids.filter((s) => isDormant(s, now)).length;

  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPath, setEditPath] = useState('');
  const [editColor, setEditColor] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);

  useEffect(() => {
    setEditing(false);
    setCodeOpen(false);
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
    void purgeProjectSessions(project.id).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Purge impossible');
    });
  };

  const startEdit = (): void => {
    setEditName(project.name);
    setEditPath(project.path);
    setEditColor(project.color);
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
      await updateProject(project.id, { name, path, color: editColor });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Modification impossible');
    } finally {
      setEditBusy(false);
    }
  };

  if (codeOpen) return <CodeEditor project={project} onClose={() => setCodeOpen(false)} />;

  return (
    <div className="pane padded">
      <header
        className={project.color ? 'pane-head project-head colored' : 'pane-head project-head'}
        style={project.color ? ({ '--project-color': project.color } as CSSProperties) : undefined}
      >
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
              <div className="color-field">
                <span>Couleur</span>
                <div className="color-swatches">
                  {PROJECT_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={editColor === color ? 'color-swatch selected' : 'color-swatch'}
                      style={{ background: color }}
                      title={color}
                      aria-label={`Couleur ${color}`}
                      onClick={() => setEditColor(color)}
                    />
                  ))}
                  <input
                    type="color"
                    className="color-custom"
                    title="Couleur personnalisée"
                    value={editColor ?? '#888888'}
                    onChange={(e) => setEditColor(e.target.value)}
                  />
                  <button
                    type="button"
                    className={editColor === null ? 'color-swatch none selected' : 'color-swatch none'}
                    title="Aucune couleur"
                    aria-label="Aucune couleur"
                    onClick={() => setEditColor(null)}
                  />
                </div>
              </div>
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
              <h1>
                {project.color ? <span className="project-color-dot" title="Couleur du projet" aria-hidden="true" /> : null}
                {project.name}
              </h1>
              <p className="path">{project.path}</p>
            </>
          )}
          <GitStatus key={project.id} projectId={project.id} />
          <SlackLead key={`slack-${project.id}`} projectId={project.id} />
        </div>
        <div className="row-actions">
          <button type="button" className="btn" onClick={() => setCodeOpen(true)} title="Ouvrir le projet dans VS Code">
            VS Code
          </button>
          {editing ? null : (
            <button type="button" className="btn" onClick={startEdit}>
              Éditer
            </button>
          )}
          <DelayedActionButton onAction={onDeleteProject} title="Supprime le projet et toutes ses sessions">
            Supprimer
          </DelayedActionButton>
        </div>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="project-columns">
        <section className="session-table-wrap">
          <div className="session-table-head">
            <h2>Sessions</h2>
            {dormantCount > 0 ? (
              <DelayedActionButton
                onAction={onPurge}
                title="Supprime les sessions inactives depuis plus d'une heure ; celles encore ouvertes seront arrêtées"
              >
                Purger les sessions en sommeil ({dormantCount})
              </DelayedActionButton>
            ) : null}
          </div>
          <NewSessionForm
            key={project.id}
            heading="Nouvelle session"
            projectId={project.id}
            onLaunch={async (spec) => {
              await createSession(project.id, spec);
            }}
          />
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
  const shown = displayStatus(session, now);

  return (
    <li className="session-row">
      <div className="session-row-main">
        <a href={href(`#/s/${session.id}`)} className="session-main">
          <span className="session-row-titleline">
            <StatusDot status={shown} title={STATUS_LABEL[shown]} />
            <span className="session-row-title">{sessionTitle(session.title)}</span>
          </span>
          <span className="session-row-meta">
            <span className="pill">{AGENT_LABEL[session.agent]}</span>
            <span className={`pill status ${shown}`}>{STATUS_LABEL[shown]}</span>
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
        <DelayedActionButton onAction={onDelete}>Supprimer</DelayedActionButton>
      </div>
      {awaiting && preview.open ? <ScreenPopover sessionId={session.id} anchorRef={anchorRef} /> : null}
    </li>
  );
}
