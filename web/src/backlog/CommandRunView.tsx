import { useCallback, useEffect, useRef, useState } from 'react';
import { parseCommandRuns, type CommandRun } from '../../../shared/backlog.ts';
import type { Task } from '../../../shared/types.ts';
import { api, apiParsed, markOperationSeen } from '../api.ts';
import { usePolling } from '../polling.tsx';
import { useRunEvents, useStore } from '../store.tsx';

export function CommandRunView({ task, onActive }: { task: Task; onActive: (active: boolean) => void }) {
  const { connected, runPollMs } = useStore();
  const detail = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<CommandRun[]>([]);
  const run = runs[0];
  // Statut suivi par les événements command-run (sans la sortie), ou relu toutes les runPollMs face à une machine
  // qui ne les diffuse pas ; la sortie n'est relue que détail ouvert, chaque seconde tant que la commande tourne.
  const fetchRuns = useCallback(() => apiParsed(`/api/tasks/${task.id}/runs`, parseCommandRuns), [task.id]);
  const pollMs = open && run?.status === 'running' ? 1000 : runPollMs;
  const refresh = usePolling(fetchRuns, pollMs ?? 0, {
    enabled: pollMs !== null,
    onData: (list) => {
      setRuns(list);
      onActive(list[0]?.status === 'running');
    },
    onError: () => {},
  });
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);
  useRunEvents((event) => {
    if (event.type !== 'command-run' || event.run.taskId !== task.id) return;
    setRuns((list) =>
      list[0]?.id === event.run.id
        ? [{ ...list[0], ...event.run }, ...list.slice(1)]
        : [{ ...event.run, output: '' }, ...list],
    );
    onActive(event.run.status === 'running');
    if (event.run.status !== 'running') void refresh();
  });
  useEffect(() => {
    if (detail.current?.open && run?.finishedAt) markOperationSeen(run.id);
  }, [run?.id, run?.finishedAt]);
  return (
    <details
      ref={detail}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
        if (e.currentTarget.open) void refresh();
        if (e.currentTarget.open && run?.finishedAt) markOperationSeen(run.id);
      }}
    >
      <summary>
        Commande — {run?.status ?? 'non exécutée'}
        {run?.status === 'succeeded' && task.status !== 'done' ? ' ; travail à valider' : ''}
      </summary>
      {run ? (
        <>
          <p>
            {run.command.executable} {JSON.stringify(run.command.args)} — {run.cwd}
          </p>
          <p>
            Code : {run.exitCode ?? '—'} ; durée : {Math.floor(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000)}{' '}
            s
          </p>
          <pre>{run.output}</pre>
          {run.error ? <p className="form-error">{run.error}</p> : null}
          {run.status === 'running' ? (
            <button className="btn" onClick={() => void api(`/api/command-runs/${run.id}/stop`, { method: 'POST' })}>
              Arrêter la commande
            </button>
          ) : null}
        </>
      ) : null}
      <p className="hint">
        Un code de sortie nul décrit l’exécution. La clôture du travail reste une validation explicite.
      </p>
    </details>
  );
}
