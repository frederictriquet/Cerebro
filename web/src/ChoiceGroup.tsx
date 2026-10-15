export interface Choice<T extends string> {
  value: T;
  label: string;
  danger?: boolean;
}

/** Groupe de boutons à choix unique (remplace un <select>). */
export function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Choice<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="choice-group" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            className={`choice${checked ? ' checked' : ''}${o.danger ? ' danger' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
