import { useRef, useState } from 'react';
import { TODO_TEXT_MAX, type TodoItem } from '../../shared/todos.ts';
import { errorMessage } from './format.ts';
import { usePolling } from './polling.tsx';
import { createTodo, deleteTodo, getTodos, updateTodo } from './todos.ts';

export function SidebarTodos() {
  const [items, setItems] = useState<TodoItem[] | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = usePolling(getTodos, 15_000, {
    enabled: !busy,
    onData: (next) => {
      setItems(next);
      setLoadError(null);
      setEditing((current) => (current !== null && !next.some((item) => item.id === current.id) ? null : current));
    },
    onError: (cause) => setLoadError(errorMessage(cause, 'Chargement impossible')),
  });

  const mutate = async (act: () => Promise<void>): Promise<void> => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await act();
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause, 'Enregistrement impossible'));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const replace = (next: TodoItem): void => {
    setItems((current) => current?.map((item) => (item.id === next.id ? next : item)) ?? null);
  };
  const remaining = items?.filter((item) => !item.done).length ?? 0;

  return (
    <section className="side-section side-todos" aria-labelledby="sidebar-todos-title" aria-busy={busy}>
      <h2 id="sidebar-todos-title">
        Todo-list
        {remaining > 0 ? (
          <span className="count" title="Tâches restantes">
            {remaining}
          </span>
        ) : null}
      </h2>
      <form
        className="todo-add"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text) return;
          void mutate(async () => {
            const item = await createTodo(text);
            setItems((current) => [...(current ?? []), item]);
            setDraft('');
          });
        }}
      >
        <input
          aria-label="Nouvelle tâche"
          placeholder="Nouvelle tâche…"
          value={draft}
          maxLength={TODO_TEXT_MAX}
          disabled={busy || items === null}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn" disabled={busy || items === null || !draft.trim()}>
          Ajouter
        </button>
      </form>
      {items === null ? (
        loadError === null ? (
          <p className="empty-hint">Chargement…</p>
        ) : null
      ) : items.length === 0 ? (
        <p className="empty-hint">Aucune tâche</p>
      ) : (
        <ul className="todo-list">
          {items.map((item) => (
            <li key={item.id} className={`todo-row${item.done ? ' done' : ''}`}>
              <input
                type="checkbox"
                checked={item.done}
                disabled={busy}
                aria-label={`${item.done ? 'Rouvrir' : 'Terminer'} : ${item.text}`}
                onChange={(event) => {
                  const done = event.target.checked;
                  void mutate(async () => replace(await updateTodo(item.id, { done })));
                }}
              />
              {editing?.id === item.id ? (
                <form
                  className="todo-edit"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && !busy) setEditing(null);
                  }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const text = editing.text.trim();
                    if (!text) return;
                    void mutate(async () => {
                      replace(await updateTodo(item.id, { text }));
                      setEditing(null);
                    });
                  }}
                >
                  <input
                    autoFocus
                    aria-label="Modifier la tâche"
                    value={editing.text}
                    maxLength={TODO_TEXT_MAX}
                    disabled={busy}
                    onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                  />
                  <div className="todo-edit-actions">
                    <button type="submit" className="btn" disabled={busy || !editing.text.trim()}>
                      Enregistrer
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => setEditing(null)}>
                      Annuler
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <span className="todo-text">{item.text}</span>
                  <span className="todo-actions">
                    <button
                      type="button"
                      className="todo-icon"
                      title="Modifier"
                      aria-label={`Modifier : ${item.text}`}
                      disabled={busy}
                      onClick={() => setEditing({ id: item.id, text: item.text })}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="todo-icon todo-delete"
                      title="Supprimer"
                      aria-label={`Supprimer : ${item.text}`}
                      disabled={busy}
                      onClick={() =>
                        void mutate(async () => {
                          await deleteTodo(item.id);
                          setItems((current) => current?.filter((todo) => todo.id !== item.id) ?? null);
                        })
                      }
                    >
                      ×
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loadError === null ? null : (
        <div className="todo-load-error">
          <p className="form-error" role="alert">
            {loadError}
          </p>
          <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
            Réessayer
          </button>
        </div>
      )}
    </section>
  );
}
