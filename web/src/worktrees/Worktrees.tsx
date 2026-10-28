import { useState } from 'react';
import type { WorkspaceMode } from '../../../shared/types.ts';
import {
  parsePreparedWorktreeOperation,
  type StartingContentDiscard,
  type WorktreeView,
} from '../../../shared/worktrees.ts';
import { api, apiBase, apiParsed, ApiError } from '../api.ts';
import { useAsyncAction } from '../async-action.ts';
import { AutomaticCommitDialog } from '../AutomaticCommitDialog.tsx';
import { errorMessage } from '../format.ts';
import { useStore } from '../store.tsx';
import '../worktrees.css';
import { CleanedHistory } from './CleanedHistory.tsx';
import { ConfirmationDialog } from './ConfirmationDialog.tsx';
import { copyTitle, type Confirmation, type Resolver, type Reviewed, type WorktreeActions } from './model.ts';
import { OtherWorktrees } from './OtherWorktrees.tsx';
import { StartingContentDialog } from './StartingContentDialog.tsx';
import { useWorktreeInventory } from './useWorktreeInventory.ts';
import { WorktreeRow } from './WorktreeRow.tsx';

/** Keep preserved work visible, without presenting the main repository as another pending session. */
export function Worktrees({ projectId, workspaceMode }: { projectId?: string; workspaceMode?: WorkspaceMode }) {
  const path = projectId ? `/api/projects/${projectId}/worktrees` : '/api/worktrees';
  const machineBase = apiBase();
  // Another machine or scope starts from a fresh panel: no dialog, result or error of the previous one is kept.
  return (
    <WorktreesPanel
      key={`${machineBase}|${path}`}
      path={path}
      machineBase={machineBase}
      projectId={projectId}
      workspaceMode={workspaceMode}
    />
  );
}

function WorktreesPanel({
  path,
  machineBase,
  projectId,
  workspaceMode,
}: {
  path: string;
  machineBase: string;
  projectId?: string;
  workspaceMode?: WorkspaceMode;
}) {
  const {
    inventory: visibleInventory,
    loadError,
    refresh,
    forget,
  } = useWorktreeInventory(path, machineBase, projectId);
  /** One Git action on a copy at a time: it locks the panel and its error replaces the previous one. */
  const { run: perform, busy, error, setError } = useAsyncAction((action: () => Promise<void>) => action());
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [discarding, setDiscarding] = useState<WorktreeView | null>(null);
  const [results, setResults] = useState<Map<string, StartingContentDiscard>>(() => new Map());
  const [resolvers, setResolvers] = useState<Map<string, Resolver>>(() => new Map());
  const [committing, setCommitting] = useState<{ view: WorktreeView; reviewed?: Reviewed } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const { projects, updateProject } = useStore();
  // No apiBase() check after the requests: switching machines remounts the whole tree (StoreProvider keyed by machine).
  const prepare = async (view: WorktreeView, kind: 'merge' | 'remove', deleteIgnored = false): Promise<void> => {
    await perform(async () => {
      const prepared = await apiParsed(`/api/worktrees/${view.id}/prepare-${kind}`, parsePreparedWorktreeOperation, {
        method: 'POST',
        body: JSON.stringify({ deleteIgnored }),
      });
      // The preparation is the reference: files declared regenerable meanwhile no longer need a confirmation.
      setConfirmation({ kind, ...prepared, deleteIgnored: deleteIgnored && !!prepared.view.ignored });
    });
  };
  /** After a removal, started here or by the automatic cleanup: the copy leaves the list once Git is done. */
  const settle = async (): Promise<void> => {
    setConfirmation(null);
    await refresh();
    window.setTimeout(() => void refresh(), 500);
  };
  /**
   * Declares an ignored entry regenerable for the project of the copy. The server then retries its automatic cleanup:
   * a copy whose conversation is over goes by itself, preparing its removal here would only race with it.
   */
  const declareRegenerable = async (view: WorktreeView, entry: string): Promise<void> => {
    const project = projects.find((item) => item.id === view.projectId);
    if (!project) return;
    const declared = await perform(async () => {
      await updateProject(project.id, {
        regenerablePaths: [...project.regenerablePaths, entry.replace(/\/$/, '')],
      });
    });
    if (!declared) return;
    if (!view.session || view.session.status === 'exited') await settle();
    else await prepare(view, 'remove', true);
  };
  const run = async (): Promise<void> => {
    if (!confirmation) return;
    const { view, kind, token } = confirmation;
    await perform(async () => {
      try {
        await api(`/api/worktrees/${view.id}/${kind}`, { method: 'POST', body: JSON.stringify({ token }) });
      } catch (cause) {
        // Already removed, by the automatic cleanup for instance: what the confirmation asked for is done.
        if (!(cause instanceof ApiError && cause.status === 410)) throw cause;
      }
      await settle();
    });
  };
  /** A synchronous Git action on one copy, followed by a refresh. */
  const act = async (view: WorktreeView, action: string): Promise<void> => {
    await perform(async () => {
      await api(`/api/worktrees/${view.id}/${action}`, { method: 'POST' });
      await refresh();
    });
  };
  const chooseTarget = async (view: WorktreeView, branch: string): Promise<void> => {
    await perform(async () => {
      await api(`/api/worktrees/${view.id}/target`, { method: 'PATCH', body: JSON.stringify({ branch }) });
      await refresh();
    });
  };
  const toggle = (id: string): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const open = (id: string): void => setExpanded((current) => new Set(current).add(id));
  const forgetHistory = async (ids: string[]): Promise<void> => {
    setError(null);
    try {
      await forget(ids);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const actions: WorktreeActions = {
    prepare,
    act,
    chooseTarget,
    discard: setDiscarding,
    commit: (view, reviewed) => setCommitting({ view, reviewed }),
    open,
    toggle,
  };
  const copies = visibleInventory?.worktrees.filter((view) => view.managed && !view.primary) ?? [];
  const other = visibleInventory?.worktrees.filter((view) => !view.managed || view.primary) ?? [];
  // Missing from servers older than automatic cleanup.
  const cleaned = visibleInventory?.cleaned ?? [];
  const inventoryErrors = visibleInventory?.errors ?? [];
  const historyOnly =
    !!projectId &&
    workspaceMode === 'shared' &&
    !!visibleInventory &&
    copies.length === 0 &&
    other.every((view) => view.primary) &&
    !loadError &&
    !inventoryErrors.length;
  // A shared project usually shows nothing: until its inventory is known, stay hidden rather than appear then vanish.
  if (projectId && workspaceMode === 'shared' && !visibleInventory && !loadError && !error) return null;
  if (
    projectId &&
    workspaceMode === 'shared' &&
    visibleInventory &&
    copies.length === 0 &&
    cleaned.length === 0 &&
    other.every((view) => view.primary) &&
    !loadError &&
    !error &&
    !inventoryErrors.length
  )
    return null;
  return (
    <section className="card worktrees-panel" aria-label="Copies de travail des conversations">
      {!historyOnly ? (
        <>
          <div className="worktrees-heading">
            <h2>
              Copies de travail <span className="pill">{visibleInventory ? copies.length : '…'}</span>
            </h2>
            <button type="button" className="btn" onClick={() => void refresh()}>
              Actualiser
            </button>
          </div>
          <p className="worktrees-explanation">
            {workspaceMode === 'shared'
              ? 'Ce projet utilise directement son dossier. Ses anciennes copies isolées restent accessibles ici.'
              : 'Chaque conversation travaille dans sa copie, sur sa propre branche. Pour récupérer son travail : l’enregistrer (commit) dans la copie, régler les conflits éventuels avec la branche du projet, l’intégrer, puis le publier avec « Push ». Une copie sans rien à conserver est nettoyée automatiquement à la fin de sa conversation.'}
          </p>
        </>
      ) : null}
      {loadError ? (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {inventoryErrors.map((message, index) => (
        <p className="form-error" key={`${index}:${message}`}>
          {message}
        </p>
      ))}
      {!historyOnly && visibleInventory && copies.length === 0 ? (
        <p className="empty-hint">Aucune copie de conversation à traiter.</p>
      ) : null}
      <ul className="worktree-list">
        {copies.map((view) => (
          <WorktreeRow
            key={view.id}
            view={view}
            showProject={!projectId}
            locked={busy}
            showDetails={expanded.has(view.id)}
            result={results.get(view.id)}
            resolver={resolvers.get(view.id)}
            actions={actions}
          />
        ))}
      </ul>
      {cleaned.length ? (
        <CleanedHistory cleaned={cleaned} historyOnly={historyOnly} showProject={!projectId} forget={forgetHistory} />
      ) : null}
      {!historyOnly && other.length ? (
        <OtherWorktrees other={other} showProject={!projectId} onCommit={(view) => setCommitting({ view })} />
      ) : null}
      {confirmation ? (
        <ConfirmationDialog
          key={confirmation.token}
          confirmation={confirmation}
          busy={busy}
          error={error}
          canDeclare={projects.some((item) => item.id === confirmation.view.projectId)}
          onDeclare={(entry) => void declareRegenerable(confirmation.view, entry)}
          onConfirm={() => void run()}
          onClose={() => setConfirmation(null)}
        />
      ) : null}
      {discarding && visibleInventory ? (
        <StartingContentDialog
          view={discarding}
          onClose={() => setDiscarding(null)}
          onDone={(result) => {
            setResults((current) => new Map(current).set(discarding.id, result));
            setDiscarding(null);
            open(discarding.id);
            void refresh();
          }}
          onResolving={(session) => {
            setResolvers((current) => new Map(current).set(discarding.id, session));
            setDiscarding(null);
            open(discarding.id);
            void refresh();
          }}
        />
      ) : null}
      {committing && visibleInventory ? (
        <AutomaticCommitDialog
          projectId={committing.view.projectId ?? ''}
          reviewed={committing.reviewed}
          endpoint={committing.view.primary ? undefined : `/api/worktrees/${committing.view.id}/git`}
          push={committing.view.primary}
          scopeLabel={
            committing.view.primary
              ? 'Tous les changements du dossier partagé du projet'
              : `Fichiers vérifiables de la copie · ${copyTitle(committing.view)}`
          }
          onClose={() => {
            setCommitting(null);
            void refresh();
          }}
        />
      ) : null}
    </section>
  );
}
