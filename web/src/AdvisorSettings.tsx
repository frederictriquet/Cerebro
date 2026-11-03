import { useEffect, useState } from 'react';
import { getAdvisor, setAdvisor } from './api.ts';
import { errorMessage } from './format.ts';
import { useStore } from './store.tsx';

// Réglage global `claude --advisor` : lu au chargement par la pastille, modifié dans le panneau.
export function useAdvisor() {
  const { connected } = useStore();
  const [model, setModel] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (model !== undefined) return;
    let cancelled = false;
    void getAdvisor()
      .then((value) => {
        if (!cancelled) setModel(value.model);
      })
      .catch(() => {
        /* réessayé à la reconnexion WS */
      });
    return () => {
      cancelled = true;
    };
  }, [connected, model]);
  return { model, setModel };
}

export function AdvisorPanel({ model, onChange }: { model: string | null; onChange: (model: string | null) => void }) {
  const { agents } = useStore();
  const suggestions = agents.find((item) => item.agent === 'claude')?.models ?? [];
  const [draft, setDraft] = useState(model ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (value: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const saved = await setAdvisor(value.trim() === '' ? null : value);
      onChange(saved.model);
      setDraft(saved.model ?? '');
    } catch (err) {
      setError(errorMessage(err, 'Enregistrement impossible'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="slack-panel">
      <label className="advisor-field">
        <span>
          Modèle de l’advisor (<code>claude --advisor</code>)
        </span>
        <input
          type="text"
          list="advisor-models"
          value={draft}
          disabled={busy}
          placeholder="Désactivé"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save(draft);
          }}
        />
        <datalist id="advisor-models">
          {suggestions.map((item) => (
            <option key={item.value} value={item.value} label={item.label} />
          ))}
        </datalist>
      </label>
      <div className="advisor-actions">
        <button
          type="button"
          className="btn"
          disabled={busy || draft.trim() === (model ?? '')}
          onClick={() => void save(draft)}
        >
          Enregistrer
        </button>
        <button type="button" className="btn" disabled={busy || model === null} onClick={() => void save('')}>
          Désactiver
        </button>
      </div>
      <p className="meta">
        Vaut pour toutes les sessions Claude lancées ou reprises ensuite ; celles déjà en cours ne changent pas.
      </p>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
