import { useEffect, useState } from 'react';
import { ExtensionsDialog, extensionBadgeLabel, extensionTargetSummary } from './ExtensionsDialog.tsx';
import { errorMessage } from './format.ts';
import { useStore } from './store.tsx';
import type { Extension, Project } from '../../shared/types.ts';

function extensionHint(ext: Extension, isProjectDefault: boolean): string {
  const details = [
    ext.kind === 'skill' && ext.missing ? `Dossier introuvable (${ext.path})` : null,
    ext.description || extensionTargetSummary(ext),
    ext.kind === 'skill' && !ext.missing && ext.skills.length > 0
      ? `skills : ${ext.skills.map((s) => s.name).join(', ')}`
      : null,
    isProjectDefault ? 'activé par défaut sur ce projet' : null,
  ].filter(Boolean);
  return details.join(' · ');
}

/** Project Settings section: toggles which extensions are enabled by default for this project. */
export function ProjectExtensionsSection({ project, onSaved }: { project: Project; onSaved?: () => void }) {
  const { extensions, refreshExtensions, updateProject } = useStore();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshExtensions?.().catch(() => {});
  }, [refreshExtensions]);

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
        Serveurs MCP et dossiers de skills activés par défaut dans ce projet ; modifiables ponctuellement au lancement
        d’une session.
      </p>
      {extensions.length === 0 ? (
        <p className="empty-hint">
          Aucune fonctionnalité supplémentaire (serveur MCP ou skills) n’est configurée sur cette machine.
        </p>
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
                <span className="pill">{extensionBadgeLabel(ext)}</span>
                {ext.kind === 'skill' && ext.missing ? (
                  <span className="pill ext-missing-pill">Dossier introuvable</span>
                ) : null}
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
      <span className="field-label">Extensions</span>
      <div
        className="choice-group compact mcp-launch-group"
        role="group"
        aria-label="Fonctionnalités supplémentaires pour cette session"
      >
        <span className="mcp-group-tag" aria-hidden="true">
          Ext.
        </span>
        {extensions.map((ext) => {
          const checked = value.includes(ext.id);
          const isDefault = projectExtensionIds.includes(ext.id);
          const isMissing = ext.kind === 'skill' && ext.missing;
          return (
            <button
              key={ext.id}
              type="button"
              aria-pressed={checked}
              disabled={disabled}
              className={`choice${checked ? ' checked' : ''}${isMissing ? ' ext-choice-missing' : ''}`}
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

function sessionPillPrefix(resolved: readonly (Extension | undefined)[]): string {
  const known = resolved.filter((ext): ext is Extension => ext !== undefined);
  if (known.length === 0) return 'Ext.';
  if (known.every((ext) => ext.kind === 'mcp')) return 'MCP';
  if (known.every((ext) => ext.kind === 'skill')) return known.length > 1 ? 'Skills' : 'Skill';
  return 'Ext.';
}

/** Pill summarizing the extensions enabled on a session in session lists and headers. */
export function SessionExtensionsPill({ extensionIds }: { extensionIds: readonly string[] }) {
  const { extensions } = useStore();
  if (extensionIds.length === 0) return null;
  const byId = new Map(extensions.map((ext) => [ext.id, ext]));
  const resolved = extensionIds.map((id) => byId.get(id));
  const names = resolved.map((ext) => ext?.name ?? 'supprimé');
  const prefix = sessionPillPrefix(resolved);
  return (
    <span className="pill mcp-pill" title={`Fonctionnalités actives : ${names.join(', ')}`}>
      {prefix} · {names.join(', ')}
    </span>
  );
}
