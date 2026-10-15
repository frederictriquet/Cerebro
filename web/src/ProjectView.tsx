import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { api, clipboardImage, uploadProjectImage } from './api.ts';
import { AttachmentStrip, insertToken, removeToken, useImageAttachments } from './attachments.tsx';
import { AGENT_LABEL, isAwaiting, MODE_CHIP, relativeTime, sessionTitle, STATUS_LABEL } from './format.ts';
import { go, useNow } from './route.ts';
import { PathInput } from './PathInput.tsx';
import { PreviewButton, ScreenPopover, usePreviewController } from './ScreenPreview.tsx';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import { MODES, parseGitInfo, type Agent, type GitInfo, type Mode, type Session } from './types.ts';

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
    agents,
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
  const available = agents.filter((a) => a.available);
  const now = useNow();

  const [agent, setAgent] = useState<Agent>('claude');
  const [mode, setMode] = useState<Mode>('auto');
  const [prompt, setPrompt] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const images = useImageAttachments((image) => uploadProjectImage(projectId, image));

  // Image collée ou déposée : « [Image #N] » est inséré au curseur, et remplacé par le chemin
  // du fichier au lancement (les agents lisent les images référencées par chemin).
  const attachImage = (image: File): void => {
    const el = promptRef.current;
    const start = el?.selectionStart ?? prompt.length;
    const end = el?.selectionEnd ?? prompt.length;
    const token = images.add(image, (failed, message) => {
      setPrompt((current) => removeToken(current, failed));
      setError(`Image non envoyée : ${message}`);
    });
    setPrompt((current) => insertToken(current, start, end, token));
  };
  const onPromptPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const image = clipboardImage(event.clipboardData);
    if (image === null) return;
    event.preventDefault();
    attachImage(image);
  };
  const onPromptDrop = (event: DragEvent<HTMLTextAreaElement>): void => {
    const image = clipboardImage(event.dataTransfer);
    if (image === null) return;
    event.preventDefault();
    attachImage(image);
  };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPath, setEditPath] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  useEffect(() => {
    const list = agents.filter((a) => a.available);
    if (list.some((a) => a.agent === agent)) return;
    const first = list[0];
    if (first) setAgent(first.agent);
  }, [agents, agent]);

  useEffect(() => {
    setEditing(false);
    setError(null);
  }, [projectId]);

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
      await createSession(project.id, agent, mode, images.expand(prompt));
      setPrompt('');
      images.reset();
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

      <form className="card new-session" onSubmit={onSubmit}>
        <h2>Nouvelle session</h2>
        <div className="form-grid">
          <div className="field">
            <span className="field-label">Agent</span>
            {available.length === 0 ? (
              <p className="muted">Aucun agent disponible</p>
            ) : (
              <ChoiceGroup
                label="Agent"
                value={agent}
                options={available.map((a) => ({ value: a.agent, label: AGENT_LABEL[a.agent] }))}
                onChange={setAgent}
              />
            )}
          </div>
          <div className="field">
            <span className="field-label">Mode</span>
            <ChoiceGroup
              label="Mode"
              value={mode}
              options={MODES.map((m) => ({ value: m, label: MODE_CHIP[m], danger: m === 'bypass' }))}
              onChange={setMode}
            />
          </div>
        </div>
        {mode === 'bypass' ? (
          <p className="warn-bypass">Mode bypass : permissions et sandbox désactivés.</p>
        ) : null}
        <label className="block">
          Prompt
          <textarea
            rows={5}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              images.prune(e.target.value);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPromptPaste}
            onDrop={onPromptDrop}
            ref={promptRef}
            placeholder="Ctrl+Entrée pour lancer · Ctrl+V ou glisser-déposer pour joindre une image"
          />
          <AttachmentStrip
            items={images.items}
            onRemove={(item) => {
              images.remove(item.n);
              setPrompt((current) => removeToken(current, item.token));
            }}
          />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="row-actions">
          <button type="submit" className="btn primary" disabled={busy || images.pending || available.length === 0}>
            Lancer
          </button>
          <span className="hint">Ctrl+Entrée</span>
        </div>
      </form>

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
        <a href={`#/s/${session.id}`} className="session-main">
          <StatusDot status={session.status} title={STATUS_LABEL[session.status]} />
          <span className="session-row-title">{sessionTitle(session.title)}</span>
          <span className="pill">{AGENT_LABEL[session.agent]}</span>
          <span className={`pill status ${session.status}`}>{STATUS_LABEL[session.status]}</span>
          <span className="meta">{relativeTime(session.updatedAt, now)}</span>
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
            <a className="btn" href={`#/s/${session.id}`}>
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
