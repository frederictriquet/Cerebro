import { useEffect, useState } from 'react';
import { api, apiBase } from './api.ts';
import type { Project } from './types.ts';

type VscodeOpen = { ready: false } | { ready: true; path: string };

function parseVscodeOpen(v: unknown): VscodeOpen | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (r.ready === false) return { ready: false };
  if (r.ready === true && typeof r.path === 'string') return { ready: true, path: r.path };
  return null;
}

const RETRY_MS = 2_000;

// VS Code est relayé par Cerebro sous /vscode/ (sous /m/<id>/vscode/ pour une machine distante).
export function CodeEditor({ project, onClose }: { project: Project; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    setUrl(null);
    setError(null);
    const base = apiBase();
    const load = async (): Promise<void> => {
      try {
        const opened = parseVscodeOpen(await api<unknown>(`/api/projects/${project.id}/vscode`, { method: 'POST' }));
        if (cancelled) return;
        if (opened === null) throw new Error('Réponse inattendue du serveur');
        // Premier lancement : le serveur VS Code est en cours de téléchargement.
        if (!opened.ready) timer = window.setTimeout(() => void load(), RETRY_MS);
        else setUrl(`${base}${opened.path}`);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'VS Code indisponible');
      }
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
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
        <iframe
          className="code-editor-frame"
          src={url}
          title={`VS Code : ${project.name}`}
          allow="clipboard-read; clipboard-write"
        />
      ) : (
        <p className="empty-hint code-editor-msg">Démarrage de VS Code… (le premier lancement télécharge le serveur)</p>
      )}
    </div>
  );
}
