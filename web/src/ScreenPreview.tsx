import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.ts';
import { parseScreenLines } from '../../shared/types.ts';
import { errorMessage } from './format.ts';

const POPOVER_WIDTH = 440;

/** Bouton « Aperçu » et fenêtre des dernières lignes du terminal, placés séparément par l'appelant. */
export function useSessionPreview(sessionId: string): { button: ReactNode; popover: ReactNode } {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  return {
    button: <PreviewButton pressed={open} onToggle={() => setOpen((value) => !value)} anchorRef={anchorRef} />,
    popover: open ? <ScreenPopover sessionId={sessionId} anchorRef={anchorRef} /> : null,
  };
}

function tailLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === '') end -= 1;
  return lines.slice(Math.max(0, end - 8), end);
}

function ScreenPopover({ sessionId, anchorRef }: { sessionId: string; anchorRef: RefObject<HTMLElement | null> }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await api(`/api/sessions/${sessionId}/screen`);
        const parsed = parseScreenLines(raw);
        if (cancelled) return;
        if (!parsed) {
          setError('Aperçu indisponible');
          return;
        }
        setError(null);
        setLines(tailLines(parsed));
      } catch (err) {
        if (cancelled) return;
        setError(errorMessage(err, 'Aperçu indisponible'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const place = (): void => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 16);
      let left = rect.left;
      if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
      let top = rect.bottom + 4;
      if (top + 160 > window.innerHeight - 8) top = Math.max(8, rect.top - 164);
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef]);

  let body = '…';
  if (error !== null) body = error;
  else if (lines !== null) body = lines.length === 0 ? '(vide)' : lines.join('\n');

  return createPortal(
    <pre className="screen-popover" style={{ top: pos.top, left: pos.left }}>
      {body}
    </pre>,
    document.body,
  );
}

function PreviewButton({
  pressed,
  onToggle,
  anchorRef,
}: {
  pressed: boolean;
  onToggle: () => void;
  anchorRef: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <span className="preview-anchor" ref={anchorRef}>
      <button type="button" className="btn preview-btn" aria-expanded={pressed} onClick={onToggle}>
        Aperçu
      </button>
    </span>
  );
}
