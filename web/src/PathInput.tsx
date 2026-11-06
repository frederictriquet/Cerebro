import { ActivityStatus } from './ActivityStatus.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiParsed } from './api.ts';
import { errorMessage } from './format.ts';
import { parseDirListing, type DirListing } from '../../shared/machine.ts';

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

  const load = useCallback(async (path: string, fallback = false): Promise<DirListing | null> => {
    setLoading(true);
    setError(null);
    try {
      const next = await apiParsed(`/api/fs/dirs?path=${encodeURIComponent(path)}`, parseDirListing);
      setListing(next);
      return next;
    } catch (err) {
      if (fallback) return await load('', false);
      setError(errorMessage(err, 'Lecture impossible'));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // Au clic et non à l'appui : fermer le sélecteur décale la mise en page, et un bouton qui bouge
    // entre l'appui et le relâchement ne reçoit plus le clic (« Annuler » de la modale).
    const onClickOutside = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClickOutside);
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

  // Le dossier affiché devient la valeur du champ dès qu'on y navigue.
  const enter = async (path: string): Promise<void> => {
    const next = await load(path);
    if (next) onChange(next.path);
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
          <div className="dir-picker-tools">
            <button
              type="button"
              className="btn"
              disabled={!listing?.parent || loading}
              onClick={() => listing?.parent && void enter(listing.parent)}
            >
              ↑ Parent
            </button>
            <button
              type="button"
              className="btn"
              disabled={loading}
              onClick={() => listing && void enter(listing.home)}
            >
              ~
            </button>
            <label className="dir-picker-hidden">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
              Cachés
            </label>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          {loading ? (
            <p className="meta">
              <ActivityStatus>Chargement des dossiers…</ActivityStatus>
            </p>
          ) : null}
          <ul className="dir-picker-list" aria-busy={loading}>
            {listing && dirs.length === 0 ? <li className="empty-hint">Aucun sous-dossier</li> : null}
            {listing
              ? dirs.map((d) => (
                  <li key={d}>
                    <button type="button" disabled={loading} onClick={() => void enter(joinPath(listing.path, d))}>
                      📁 {d}
                    </button>
                  </li>
                ))
              : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
