import { useEffect, useState } from 'react';
import { getTrustFolders, setTrustFolders } from './api.ts';
import { errorMessage } from './format.ts';
import { useStore } from './store.tsx';

// Réglage global d'approbation automatique des dossiers de session : lu au chargement, modifié dans le panneau.
export function useTrustFolders() {
  const { connected } = useStore();
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (enabled !== undefined) return;
    let cancelled = false;
    void getTrustFolders()
      .then((value) => {
        if (!cancelled) setEnabled(value.enabled);
      })
      .catch(() => {
        /* réessayé à la reconnexion WS */
      });
    return () => {
      cancelled = true;
    };
  }, [connected, enabled]);
  return { enabled, setEnabled };
}

export function TrustFoldersPanel({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    const previous = enabled;
    onChange(next);
    try {
      const saved = await setTrustFolders(next);
      onChange(saved.enabled);
    } catch (err) {
      onChange(previous);
      setError(errorMessage(err, 'Enregistrement impossible'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="slack-panel">
      <label className="slack-toggle">
        <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        Approuver automatiquement le dossier des sessions
      </label>
      <p className="meta">
        Évite la demande « Trust this folder » au lancement ou à la reprise pour Claude, Codex, Grok et Gemini, et
        active les hooks et réglages locaux du projet. Les sessions déjà en cours ne changent pas.
      </p>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
