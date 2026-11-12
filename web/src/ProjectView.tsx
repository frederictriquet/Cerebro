import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { acquireProjectSlack, getProjectSlack } from './api.ts';
import { useAsyncAction } from './async-action.ts';
import { Backlog } from './backlog/Backlog.tsx';
import { CodeEditor } from './CodeEditor.tsx';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import { Worktrees } from './worktrees/Worktrees.tsx';
import { GitStatus } from './GitStatus.tsx';
import { ProjectSettings } from './ProjectSettings.tsx';
import { CouncilLaunch } from './CouncilLaunch.tsx';
import { isDormant } from '../../shared/sessions.ts';
import { errorMessage } from './format.ts';
import { SessionList } from './SessionList.tsx';
import { SlackWatches } from './SlackWatches.tsx';
import { WorkspaceModeControl } from './WorkspaceModeControl.tsx';
import { NewSessionForm } from './NewSessionForm.tsx';
import { go, href } from './route.ts';
import { useNow, usePolling } from './polling.tsx';
import { ProjectPin } from './ProjectPin.tsx';
import { useStore } from './store.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { TabBar, tabIds, useStoredTab } from './TabBar.tsx';

import type { ProjectSlackStatus } from '../../shared/machine.ts';

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

// Onglets de la page projet, dans l'ordre d'affichage. Le dernier ouvert est retenu par ce navigateur.
const PROJECT_TABS = ['sessions', 'backlog', 'worktrees', 'councils', 'settings'] as const;
type ProjectTab = (typeof PROJECT_TABS)[number];

export function ProjectView({ projectId }: { projectId: string }) {
  const { projects, sessions, tasks, createSession, purgeProjectSessions } = useStore();
  const project = projects.find((p) => p.id === projectId);
  const projectSessions = sessions.filter((s) => s.projectId === projectId);
  const now = useNow();
  const dormantCount = projectSessions.filter((s) => !s.protected && isDormant(s, now)).length;
  const hasProtectedSessions = projectSessions.some((s) => s.protected);

  const [error, setError] = useState<string | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [tab, selectTab] = useStoredTab<ProjectTab>('cerebro.project-tab', PROJECT_TABS);
  const openTaskCount = tasks.filter((t) => t.projectId === projectId && t.status !== 'done').length;

  useEffect(() => {
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

  const onPurge = (): void => {
    void purgeProjectSessions(project.id).catch((err: unknown) => {
      setError(errorMessage(err, 'Purge impossible'));
    });
  };

  if (codeOpen) return <CodeEditor project={project} onClose={() => setCodeOpen(false)} />;

  return (
    <div className="pane padded">
      <header
        className={project.color ? 'pane-head project-head colored' : 'pane-head project-head'}
        style={project.color ? ({ '--project-color': project.color } as CSSProperties) : undefined}
      >
        <div className="pane-head-main">
          <div className="project-title-row">
            <h1>
              {project.color ? (
                <span className="project-color-dot" title="Couleur du projet" aria-hidden="true" />
              ) : null}
              {project.name}
            </h1>
            <ProjectPin project={project} onError={setError} />
            <span className="path">{project.path}</span>
            <SlackLead key={`slack-${project.id}`} projectId={project.id} />
          </div>
        </div>
        <div className="row-actions">
          <button type="button" className="btn" onClick={() => setCodeOpen(true)} title="Ouvrir le projet dans VS Code">
            VS Code
          </button>
        </div>
        <div className="project-head-details">
          <ErrorBoundary zone="État Git" resetKey={project.id}>
            <GitStatus key={project.id} projectId={project.id} />
          </ErrorBoundary>
        </div>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <TabBar<ProjectTab>
        idPrefix={`project-${project.id}`}
        label="Sections du projet"
        tabs={[
          { id: 'sessions', label: 'Sessions', count: { value: projectSessions.length, title: 'Sessions du projet' } },
          { id: 'backlog', label: 'Backlog', count: { value: openTaskCount, title: 'Tâches ouvertes' } },
          { id: 'worktrees', label: 'Copies de travail' },
          { id: 'councils', label: 'Council' },
          { id: 'settings', label: 'Réglages' },
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
          <>
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
                oneLine
                extraChoices={<WorkspaceModeControl key={`workspace-${project.id}`} project={project} />}
                onLaunch={async (spec) => {
                  // Seul ce formulaire ouvre la session lancée ; les lancements en arrière-plan restent sur place.
                  const session = await createSession(project.id, spec);
                  go(`#/s/${session.id}`);
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
            <ErrorBoundary zone="Fils Slack surveillés" resetKey={project.id}>
              <SlackWatches sessions={projectSessions} showSession />
            </ErrorBoundary>
          </>
        ) : tab === 'backlog' ? (
          <ErrorBoundary zone="Backlog" resetKey={project.id}>
            <Backlog projectId={project.id} />
          </ErrorBoundary>
        ) : tab === 'worktrees' ? (
          <ErrorBoundary zone="Copies de travail" resetKey={project.id}>
            <Worktrees key={`worktrees-${project.id}`} projectId={project.id} workspaceMode={project.workspaceMode} />
          </ErrorBoundary>
        ) : tab === 'councils' ? (
          <section className="card project-panel" aria-label="Council">
            <h2>Council</h2>
            <p className="hint">Soumettez une question à plusieurs conseillers, relus anonymement puis synthétisés.</p>
            <ErrorBoundary zone="Council" resetKey={project.id}>
              <CouncilLaunch projectId={project.id} />
            </ErrorBoundary>
          </section>
        ) : (
          <ErrorBoundary zone="Réglages" resetKey={project.id}>
            <ProjectSettings key={project.id} project={project} hasProtectedSessions={hasProtectedSessions} />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
