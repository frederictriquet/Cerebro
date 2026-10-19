import type { ReactNode } from 'react';

export interface Choice<T extends string> {
  value: T;
  label: ReactNode;
  danger?: boolean;
  title?: string;
}

/** Groupe de boutons à choix unique (remplace un <select>) ; `compact` : contrôle segmenté réduit. */
export function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  compact = false,
}: {
  label: string;
  value: T;
  options: Choice<T>[];
  onChange: (v: T) => void;
  compact?: boolean;
}) {
  return (
    <div className={`choice-group${compact ? ' compact' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            className={`choice${checked ? ' checked' : ''}${o.danger ? ' danger' : ''}`}
            title={o.title}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
