import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { acquireProjectSlack, getProjectSlack } from './api.ts';
import { useAsyncAction } from './async-action.ts';
import { Backlog } from './backlog/Backlog.tsx';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import { CodeEditor } from './CodeEditor.tsx';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import { Worktrees } from './worktrees/Worktrees.tsx';
import { GitStatus } from './GitStatus.tsx';
import { CommitSettingsDialog } from './CommitSettingsDialog.tsx';
import { CouncilLaunch } from './CouncilLaunch.tsx';
import { isDormant } from '../../shared/sessions.ts';
import { errorMessage } from './format.ts';
import { SessionList } from './SessionList.tsx';
import { NewSessionForm } from './NewSessionForm.tsx';
import { go, href } from './route.ts';
import { useNow, usePolling } from './polling.tsx';
import { PathInput } from './PathInput.tsx';
import { useStore } from './store.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { TabBar, tabIds, useStoredTab } from './TabBar.tsx';
import type { Project, WorkspaceMode } from '../../shared/types.ts';
import type { ProjectSlackStatus } from '../../shared/machine.ts';

const PROJECT_COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f'];

// Projet présent sur plusieurs machines : une seule traite ses commandes Slack. On prend la main, on ne la rend pas.
function SlackLead({ projectId }: { projectId: string }) {
  const { peersVersion } = useStore();
  const [status, setStatus] = useState<ProjectSlackStatus | null>(null);
  const {
    run: acquire,
    busy,
    error,
  } = useAsyncAction(async () => setStatus(await acquireProjectSlack(projectId)), {
    fallback: 'Prise de main impossible',
  });

  // peersVersion relance le cycle : un changement de pairs se voit aussitôt.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dépendance voulue : un nouveau fetcher relance usePolling.
  const load = useCallback(() => getProjectSlack(projectId), [projectId, peersVersion]);
  usePolling(load, 10_000, {
    onData: setStatus,
    onError: () => {
      /* machine sans cette fonctionnalité ou injoignable : garder la dernière valeur */
    },
  });

  if (!status || (!status.shared && !status.conflict)) return null;
  if (status.conflict) {
    return (
      <p className="peer-conflict" role="alert">
        Même nom que sur {status.peerMachine ?? 'une autre machine'}, mais un autre dépôt git : les commandes Slack de
        ce projet sont bloquées sur les deux machines. Renomme l'un des projets.
      </p>
    );
  }

  const local = status.owner === 'local';

  const state = local
    ? `Cette machine traite les commandes Slack (projet aussi présent sur ${status.peerMachine ?? 'une autre machine'}). On ne rend pas la main : prends-la depuis l'autre machine.`
    : status.owner === 'remote'
      ? `Traité par ${status.ownerMachine ?? status.peerMachine ?? 'une autre machine'}. Cocher pour traiter ici les commandes Slack de ce projet.`
      : 'Attribution en cours… Cocher pour traiter ici les commandes Slack de ce projet.';
  return (
    <div className="slack-lead">
      <label className="slack-toggle" title={state}>
        <input
          type="checkbox"
          checked={local}
          disabled={local || busy}
          onChange={() => void acquire()}
          aria-label={state}
        />
        Slack
      </label>
      {error ? <span className="form-error">{error}</span> : null}
    </div>
  );
}

// Choix du dossier de travail des nouvelles conversations : enregistré dès le clic, comme la case Slack.
function WorkspaceModeControl({ project }: { project: Project }) {
  const { updateProject } = useStore();
  const {
    run: save,
    busy,
    error,
  } = useAsyncAction((workspaceMode: WorkspaceMode) => updateProject(project.id, { workspaceMode }), {
    fallback: 'Modification impossible',
  });

  const change = async (workspaceMode: WorkspaceMode): Promise<void> => {
    if (workspaceMode === project.workspaceMode) return;
    await save(workspaceMode);
  };

  return (
    <div
      className="workspace-mode"
      title="Dossier des nouveaux contextes de travail. Les epics déjà commencés conservent leur dossier d’origine, y compris pour les corrections de review."
    >
      <ChoiceGroup<WorkspaceMode>
        compact
        label="Travail des conversations"
        value={project.workspaceMode}
        disabled={busy}
        options={[
          {
            value: 'isolated',
            label: 'Worktree Git par conversation',
            title:
              'Les nouvelles conversations indépendantes utilisent un worktree Git. Les étapes d’un epic commencé continuent dans son dossier d’origine.',
          },
          {
            value: 'shared',
            label: 'Dossier du projet',
            title: `Les nouvelles conversations indépendantes travaillent dans ${project.path}. Les epics déjà commencés conservent leur dossier d’origine.`,
          },
        ]}
        onChange={(mode) => void change(mode)}
      />
      {error ? (
        <span className="form-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

// Onglets de la page projet, dans l'ordre d'affichage. Le dernier ouvert est retenu par ce navigateur.
const PROJECT_TABS = ['sessions', 'backlog', 'worktrees', 'councils'] as const;
type ProjectTab = (typeof PROJECT_TABS)[number];

export function ProjectView({ projectId }: { projectId: string }) {
  const { projects, sessions, tasks, createSession, purgeProjectSessions, deleteProject, updateProject } = useStore();
  const project = projects.find((p) => p.id === projectId);
  const projectSessions = sessions.filter((s) => s.projectId === projectId);
  const now = useNow();
  const dormantCount = projectSessions.filter((s) => !s.protected && isDormant(s, now)).length;
  const hasProtectedSessions = projectSessions.some((s) => s.protected);

  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPath, setEditPath] = useState('');
  const [editColor, setEditColor] = useState<string | null>(null);
  const [editRegenerable, setEditRegenerable] = useState('');
  const { run: saveProject, busy: editBusy } = useAsyncAction(
    async (update: Pick<Project, 'name' | 'path' | 'color' | 'regenerablePaths'>) => {
      await updateProject(projectId, update);
      setEditing(false);
    },
    { fallback: 'Modification impossible', onError: setError },
  );
  const [codeOpen, setCodeOpen] = useState(false);
  const [commitSettingsOpen, setCommitSettingsOpen] = useState(false);
  const [tab, selectTab] = useStoredTab<ProjectTab>('cerebro.project-tab', PROJECT_TABS);
  const openTaskCount = tasks.filter((t) => t.projectId === projectId && t.status !== 'done').length;

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
        setError(errorMessage(err, 'Suppression impossible'));
      }
    })();
  };

  const onPurge = (): void => {
    void purgeProjectSessions(project.id).catch((err: unknown) => {
      setError(errorMessage(err, 'Purge impossible'));
    });
  };

  const startEdit = (): void => {
    setEditName(project.name);
    setEditPath(project.path);
    setEditColor(project.color);
    setEditRegenerable(project.regenerablePaths.join('\n'));
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
    const regenerablePaths = editRegenerable
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    await saveProject({ name, path, color: editColor, regenerablePaths });
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
              <label>
                Chemins régénérables des copies de travail
                <textarea
                  rows={2}
                  value={editRegenerable}
                  placeholder="web/dist"
                  onChange={(e) => setEditRegenerable(e.target.value)}
                />
                <span className="hint">
                  Un chemin par ligne, relatif à la racine du projet : fichiers ignorés par Git qu’une compilation ou
                  une installation recrée. Le retrait d’une copie, nettoyage automatique compris, les supprime sans
                  demander.
                </span>
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
            <div className="project-title-row">
              <h1>
                {project.color ? (
                  <span className="project-color-dot" title="Couleur du projet" aria-hidden="true" />
                ) : null}
                {project.name}
              </h1>
              <span className="path">{project.path}</span>
              <SlackLead key={`slack-${project.id}`} projectId={project.id} />
              <WorkspaceModeControl key={`workspace-${project.id}`} project={project} />
            </div>
          )}
        </div>
        <div className="row-actions">
          <button type="button" className="btn" onClick={() => setCommitSettingsOpen(true)}>
            Réglages LLM
          </button>
          <button type="button" className="btn" onClick={() => setCodeOpen(true)} title="Ouvrir le projet dans VS Code">
            VS Code
          </button>
          {editing ? null : (
            <button type="button" className="btn" onClick={startEdit}>
              Éditer
            </button>
          )}
          <DelayedActionButton
            onAction={onDeleteProject}
            disabled={hasProtectedSessions}
            title={
              hasProtectedSessions
                ? 'Décochez la protection des sessions de ce projet avant de le supprimer.'
                : 'Supprime le projet et ses conversations ; les worktrees restent dans l’inventaire global'
            }
          >
            Supprimer
          </DelayedActionButton>
        </div>
        <div className="project-head-details">
          <ErrorBoundary zone="État Git" resetKey={project.id}>
            <GitStatus key={project.id} projectId={project.id} />
          </ErrorBoundary>
        </div>
      </header>
      {commitSettingsOpen ? (
        <CommitSettingsDialog project={project} onClose={() => setCommitSettingsOpen(false)} />
      ) : null}

      {error ? <p className="form-error">{error}</p> : null}

      <TabBar<ProjectTab>
        idPrefix={`project-${project.id}`}
        label="Sections du projet"
        tabs={[
          { id: 'sessions', label: 'Sessions', count: { value: projectSessions.length, title: 'Sessions du projet' } },
          { id: 'backlog', label: 'Backlog', count: { value: openTaskCount, title: 'Tâches ouvertes' } },
          { id: 'worktrees', label: 'Copies de travail' },
          { id: 'councils', label: 'Council' },
        ]}
        selected={tab}
        onSelect={selectTab}
      />
      <div
        className="view-tab-panel"
        role="tabpanel"
        id={tabIds(`project-${project.id}`, tab).panel}
        aria-labelledby={tabIds(`project-${project.id}`, tab).tab}
      >
        {tab === 'sessions' ? (
          <section className="card project-panel session-table-wrap">
            <div className="project-panel-head">
              <h2>
                Sessions <span className="pill project-panel-count">{projectSessions.length}</span>
              </h2>
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
              key={`new-session-${project.id}`}
              className="project-create"
              heading="Nouvelle session"
              projectId={project.id}
              draftKey={`project.${project.id}`}
              onLaunch={async (spec) => {
                await createSession(project.id, spec);
              }}
            />
            {projectSessions.length === 0 ? (
              <p className="empty-hint">Aucune session pour ce projet.</p>
            ) : (
              <ErrorBoundary zone="Sessions" resetKey={project.id}>
                <SessionList key={`sessions-${project.id}`} sessions={projectSessions} now={now} onError={setError} />
              </ErrorBoundary>
            )}
          </section>
        ) : tab === 'backlog' ? (
          <ErrorBoundary zone="Backlog" resetKey={project.id}>
            <Backlog projectId={project.id} />
          </ErrorBoundary>
        ) : tab === 'worktrees' ? (
          <ErrorBoundary zone="Copies de travail" resetKey={project.id}>
            <Worktrees key={`worktrees-${project.id}`} projectId={project.id} workspaceMode={project.workspaceMode} />
          </ErrorBoundary>
        ) : (
          <section className="card project-panel" aria-label="Council">
            <h2>Council</h2>
            <p className="hint">Soumettez une question à plusieurs conseillers, relus anonymement puis synthétisés.</p>
            <ErrorBoundary zone="Council" resetKey={project.id}>
              <CouncilLaunch projectId={project.id} />
            </ErrorBoundary>
          </section>
        )}
      </div>
    </div>
  );
}
