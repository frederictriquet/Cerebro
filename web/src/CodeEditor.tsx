import { useEffect, useState } from 'react';
import { api, apiBase } from './api.ts';
import type { Project } from './types.ts';

interface VscodeTarget {
  port: number;
  path: string;
}

function isVscodeTarget(v: unknown): v is VscodeTarget {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.port === 'number' && typeof r.path === 'string';
}

// L'iframe pointe directement sur `code serve-web` : même hôte que l'UI, autre port.
export function vscodeAvailable(): boolean {
  return apiBase() === '';
}

export function CodeEditor({ project, onClose }: { project: Project; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);
    void (async () => {
      try {
        const target = await api<unknown>(`/api/projects/${project.id}/vscode`, { method: 'POST' });
        if (!isVscodeTarget(target)) throw new Error('Réponse inattendue du serveur');
        const { protocol, hostname } = window.location;
        if (!cancelled) setUrl(`${protocol}//${hostname}:${target.port}${target.path}`);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'VS Code indisponible');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id, project.path]);

  return (
    <div className="pane code-editor">
      <div className="code-editor-bar">
        <strong>{project.name}</strong>
        <span className="meta path">{project.path}</span>
        <div className="row-actions">
          {url ? (
            <a className="btn" href={url} target="_blank" rel="noreferrer">
              Nouvel onglet
            </a>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
      {error ? (
        <p className="form-error code-editor-msg">{error}</p>
      ) : url ? (
        <iframe className="code-editor-frame" src={url} title={`VS Code : ${project.name}`} allow="clipboard-read; clipboard-write" />
      ) : (
        <p className="empty-hint code-editor-msg">Démarrage de VS Code… (le premier lancement télécharge le serveur)</p>
      )}
    </div>
  );
}
