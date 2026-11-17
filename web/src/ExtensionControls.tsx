import { useState } from 'react';
import { ExtensionsDialog, extensionTargetSummary } from './ExtensionsDialog.tsx';
import { errorMessage } from './format.ts';
import { useStore } from './store.tsx';
import type { Extension, Project } from '../../shared/types.ts';

function extensionHint(ext: Extension, isProjectDefault: boolean): string {
  const details = [
    ext.description || extensionTargetSummary(ext),
    isProjectDefault ? 'activé par défaut sur ce projet' : null,
  ].filter(Boolean);
  return details.join(' · ');
}

/** Project Settings section: toggles which extensions are enabled by default for this project. */
export function ProjectExtensionsSection({ project, onSaved }: { project: Project; onSaved?: () => void }) {
  const { extensions, updateProject } = useStore();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (extId: string, checked: boolean): Promise<void> => {
    setError(null);
    setBusyId(extId);
    const nextIds = extensions
      .map((ext) => ext.id)
      .filter((id) => (id === extId ? checked : project.extensionIds.includes(id)));
    try {
      await updateProject(project.id, { extensionIds: nextIds });
      onSaved?.();
    } catch (err) {
      setError(errorMessage(err, 'Enregistrement impossible'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="card settings-section project-extensions" aria-label="Fonctionnalités supplémentaires">
      <div className="project-extensions-head">
        <h2>Fonctionnalités supplémentaires</h2>
        <button type="button" className="btn" onClick={() => setCatalogOpen(true)}>
          {extensions.length === 0 ? 'Configurer le catalogue…' : 'Gérer le catalogue…'}
        </button>
      </div>
      <p className="hint">
        Serveurs MCP activés par défaut dans ce projet ; modifiables ponctuellement au lancement d’une session.
      </p>
      {extensions.length === 0 ? (
        <p className="empty-hint">Aucun serveur MCP n’est configuré sur cette machine.</p>
      ) : (
        <div className="project-extensions-list">
          {extensions.map((ext) => {
            const checked = project.extensionIds.includes(ext.id);
            return (
              <label key={ext.id} className="project-extension-toggle">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busyId !== null}
                  onChange={(event) => void toggle(ext.id, event.target.checked)}
                />
                <strong className="project-extension-name">{ext.name}</strong>
                <span className="pill">{ext.transport.type === 'http' ? 'HTTP' : 'stdio'}</span>
                {ext.description ? <span className="project-extension-desc">{ext.description}</span> : null}
                <code className="project-extension-target">{extensionTargetSummary(ext)}</code>
              </label>
            );
          })}
        </div>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {catalogOpen ? <ExtensionsDialog onClose={() => setCatalogOpen(false)} /> : null}
    </section>
  );
}

/**
 * Compact session-launch picker: pre-filled from the project's defaults and adjustable per session without overwriting
 * the project's saved defaults. Hidden while the machine catalog is empty.
 */
export function ExtensionLaunchPicker({
  projectExtensionIds,
  value,
  disabled = false,
  onChange,
}: {
  projectExtensionIds: readonly string[];
  value: readonly string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const { extensions } = useStore();
  if (extensions.length === 0) return null;

  const toggle = (extId: string): void => {
    const enabled = !value.includes(extId);
    const next = extensions.map((ext) => ext.id).filter((id) => (id === extId ? enabled : value.includes(id)));
    onChange(next);
  };

  return (
    <div className="tuning">
      <span className="field-label">MCP</span>
      <div className="choice-group compact mcp-launch-group" role="group" aria-label="Serveurs MCP pour cette session">
        <span className="mcp-group-tag" aria-hidden="true">
          MCP
        </span>
        {extensions.map((ext) => {
          const checked = value.includes(ext.id);
          const isDefault = projectExtensionIds.includes(ext.id);
          return (
            <button
              key={ext.id}
              type="button"
              aria-pressed={checked}
              disabled={disabled}
              className={`choice${checked ? ' checked' : ''}`}
              title={extensionHint(ext, isDefault)}
              onClick={() => toggle(ext.id)}
            >
              {ext.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Pill summarizing the extensions enabled on a session in session lists and headers. */
export function SessionExtensionsPill({ extensionIds }: { extensionIds: readonly string[] }) {
  const { extensions } = useStore();
  if (extensionIds.length === 0) return null;
  const byId = new Map(extensions.map((ext) => [ext.id, ext]));
  const names = extensionIds.map((id) => byId.get(id)?.name ?? 'supprimé');
  return (
    <span className="pill mcp-pill" title={`Serveurs MCP actifs : ${names.join(', ')}`}>
      MCP · {names.join(', ')}
    </span>
  );
}
