import { useState, type FormEvent } from 'react';
import { useAsyncAction } from './async-action.ts';
import { CommitSettingsDialog } from './CommitSettingsDialog.tsx';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import { errorMessage } from './format.ts';
import { PathInput } from './PathInput.tsx';
import { ProjectSlackDialog } from './ProjectSlackDialog.tsx';
import { go } from './route.ts';
import { useStore } from './store.tsx';
import type { Project } from '../../shared/types.ts';

const PROJECT_COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f'];

/**
 * Onglet Réglages du projet : ce que l'en-tête portait (Éditer, Slack, Réglages LLM, Supprimer), en
 * sections toujours dépliées. Chaque section s'enregistre seule.
 */
export function ProjectSettings({
  project,
  hasProtectedSessions,
}: {
  project: Project;
  hasProtectedSessions: boolean;
}) {
  const { deleteProject } = useStore();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const saved = (what: string) => (): void => {
    setError(null);
    setNotice(`${what} enregistrés.`);
  };
  return (
    <div className="project-settings">
      {notice ? (
        <p className="hint" role="status">
          {notice}
        </p>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
      <ProjectForm key={project.id} project={project} onSaved={saved('Nom, chemin et couleur')} />
      <ProjectSlackDialog key={`slack-${project.id}`} project={project} inline onClose={saved('Réglages Slack')} />
      <CommitSettingsDialog key={`llm-${project.id}`} project={project} inline onClose={saved('Réglages LLM')} />
      <section className="card settings-section" aria-label="Supprimer le projet">
        <h2>Supprimer le projet</h2>
        <p className="hint">
          Supprime le projet et ses conversations ; les worktrees restent dans l’inventaire global.
        </p>
        <div className="row-actions">
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
          {hasProtectedSessions ? (
            <span className="hint">Décochez la protection des sessions de ce projet avant de le supprimer.</span>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function ProjectForm({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const { updateProject } = useStore();
  const [name, setName] = useState(project.name);
  const [path, setPath] = useState(project.path);
  const [color, setColor] = useState<string | null>(project.color);
  const [regenerable, setRegenerable] = useState(project.regenerablePaths.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const { run: save, busy } = useAsyncAction(
    async (update: Pick<Project, 'name' | 'path' | 'color' | 'regenerablePaths'>) => {
      await updateProject(project.id, update);
      onSaved();
    },
    { fallback: 'Modification impossible', onError: setError },
  );
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedPath = path.trim();
    if (trimmedName.length === 0 || trimmedPath.length === 0) {
      setError('Le nom et le chemin sont requis');
      return;
    }
    setError(null);
    const regenerablePaths = regenerable
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    void save({ name: trimmedName, path: trimmedPath, color, regenerablePaths });
  };
  return (
    <section className="card settings-section" aria-label="Projet">
      <h2>Projet</h2>
      <form className="edit-project" onSubmit={onSubmit}>
        <label>
          Nom
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Chemin
          <PathInput required value={path} onChange={setPath} />
        </label>
        <label>
          Chemins régénérables des copies de travail
          <textarea
            rows={2}
            value={regenerable}
            placeholder="web/dist"
            onChange={(e) => setRegenerable(e.target.value)}
          />
          <span className="hint">
            Un chemin par ligne, relatif à la racine du projet : fichiers ignorés par Git qu’une compilation ou une
            installation recrée. Le retrait d’une copie, nettoyage automatique compris, les supprime sans demander.
          </span>
        </label>
        <div className="color-field">
          <span>Couleur</span>
          <div className="color-swatches">
            {PROJECT_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className={color === swatch ? 'color-swatch selected' : 'color-swatch'}
                style={{ background: swatch }}
                title={swatch}
                aria-label={`Couleur ${swatch}`}
                onClick={() => setColor(swatch)}
              />
            ))}
            <input
              type="color"
              className="color-custom"
              title="Couleur personnalisée"
              value={color ?? '#888888'}
              onChange={(e) => setColor(e.target.value)}
            />
            <button
              type="button"
              className={color === null ? 'color-swatch none selected' : 'color-swatch none'}
              title="Aucune couleur"
              aria-label="Aucune couleur"
              onClick={() => setColor(null)}
            />
          </div>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="row-actions">
          <button type="submit" className="btn primary" disabled={busy}>
            Enregistrer
          </button>
        </div>
      </form>
    </section>
  );
}
