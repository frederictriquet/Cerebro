import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** Délai de rétractation : l'action ne part qu'une fois ce délai écoulé. */
const UNDO_WINDOW_MS = 5000;

/**
 * Bouton à action différée pour les actions destructrices (remplace window.confirm).
 * Le clic programme l'action et ouvre un délai de rétractation de 5 s : un second
 * clic l'annule ; Échap annule tous les délais actifs, quel que soit le focus.
 * Le bouton retrouve alors son état initial ; sinon l'action
 * s'exécute à l'expiration du délai. Si le bouton disparaît entre-temps (navigation),
 * l'action part quand même à l'échéance : elle a été demandée et n'a pas été annulée.
 */
export function DelayedActionButton({
  children,
  cancelLabel = 'Annuler',
  onAction,
  className = 'btn danger-ghost',
  disabled,
  title,
}: {
  children: ReactNode;
  cancelLabel?: ReactNode;
  onAction: () => void;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [remaining, setRemaining] = useState<number | null>(null);
  const fire = useRef<number | undefined>(undefined);
  const tick = useRef<number | undefined>(undefined);
  const escapeListener = useRef<((event: KeyboardEvent) => void) | null>(null);

  // Stables (refs et setter seulement) : les effets peuvent les déclarer sans se relancer.
  const stopListening = useCallback((): void => {
    if (escapeListener.current) window.removeEventListener('keydown', escapeListener.current, true);
    escapeListener.current = null;
  }, []);

  const stopTick = useCallback((): void => {
    window.clearInterval(tick.current);
    tick.current = undefined;
  }, []);

  const cancel = useCallback((): void => {
    window.clearTimeout(fire.current);
    fire.current = undefined;
    stopTick();
    stopListening();
    setRemaining(null);
  }, [stopTick, stopListening]);

  // Au démontage, le délai reste dû et annulable par Échap jusqu'à son échéance.
  useEffect(() => stopTick, [stopTick]);
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled, cancel]);

  const pending = remaining !== null;

  const onClick = (): void => {
    if (pending) {
      cancel();
      return;
    }
    const deadline = performance.now() + UNDO_WINDOW_MS;
    // Capture reaches every pending action, even from an input or a modal that stops propagation.
    escapeListener.current = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', escapeListener.current, true);
    setRemaining(Math.ceil(UNDO_WINDOW_MS / 1000));
    tick.current = window.setInterval(() => {
      setRemaining(Math.max(1, Math.ceil((deadline - performance.now()) / 1000)));
    }, 250);
    fire.current = window.setTimeout(() => {
      fire.current = undefined;
      stopTick();
      stopListening();
      setRemaining(null);
      onAction();
    }, UNDO_WINDOW_MS);
  };

  return (
    <button
      type="button"
      className={`${className} delayed-btn${pending ? ' pending' : ''}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
      style={{ ['--undo-window' as string]: `${UNDO_WINDOW_MS}ms` }}
    >
      {/* Les deux libellés occupent la même cellule : la largeur ne bouge pas. */}
      <span className="delayed-btn-label" aria-hidden={pending}>
        {children}
      </span>
      <span className="delayed-btn-label" aria-hidden={!pending}>
        {cancelLabel} ({remaining ?? Math.ceil(UNDO_WINDOW_MS / 1000)} s)
      </span>
    </button>
  );
}
