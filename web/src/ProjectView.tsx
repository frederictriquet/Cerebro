import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { acquireProjectSlack, getProjectSlack, type ProjectSlackStatus } from './api.ts';
import { Backlog } from './Backlog.tsx';
import { CodeEditor } from './CodeEditor.tsx';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import { Worktrees } from './Worktrees.tsx';
import { GitStatus } from './GitStatus.tsx';
import { CommitSettingsDialog } from './CommitSettingsDialog.tsx';
import { isDormant } from './format.ts';
import { SessionRow } from './SessionRow.tsx';
import { NewSessionForm } from './NewSessionForm.tsx';
import { go, href, useNow } from './route.ts';
import { PathInput } from './PathInput.tsx';
import { useStore } from './store.tsx';

const PROJECT_COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f'];

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
    purgeProjectSessions,
    deleteProject,
    updateProject,
  } = useStore();
  const project = projects.find((p) => p.id === projectId);
  const kids = sessions.filter((s) => s.projectId === projectId);
  const now = useNow();
  const dormantCount = kids.filter((s) => !s.protected && isDormant(s, now)).length;
  const hasProtectedSessions = kids.some((s) => s.protected);

  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPath, setEditPath] = useState('');
  const [editColor, setEditColor] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [commitSettingsOpen,setCommitSettingsOpen]=useState(false);

  useEffect(() => {
    setEditing(false);
    setCodeOpen(false);
    setCommitSettingsOpen(false);
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
        </div>
        <div className="row-actions">
          <button type="button" className="btn" onClick={()=>setCommitSettingsOpen(true)}>Réglages Git</button>
          <button type="button" className="btn" onClick={() => setCodeOpen(true)} title="Ouvrir le projet dans VS Code">
            VS Code
          </button>
          {editing ? null : (
            <button type="button" className="btn" onClick={startEdit}>
              Éditer
            </button>
          )}
          <DelayedActionButton onAction={onDeleteProject} disabled={hasProtectedSessions} title={hasProtectedSessions ? 'Décochez la protection des sessions de ce projet avant de le supprimer.' : 'Supprime le projet et ses conversations ; les worktrees restent dans l’inventaire global'}>
            Supprimer
          </DelayedActionButton>
        </div>
        <div className="project-head-details">
          <GitStatus key={project.id} projectId={project.id} />
          <SlackLead key={`slack-${project.id}`} projectId={project.id} />
        </div>
      </header>
      {commitSettingsOpen?<CommitSettingsDialog project={project} onClose={()=>setCommitSettingsOpen(false)}/>:null}

      {error ? <p className="form-error">{error}</p> : null}

      <Worktrees key={`worktrees-${project.id}`} projectId={project.id} workspaceMode={project.workspaceMode} />
      <div className="project-columns">
        <section className="card project-panel session-table-wrap">
          <div className="project-panel-head">
            <h2>Sessions <span className="pill project-panel-count">{kids.length}</span></h2>
            {dormantCount > 0 ? (
              <DelayedActionButton
                onAction={onPurge}
                title="Supprime les sessions non protégées inactives depuis plus d'une heure ; celles encore ouvertes seront arrêtées"
              >
                Purger les sessions en sommeil ({dormantCount})
              </DelayedActionButton>
            ) : null}
          </div>
          <NewSessionForm
            key={project.id}
            className="project-create"
            heading="Nouvelle session"
            projectId={project.id}
            draftKey={`project.${project.id}`}
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
                  onError={setError}
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
