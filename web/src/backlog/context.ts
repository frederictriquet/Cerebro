import { createContext, useContext } from 'react';
import type { Epic, Task } from '../types.ts';

// Ce que les blocs d'epic et les lignes de tâche partagent avec le backlog qui les affiche : les tâches et
// epics du projet, le suivi des lancements (la modale se ferme, le backlog garde l'état « Lancement… »)
// et la zone d'erreur commune.
export interface BacklogScope {
  projectId: string;
  projectTasks: Task[];
  epics: Epic[];
  launching: ReadonlySet<string>;
  startTask: (task: Task) => void;
  startEpic: (epic: Epic, prompt: string) => void;
  // null efface l'erreur affichée.
  reportError: (message: string | null) => void;
}

export const BacklogContext = createContext<BacklogScope | null>(null);

export function useBacklog(): BacklogScope {
  const scope = useContext(BacklogContext);
  if (!scope) throw new Error('Backlog manquant');
  return scope;
}
