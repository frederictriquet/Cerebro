import { useState } from 'react';
import type { Epic, Task } from '../../../shared/types.ts';
import { delegateItem } from '../api.ts';
import { errorMessage, TASK_STATUS_LABEL } from '../format.ts';
import { href } from '../route.ts';
import { useStore } from '../store.tsx';

function ProjectLink({ projectId }: { projectId: string }) {
  const { projects } = useStore();
  const project = projects.find((p) => p.id === projectId);
  if (project === undefined) return null;
  return <a href={href(`#/p/${encodeURIComponent(project.id)}`)}>{project.name}</a>;
}

// Traitement dans un autre projet : « Traité dans X » sur la source, « Provenant du projet X » sur la copie.
export function TaskDelegation({ task }: { task: Task }) {
  const { tasks } = useStore();
  const copy = tasks.find((t) => t.originTaskId === task.id);
  const source = task.originTaskId === null ? undefined : tasks.find((t) => t.id === task.originTaskId);
  if (copy === undefined && source === undefined) return null;
  return (
    <>
      {copy ? (
        <span className="pill task-status">
          <span>
            Traité dans <ProjectLink projectId={copy.projectId} /> · {TASK_STATUS_LABEL[copy.status]}
          </span>
        </span>
      ) : null}
      {source ? (
        <span className="pill task-status">
          <span>
            Provenant du projet <ProjectLink projectId={source.projectId} />
          </span>
        </span>
      ) : null}
    </>
  );
}

export function EpicDelegation({ epic }: { epic: Epic }) {
  const { epics, tasks } = useStore();
  const copy = epics.find((e) => e.originEpicId === epic.id);
  const source = epic.originEpicId === null ? undefined : epics.find((e) => e.id === epic.originEpicId);
  if (copy === undefined && source === undefined) return null;
  const members = copy ? tasks.filter((t) => t.epicId === copy.id) : [];
  return (
    <>
      {copy ? (
        <span className="pill task-status">
          <span>
            Traité dans <ProjectLink projectId={copy.projectId} /> · {members.filter((t) => t.status === 'done').length}
            /{members.length} terminée(s)
          </span>
        </span>
      ) : null}
      {source ? (
        <span className="pill task-status">
          <span>
            Provenant du projet <ProjectLink projectId={source.projectId} />
          </span>
        </span>
      ) : null}
    </>
  );
}

// Choix du projet qui traitera la tâche ou l'epic ; la copie arrive dans son backlog par le flux temps réel.
export function DelegateButton({
  kind,
  id,
  projectId,
  onError,
}: {
  kind: 'tasks' | 'epics';
  id: string;
  projectId: string;
  onError: (message: string | null) => void;
}) {
  const { projects } = useStore();
  const others = projects.filter((p) => p.id !== projectId);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  if (others.length === 0) return null;
  if (!open)
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Traiter dans un autre projet…
      </button>
    );
  const submit = async (): Promise<void> => {
    if (busy || target === '') return;
    setBusy(true);
    onError(null);
    try {
      await delegateItem(kind, id, target);
      setOpen(false);
    } catch (err) {
      onError(errorMessage(err, 'Délégation impossible'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="row-actions">
      <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Projet qui traitera">
        <option value="">Projet qui traitera…</option>
        {others.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button type="button" className="btn primary" disabled={busy || target === ''} onClick={() => void submit()}>
        Déléguer
      </button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>
        Annuler
      </button>
    </span>
  );
}
