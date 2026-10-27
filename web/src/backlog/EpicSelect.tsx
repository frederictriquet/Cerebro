import type { Epic } from '../../../shared/types.ts';

export function EpicSelect({
  epics,
  value,
  maxTitle = 60,
  onChange,
}: {
  epics: Epic[];
  value: string;
  maxTitle?: number;
  onChange: (id: string) => void;
}) {
  if (epics.length === 0) return null;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Epic de la tâche">
      <option value="">Sans epic</option>
      {epics.map((epic) => (
        <option key={epic.id} value={epic.id}>
          {epic.title.slice(0, maxTitle)}
        </option>
      ))}
    </select>
  );
}
