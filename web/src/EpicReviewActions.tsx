import { useState } from 'react';
import { isReviewTask } from '../../shared/epic-review.ts';
import { LaunchSessionDialog } from './Dialog.tsx';
import { useStore } from './store.tsx';
import { errorMessage } from './format.ts';
import { isActiveRun, type EpicRun } from '../../shared/backlog.ts';

// « Review de l'epic » et « Ajouter une étape de review » : partagés par le bloc du backlog et l'en-tête du groupe de sessions.
export function EpicReviewActions({
  epic,
  run,
  onError,
}: {
  epic: { id: string; projectId: string; title: string };
  run: EpicRun | null;
  onError: (message: string) => void;
}) {
  const { tasks, projects, addEpicReviewTask, startEpicReview } = useStore();
  const [reviewing, setReviewing] = useState(false);
  const workspaceMode = run?.workspace
    ? run.workspace.mode === 'isolated'
      ? 'isolated'
      : 'shared'
    : (projects.find((p) => p.id === epic.projectId)?.workspaceMode ?? 'isolated');
  const members = tasks.filter((t) => t.epicId === epic.id && t.projectId === epic.projectId);
  // Une review porte sur le travail d'une exécution terminée, arrêtée ou échouée, jamais d'une exécution en cours.
  const canReview = run !== null && !isActiveRun(run);
  const hasOpenReviewStep = members.some((t) => t.status !== 'done' && isReviewTask(t));
  return (
    <>
      {canReview ? (
        <button
          type="button"
          className="btn"
          title="Une session relit tout ce que les étapes ont modifié, dans leur worktree"
          onClick={() => setReviewing(true)}
        >
          Review de l'epic
        </button>
      ) : null}
      {members.length > 0 && !hasOpenReviewStep ? (
        <button
          type="button"
          className="btn"
          title="Ajoute une dernière tâche de review, qui attend toutes les autres et travaille dans le même worktree"
          onClick={() =>
            void addEpicReviewTask(epic.id).catch((err: unknown) => onError(errorMessage(err, 'Ajout impossible')))
          }
        >
          Ajouter une étape de review
        </button>
      ) : null}
      {reviewing ? (
        <LaunchSessionDialog
          title={`Review de l'epic : ${epic.title.slice(0, 80)}`}
          projectId={epic.projectId}
          epicId={epic.id}
          initialPrompt="Cherche les bugs dans le travail de l'epic."
          submitLabel={`Lancer la review ${workspaceMode === 'shared' ? 'dans le dossier d’origine de l’epic' : "dans le worktree de l'epic"}`}
          onClose={() => setReviewing(false)}
          onLaunch={async (spec) => {
            await startEpicReview(epic.id, spec);
            setReviewing(false);
          }}
        />
      ) : null}
    </>
  );
}
