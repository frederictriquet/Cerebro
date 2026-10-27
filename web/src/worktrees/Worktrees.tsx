import { useState } from 'react';
import type { WorktreeView } from '../../../server/worktrees.ts';
import { api, apiBase } from '../api.ts';
import { AutomaticCommitDialog } from '../AutomaticCommitDialog.tsx';
import type { WorkspaceMode } from '../types.ts';
import '../worktrees.css';
import { CleanedHistory } from './CleanedHistory.tsx';
import { ConfirmationDialog } from './ConfirmationDialog.tsx';
import {
  copyTitle,
  type Confirmation,
  type DiscardResult,
  type Resolver,
  type Reviewed,
  type WorktreeActions,
} from './model.ts';
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
  const { inventory: visibleInventory, loadError, refresh, forget } = useWorktreeInventory(path, machineBase);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [discarding, setDiscarding] = useState<WorktreeView | null>(null);
  const [results, setResults] = useState<Map<string, DiscardResult>>(() => new Map());
  const [resolvers, setResolvers] = useState<Map<string, Resolver>>(() => new Map());
  const [committing, setCommitting] = useState<{ view: WorktreeView; reviewed?: Reviewed } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** One Git action on a copy at a time: it locks the panel and its error replaces the previous one. */
  const perform = async (view: WorktreeView, action: () => Promise<void>): Promise<void> => {
    if (apiBase() !== machineBase) return;
    setBusy(view.id);
    setError(null);
    try {
      await action();
    } catch (cause) {
      if (apiBase() === machineBase) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (apiBase() === machineBase) setBusy(null);
    }
  };
  const prepare = (view: WorktreeView, kind: 'merge' | 'remove'): Promise<void> =>
    perform(view, async () => {
      const prepared = await api<{ token: string; view: WorktreeView }>(`/api/worktrees/${view.id}/prepare-${kind}`, {
        method: 'POST',
      });
      if (apiBase() === machineBase) setConfirmation({ kind, ...prepared, machineBase });
    });
  const run = async (): Promise<void> => {
    if (!confirmation || confirmation.machineBase !== apiBase()) return;
    const { view, kind, token } = confirmation;
    await perform(view, async () => {
      await api(`/api/worktrees/${view.id}/${kind}`, { method: 'POST', body: JSON.stringify({ token }) });
      if (apiBase() !== machineBase) return;
      setConfirmation(null);
      await refresh();
      window.setTimeout(() => void refresh(), 500);
    });
  };
  /** A synchronous Git action on one copy, followed by a refresh. */
  const act = (view: WorktreeView, action: string): Promise<void> =>
    perform(view, async () => {
      await api(`/api/worktrees/${view.id}/${action}`, { method: 'POST' });
      if (apiBase() === machineBase) await refresh();
    });
  const chooseTarget = (view: WorktreeView, branch: string): Promise<void> =>
    perform(view, async () => {
      await api(`/api/worktrees/${view.id}/target`, { method: 'PATCH', body: JSON.stringify({ branch }) });
      if (apiBase() === machineBase) await refresh();
    });
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
      if (apiBase() === machineBase) setError(cause instanceof Error ? cause.message : String(cause));
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
  const historyOnly =
    !!projectId &&
    workspaceMode === 'shared' &&
    !!visibleInventory &&
    copies.length === 0 &&
    other.every((view) => view.primary) &&
    !loadError &&
    !visibleInventory.errors.length;
  if (
    projectId &&
    workspaceMode === 'shared' &&
    visibleInventory &&
    copies.length === 0 &&
    cleaned.length === 0 &&
    other.every((view) => view.primary) &&
    !loadError &&
    !error &&
    !visibleInventory.errors.length
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
      {visibleInventory?.errors.map((message) => (
        <p className="form-error" key={message}>
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
            locked={busy !== null}
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
      {confirmation && confirmation.machineBase === machineBase ? (
        <ConfirmationDialog
          confirmation={confirmation}
          busy={busy !== null}
          error={error}
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
