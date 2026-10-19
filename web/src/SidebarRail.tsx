import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

// Largeur et masquage de la barre latérale (bureau uniquement), mémorisés par ce navigateur.
const WIDTH_KEY = 'cerebro.sidebarWidth';
const HIDDEN_KEY = 'cerebro.sidebarHidden';
export const SIDEBAR_DEFAULT = 272;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;

function clampWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
}

function readWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? clampWidth(value) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota / mode privé */
  }
}

export function useSidebarLayout() {
  const [width, setWidthState] = useState(readWidth);
  const [hidden, setHiddenState] = useState(readHidden);

  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidthState(clamped);
    write(WIDTH_KEY, String(clamped));
  }, []);

  const setHidden = useCallback((next: boolean) => {
    setHiddenState(next);
    write(HIDDEN_KEY, next ? '1' : '0');
  }, []);

  return { width, setWidth, hidden, setHidden };
}

// Bande verticale entre la barre latérale et le contenu : glisser pour redimensionner,
// double-clic pour revenir à la largeur par défaut, bouton pour masquer / afficher.
export function SidebarRail({
  width,
  hidden,
  onResize,
  onToggle,
}: {
  width: number;
  hidden: boolean;
  onResize: (width: number) => void;
  onToggle: () => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    // Pendant le glissement, le curseur ne doit pas sélectionner de texte ni être capté par xterm.
    document.body.classList.add('sidebar-resizing');
    return () => document.body.classList.remove('sidebar-resizing');
  }, [dragging]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (hidden || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return;
    onResize(drag.current.startWidth + event.clientX - drag.current.startX);
  };

  const endDrag = (): void => {
    drag.current = null;
    setDragging(false);
  };

  return (
    <div className={`sidebar-rail${hidden ? ' collapsed' : ''}${dragging ? ' dragging' : ''}`}>
      <button
        type="button"
        className="sidebar-toggle"
        aria-controls="sidebar"
        aria-expanded={!hidden}
        title={hidden ? 'Afficher la barre latérale' : 'Masquer la barre latérale'}
        onClick={onToggle}
      >
        {hidden ? '»' : '«'}
      </button>
      {hidden ? null : (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionner la barre latérale"
          aria-valuenow={width}
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          tabIndex={0}
          title="Glisser pour redimensionner, double-clic pour la largeur par défaut"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => onResize(SIDEBAR_DEFAULT)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') onResize(width - 16);
            else if (event.key === 'ArrowRight') onResize(width + 16);
            else return;
            event.preventDefault();
          }}
        />
      )}
    </div>
  );
}
