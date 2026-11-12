import { useState } from 'react';
import { errorMessage } from '../format.ts';
import { dueLabel, postponed, todayIso, type Postpone } from './due.ts';

const POSTPONES: { label: string; by: Postpone }[] = [
  { label: '+1 jour', by: { days: 1 } },
  { label: '+1 semaine', by: { days: 7 } },
  { label: '+1 mois', by: { months: 1 } },
];

// Pastille d'échéance ; rouge quand elle est dépassée et que l'élément n'est pas terminé.
export function DuePill({ dueDate, done }: { dueDate: string | null; done: boolean }) {
  if (dueDate === null) return null;
  const today = todayIso();
  const overdue = !done && dueDate < today;
  return (
    <span
      className={`pill task-status due${overdue ? ' overdue' : ''}`}
      title={overdue ? 'Échéance dépassée' : undefined}
    >
      <span>
        Échéance {dueLabel(dueDate, today)}
        {overdue ? ' · en retard' : ''}
      </span>
    </span>
  );
}

// Modifier, effacer ou repousser l'échéance d'une tâche ou d'un epic.
export function DueControl({
  dueDate,
  onChange,
  onError,
}: {
  dueDate: string | null;
  onChange: (dueDate: string | null) => Promise<unknown>;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const change = async (next: string | null): Promise<void> => {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await onChange(next);
    } catch (err) {
      onError(errorMessage(err, 'Modification de l’échéance impossible'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="task-deps due-control">
      <span className="meta">Échéance :</span>
      <input
        type="date"
        value={dueDate ?? ''}
        disabled={busy}
        aria-label="Échéance"
        onChange={(e) => void change(e.target.value === '' ? null : e.target.value)}
      />
      {dueDate !== null ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void change(null)}>
          Effacer
        </button>
      ) : null}
      <span className="meta">Repousser :</span>
      {POSTPONES.map(({ label, by }) => (
        <button
          key={label}
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void change(postponed(dueDate, by, todayIso()))}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
