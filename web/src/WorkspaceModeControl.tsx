import { useAsyncAction } from './async-action.ts';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import { useStore } from './store.tsx';
import type { Project, WorkspaceMode } from '../../shared/types.ts';

// Choix du dossier de travail des nouvelles conversations : enregistré dès le clic, comme la case Slack.
export function WorkspaceModeControl({ project }: { project: Project }) {
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
