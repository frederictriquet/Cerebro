import type { Epic, Session, Task } from '../types.ts';

export function taskTitle(text: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? text
  );
}

const TASK_STATUS_LABEL: Record<Task['status'], string> = {
  todo: 'À faire',
  started: 'En cours',
  done: 'Terminée',
};

// Tâches de `tasks` dont `id` dépend, directement ou non : en dépendre créerait un cycle.
export function dependents(id: string, tasks: Task[]): Set<string> {
  const found = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const t of tasks) {
      if (t.dependsOn.includes(current) && !found.has(t.id)) {
        found.add(t.id);
        stack.push(t.id);
      }
    }
  }
  return found;
}

// Ordre de traitement des tâches : chacune après celles dont elle dépend parmi `tasks`, sinon dans
// l'ordre de création. Les dépendances hors de `tasks` sont ignorées.
export function dependencyOrder(tasks: Task[]): Task[] {
  const ids = new Set(tasks.map((t) => t.id));
  const placed = new Set<string>();
  const ordered: Task[] = [];
  let remaining = tasks;
  while (remaining.length > 0) {
    const ready = remaining.filter((t) => t.dependsOn.every((id) => !ids.has(id) || placed.has(id)));
    // Un cycle est refusé par le serveur ; par prudence on place le reste tel quel.
    const batch = ready.length > 0 ? ready.slice(0, 1) : remaining;
    for (const t of batch) {
      placed.add(t.id);
      ordered.push(t);
    }
    remaining = remaining.filter((t) => !placed.has(t.id));
  }
  return ordered;
}

// Prompt de la session qui pilote l'epic : le serveur ordonne les tâches et confie chacune à sa propre étape.
export function epicPrompt(epic: Epic): string {
  return `Traiter l’epic « ${epic.title} ». Le serveur calcule l’ordre, lance chaque tâche et attend sa clôture explicite. Ne traite que l’étape confiée à chaque session.
${epic.description}`;
}

// Une tâche lancée suit l'état de sa session : « En cours » tant que l'agent travaille,
// puis « À valider » une fois son tour fini (la clôture reste manuelle).
export function taskPill(
  task: Task,
  session: Session | undefined,
  blocked: boolean,
): { label: string; className: string } {
  if (task.status === 'todo' && blocked) return { label: 'Bloquée', className: 'blocked' };
  if (task.status !== 'started') return { label: TASK_STATUS_LABEL[task.status], className: task.status };
  if (task.execution?.type === 'command') return { label: 'Commande — voir résultat', className: 'started' };
  switch (session?.status) {
    case 'starting':
    case 'running':
      return { label: 'En cours', className: 'started' };
    case 'waiting':
      return { label: 'En attente', className: 'waiting' };
    default:
      return { label: 'À valider', className: 'review' };
  }
}

export const errorMessage = (err: unknown, fallback: string): string => (err instanceof Error ? err.message : fallback);
