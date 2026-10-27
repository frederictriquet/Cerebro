import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiParsed } from './api.ts';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import './session-tasks.css';
import { parseSessionTasks, type SessionTask, type SessionTaskStatus } from '../../shared/backlog.ts';

const LABELS: Record<SessionTaskStatus, string> = {
  todo: 'À faire', in_progress: 'En cours', blocked: 'Bloquée', done: 'Terminée', cancelled: 'Annulée',
};
const COUNT_LABELS: Record<SessionTaskStatus, string> = {
  todo: 'à faire', in_progress: 'en cours', blocked: 'bloquée', done: 'terminée', cancelled: 'annulée',
};
export const TASK_STATE_LABELS = {
  todo: 'À faire', in_progress: 'En cours', blocked: 'Blocage',
  done: 'Tous les objectifs sont terminés ou annulés', cancelled: 'Tous les objectifs sont annulés', empty: 'Aucune sous-tâche',
};

export function sessionTasksState(tasks: readonly SessionTask[]): SessionTaskStatus | 'empty' {
  for (const status of ['blocked', 'in_progress', 'todo'] as const) {
    if (tasks.some(task => task.status === status)) return status;
  }
  if (!tasks.length) return 'empty';
  return tasks.some(task => task.status === 'done') ? 'done' : 'cancelled';
}

export function useSessionTasks(sessionId: string) {
  const [data, setData] = useState<{ sessionId: string; tasks: SessionTask[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const current = ++requestId.current;
    try {
      const tasks = await apiParsed(`/api/sessions/${sessionId}/tasks`, parseSessionTasks);
      if (requestId.current === current) { setData({ sessionId, tasks }); setError(null); }
    } catch (cause) {
      if (requestId.current === current) setError(String(cause));
    }
  }, [sessionId]);
  useEffect(() => {
    setData(null); setError(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { window.clearInterval(timer); requestId.current++; };
  }, [refresh]);
  return { tasks: data?.sessionId === sessionId ? data.tasks : [], loaded: data?.sessionId === sessionId, error, refresh };
}

export function SessionTasksPanel({ sessionId, tasks, loaded, error, refresh }: ReturnType<typeof useSessionTasks> & { sessionId: string }) {
  const [editing, setEditing] = useState<SessionTask | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (formOpen) titleInput.current?.focus();
  }, [formOpen, editing?.id]);
  const base = `/api/sessions/${sessionId}/tasks`;
  const reset = (): void => { setEditing(null); setTitle(''); setNote(''); setFormOpen(false); };
  const mutate = async (method: string, id?: string, body?: unknown, after?: () => void): Promise<void> => {
    setBusy(true); setSaveError(null);
    try {
      await api(`${base}${id ? `/${id}` : ''}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      after?.();
      await refresh();
    } catch (cause) { setSaveError(String(cause)); }
    finally { setBusy(false); }
  };
  const counts = (Object.keys(LABELS) as SessionTaskStatus[])
    .map(status => ({ status, count: tasks.filter(task => task.status === status).length }))
    .filter(({ count }) => count > 0);
  const summary = counts.map(({ status, count }) =>
    `${count} ${COUNT_LABELS[status]}${count > 1 && ['blocked', 'done', 'cancelled'].includes(status) ? 's' : ''}`);
  return <div className="session-tasks">
    <div className="session-tasks-toolbar">
      <h2>Sous-tâches</h2>
      {loaded ? <span className="session-task-counts">{counts.map(({ status }, index) =>
        <span key={status} data-state={status}>{summary[index]}</span>
      )}</span> : null}
      <div className="session-tasks-tools">
        <button type="button" className="btn" disabled={busy} aria-expanded={formOpen && !editing} onClick={() => {
          reset(); setSaveError(null); setFormOpen(true);
        }}>+ Ajouter</button>
        <button type="button" className="btn session-task-icon" disabled={busy} aria-label="Actualiser les sous-tâches"
          title="Actualiser" onClick={() => void refresh()}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6" />
          </svg>
        </button>
      </div>
    </div>
    {loaded && tasks.length > 0 ? <div className="session-task-distribution" role="img" aria-label={summary.join(', ')}>
      {counts.map(({ status, count }, index) =>
        <span key={status} data-state={status} style={{ flex: count }} title={summary[index]} />
      )}
    </div> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!loaded && !error ? <p>Chargement…</p> : null}
    {loaded && !tasks.length && !formOpen ? <p className="hint">Aucun sous-objectif enregistré.</p> : null}
    {formOpen ? <form className="session-task-form" onSubmit={event => {
      event.preventDefault();
      if (busy || !title.trim()) return;
      // An agent may have updated the status or note while the form was open.
      const changes = editing
        ? { ...(title.trim() !== editing.title ? { title: title.trim() } : {}), ...(note !== editing.note ? { note } : {}) }
        : { title, note };
      if (editing && !Object.keys(changes).length) { reset(); return; }
      void mutate(editing ? 'PATCH' : 'POST', editing?.id, changes, reset);
    }}>
      <input ref={titleInput} aria-label={editing ? 'Modifier le sous-objectif' : 'Ajouter un sous-objectif'} placeholder="Sous-objectif"
        value={title} maxLength={500} required disabled={busy} onChange={event => setTitle(event.target.value)} />
      <textarea aria-label="Résultat, vérification ou blocage" placeholder="Résultat, vérification ou blocage (facultatif)"
        value={note} maxLength={10000} rows={2} disabled={busy} onChange={event => setNote(event.target.value)} />
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy || !title.trim()}>{editing ? 'Enregistrer' : 'Ajouter'}</button>
        <button type="button" className="btn" disabled={busy} onClick={reset}>Annuler</button>
        {editing ? <DelayedActionButton disabled={busy} title="Supprimer cette sous-tâche"
          onAction={() => void mutate('DELETE', editing.id, undefined, reset)}>Supprimer</DelayedActionButton> : null}
      </div>
    </form> : null}
    <ol className="session-task-list">
      {tasks.map(task => <li key={task.id} className={`session-task ${task.status}`} data-state={task.status}>
        <div className="session-task-heading">
          <select aria-label={`Statut : ${task.title}`} value={task.status} disabled={busy}
            onChange={event => void mutate('PATCH', task.id, { status: event.target.value })}>
            {Object.entries(LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          {task.note ? <button type="button" className="session-task-title" aria-expanded={expanded.has(task.id)}
            title={expanded.has(task.id) ? 'Masquer la note' : 'Afficher la note'} onClick={() => setExpanded(previous => {
              const next = new Set(previous);
              if (next.has(task.id)) next.delete(task.id); else next.add(task.id);
              return next;
            })}>
            <span>{task.title}</span>
            <svg className="session-task-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="m6 4 4 4-4 4" />
            </svg>
          </button> : <span className="session-task-title">{task.title}</span>}
          <button type="button" className="btn session-task-icon" disabled={busy} aria-label={`Modifier : ${task.title}`}
            title="Modifier" onClick={() => {
              setEditing(task); setTitle(task.title); setNote(task.note); setSaveError(null); setFormOpen(true);
            }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        </div>
        {task.note && expanded.has(task.id) ? <p className="session-task-note">{task.note}</p> : null}
      </li>)}
    </ol>
    {saveError ? <p className="form-error" role="alert">{saveError}</p> : null}
  </div>;
}
