import { ActivityStatus } from './ActivityStatus.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { errorMessage } from './format.ts';

interface DirListing {
  path: string;
  parent: string | null;
  home: string;
  dirs: string[];
}

function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

export function PathInput({
  value,
  onChange,
  required,
  placeholder = 'Chemin absolu',
}: {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (path: string, fallback = false): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setListing(await api<DirListing>(`/api/fs/dirs?path=${encodeURIComponent(path)}`));
    } catch (err) {
      if (fallback) {
        await load('', false);
        return;
      }
      setError(errorMessage(err, 'Lecture impossible'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    void load(value.trim(), true);
  };

  const enter = (path: string): void => {
    void load(path);
  };

  const choose = (): void => {
    if (listing) onChange(listing.path);
    setOpen(false);
  };

  const dirs = listing ? listing.dirs.filter((d) => showHidden || !d.startsWith('.')) : [];

  return (
    <div className="path-input" ref={rootRef}>
      <div className="path-input-row">
        <input
          required={required}
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="btn" onClick={toggle} aria-expanded={open} title="Parcourir">
          Parcourir
        </button>
      </div>
      {open ? (
        <div className="dir-picker">
          <div className="dir-picker-head">
            <span className="dir-picker-path" title={listing?.path}>
              {listing?.path ?? '…'}
            </span>
          </div>
          <div className="dir-picker-tools">
            <button
              type="button"
              className="btn"
              disabled={!listing?.parent || loading}
              onClick={() => listing?.parent && enter(listing.parent)}
            >
              ↑ Parent
            </button>
            <button type="button" className="btn" disabled={loading} onClick={() => listing && enter(listing.home)}>
              ~
            </button>
            <label className="dir-picker-hidden">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
              Cachés
            </label>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          {loading ? <p className="meta"><ActivityStatus>Chargement des dossiers…</ActivityStatus></p> : null}
          <ul className="dir-picker-list" aria-busy={loading}>
            {listing && dirs.length === 0 ? <li className="empty-hint">Aucun sous-dossier</li> : null}
            {listing
              ? dirs.map((d) => (
                  <li key={d}>
                    <button type="button" disabled={loading} onClick={() => enter(joinPath(listing.path, d))}>
                      📁 {d}
                    </button>
                  </li>
                ))
              : null}
          </ul>
          <div className="row-actions">
            <button type="button" className="btn primary" disabled={!listing || loading} onClick={choose}>
              Choisir ce dossier
            </button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Annuler
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
