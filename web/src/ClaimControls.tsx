import { useState } from 'react';
import { claimTasksForSession } from './api.ts';
import { claimableTask, taskLabel } from './backlog/tasks.ts';
import { errorMessage, sessionTitle } from './format.ts';
import { useStore } from './store.tsx';
import type { Session, Task } from '../../shared/types.ts';

/**
 * Choix dans une liste puis « Rattacher » : forme commune aux deux boutons de rattachement. Le résultat
 * arrive par le flux temps réel (événement `task`).
 */
function ClaimPicker({
  opener,
  placeholder,
  options,
  onClaim,
  onError,
}: {
  opener: string;
  placeholder: string;
  options: { value: string; label: string }[];
  onClaim: (value: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  if (options.length === 0) return null;
  if (!open)
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        {opener}
      </button>
    );
  const submit = async (): Promise<void> => {
    if (busy || value === '') return;
    setBusy(true);
    onError(null);
    try {
      await onClaim(value);
      setOpen(false);
      setValue('');
    } catch (err) {
      onError(errorMessage(err, 'Rattachement impossible'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="row-actions claim-picker">
      <select value={value} onChange={(e) => setValue(e.target.value)} aria-label={placeholder}>
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button type="button" className="btn primary" disabled={busy || value === ''} onClick={() => void submit()}>
        Rattacher
      </button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>
        Annuler
      </button>
    </span>
  );
}

/** Ligne de tâche du backlog : la confier à une session déjà en cours du projet. */
export function ClaimToSessionButton({ task, onError }: { task: Task; onError: (message: string | null) => void }) {
  const { sessions, tasks } = useStore();
  if (!claimableTask(task, sessions, tasks)) return null;
  // Ordre chronologique, la plus récente d'abord, comme les listes de sessions.
  const active = sessions
    .filter((s) => s.projectId === task.projectId && s.status !== 'exited')
    .sort((a, b) => b.createdAt - a.createdAt);
  return (
    <ClaimPicker
      opener="Rattacher à une session…"
      placeholder="Session en cours…"
      options={active.map((s) => ({ value: s.id, label: sessionTitle(s.title) }))}
      onClaim={(sessionId) => claimTasksForSession(sessionId, [task.id])}
      onError={onError}
    />
  );
}

/** Vue session : y rattacher une tâche ouverte du backlog du projet. */
export function ClaimTaskButton({ session, onError }: { session: Session; onError: (message: string | null) => void }) {
  const { sessions, tasks } = useStore();
  if (session.status === 'exited') return null;
  const open = tasks.filter((t) => t.projectId === session.projectId && claimableTask(t, sessions, tasks));
  return (
    <ClaimPicker
      opener="Rattacher une tâche…"
      placeholder="Tâche du backlog…"
      options={open.map((t) => ({ value: t.id, label: taskLabel(t, 80) }))}
      onClaim={(taskId) => claimTasksForSession(session.id, [taskId])}
      onError={onError}
    />
  );
}
