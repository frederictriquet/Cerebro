import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { parseProjectCommand, parseProjectCommands, type ProjectCommand } from '../../../shared/backlog.ts';
import type { Epic } from '../../../shared/types.ts';
import { apiParsed } from '../api.ts';
import { errorMessage } from '../format.ts';
import { useStore } from '../store.tsx';
import { EpicSelect } from './EpicSelect.tsx';

const EMPTY_COMMAND = JSON.stringify({ name: '', executable: '', args: [], cwd: '.', timeoutSeconds: 300 }, null, 2);

// Monté avec `key={projectId}` : changer de projet repart d'un formulaire et d'une liste vides.
export function CommandTasks({
  projectId,
  hidden,
  panelId,
  labelledBy,
  epicId,
  epics,
  onEpicChange,
  creatingEpic,
  onCreateEpic,
}: {
  projectId: string;
  hidden: boolean;
  panelId: string;
  labelledBy: string;
  epicId: string;
  epics: Epic[];
  onEpicChange: (id: string) => void;
  creatingEpic: boolean;
  onCreateEpic: () => void;
}) {
  const { createTask } = useStore();
  const [commands, setCommands] = useState<ProjectCommand[]>([]);
  const [raw, setRaw] = useState(EMPTY_COMMAND);
  const [autoComplete, setAutoComplete] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current;
    try {
      const list = await apiParsed(`/api/projects/${projectId}/commands`, parseProjectCommands);
      if (loadGeneration.current !== generation) return;
      setCommands(list);
      setSelected((current) => (list.some((command) => command.id === current) ? current : ''));
      setLoaded(true);
    } catch (cause) {
      if (loadGeneration.current !== generation) return;
      setError(errorMessage(cause, 'Chargement des commandes impossible'));
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = (): void => {
    void createTask(projectId, text, {
      epicId: epicId || null,
      execution: { type: 'command', commandId: selected, completion: autoComplete ? 'exit-zero' : 'manual' },
    })
      .then(() => {
        setText('');
        setError(null);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  };

  const saveCommand = (): void => {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    void apiParsed(`/api/projects/${projectId}/commands`, parseProjectCommand, {
      method: 'POST',
      body: JSON.stringify(body),
    })
      .then(async (command) => {
        setError(null);
        await refresh();
        setSelected(command.id);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  };

  const commandConfig = (
    <>
      <textarea
        rows={9}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        aria-label="Configuration de la commande"
        spellCheck={false}
      />
      <button type="button" className="btn" onClick={saveCommand}>
        Enregistrer cette commande
      </button>
    </>
  );

  return (
    <form
      id={panelId}
      role="tabpanel"
      aria-labelledby={labelledBy}
      hidden={hidden}
      className="task-add"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        add();
      }}
    >
      {!loaded ? <p className="hint">Chargement des commandes…</p> : null}
      {commands.length > 0 ? (
        <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Commande du projet">
          <option value="">Choisir une commande</option>
          {commands.map((command) => (
            <option key={command.id} value={command.id}>
              {command.name}
            </option>
          ))}
        </select>
      ) : null}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Description de la tâche"
        aria-label="Description de la tâche"
      />
      <label className="task-command-check">
        <input type="checkbox" checked={autoComplete} onChange={(e) => setAutoComplete(e.target.checked)} />
        Dans un epic, clore automatiquement si le code de sortie vaut zéro
      </label>
      <div className="task-add-actions">
        <EpicSelect epics={epics} value={epicId} onChange={onEpicChange} />
        <button type="submit" className="btn primary" disabled={!selected || text.trim() === ''}>
          Ajouter
        </button>
        <button type="button" className="btn" onClick={onCreateEpic} aria-expanded={creatingEpic}>
          Nouvel epic
        </button>
      </div>
      {loaded && commands.length === 0 ? <div className="task-command-config">{commandConfig}</div> : null}
      {loaded && commands.length > 0 ? (
        // La clé remonte le volet à chaque commande ajoutée : il se replie une fois la nouvelle commande enregistrée
        // et sélectionnée, sans état d'ouverture à piloter.
        <details className="task-command-config" key={commands.length}>
          <summary>Configurer une commande (JSON)</summary>
          {commandConfig}
        </details>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}
