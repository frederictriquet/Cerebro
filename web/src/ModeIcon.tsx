import type { Mode } from '../../shared/types.ts';

/**
 * Mode marker drawn in SVG: the ⏵⏵ and ⏸ characters of the agents' status line are missing from Android's fonts and
 * render as empty boxes there. Fast-forward for the modes that run, pause for plan, nothing for `default`.
 */
export function ModeIcon({ mode }: { mode: Mode }) {
  if (mode === 'default') return null;
  return (
    <svg className="mode-icon" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      {mode === 'plan' ? (
        <>
          <rect x="2.5" y="2" width="2.5" height="8" rx="0.5" />
          <rect x="7" y="2" width="2.5" height="8" rx="0.5" />
        </>
      ) : (
        <>
          <path d="M1 2.2v7.6L6 6z" />
          <path d="M6 2.2v7.6L11 6z" />
        </>
      )}
    </svg>
  );
}

/** Mode label preceded by its marker, for a choice button or a pill. */
export function ModeText({ mode, text }: { mode: Mode; text: string }) {
  return (
    <span className="mode-text">
      <ModeIcon mode={mode} />
      {text}
    </span>
  );
}
