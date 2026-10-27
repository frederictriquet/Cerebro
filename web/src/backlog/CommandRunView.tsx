import { useEffect, useRef, useState } from 'react';
import type { CommandRun } from '../../../server/commands.ts';
import { api, markOperationSeen } from '../api.ts';
import type { Task } from '../types.ts';

export function CommandRunView({ task, onActive }: { task: Task; onActive: (active: boolean) => void }) {
  const detail = useRef<HTMLDetailsElement>(null);
  const [runs, setRuns] = useState<CommandRun[]>([]);
  useEffect(() => {
    const refresh = async (): Promise<void> => {
      const runs = await api<CommandRun[]>(`/api/tasks/${task.id}/runs`);
      setRuns(runs);
      onActive(runs[0]?.status === 'running');
    };
    void refresh().catch(() => {});
    const timer = window.setInterval(() => void refresh().catch(() => {}), 1000);
    return () => window.clearInterval(timer);
  }, [task.id, onActive]);
  const run = runs[0];
  useEffect(() => {
    if (detail.current?.open && run?.finishedAt) markOperationSeen(run.id);
  }, [run?.id, run?.finishedAt]);
  return (
    <details
      ref={detail}
      onToggle={(e) => {
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
