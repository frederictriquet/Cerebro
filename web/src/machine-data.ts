import type { Epic, EventsMessage, Project, Session, Task } from '../../shared/types.ts';

/** Listes qu'une machine diffuse par /ws/events. */
export interface MachineData {
  projects: Project[];
  sessions: Session[];
  tasks: Task[];
  epics: Epic[];
}

// L'activité (statut, titre, attention) ne déplace pas une session.
export function sortSessions(list: Session[]): Session[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

/** Remplace l'élément de même id, sinon l'ajoute en tête (start) ou en fin de liste. */
export function upsertById<T extends { id: string }>(
  list: readonly T[],
  item: T,
  insert: 'start' | 'end' = 'end',
): T[] {
  const i = list.findIndex((existing) => existing.id === item.id);
  if (i === -1) return insert === 'start' ? [item, ...list] : [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function upsertSession(list: Session[], session: Session): Session[] {
  return sortSessions(upsertById(list, session, 'start'));
}

/**
 * Applique un message de /ws/events aux listes d'une machine. Rend `data` tel quel pour un message sans liste,
 * et null tant qu'aucun snapshot n'a fourni de base. Le store applique les mêmes règles à ses propres états.
 */
export function applyEventsMessage(data: MachineData | null, msg: EventsMessage): MachineData | null {
  if (msg.type === 'snapshot') {
    return { projects: msg.projects, sessions: sortSessions(msg.sessions), tasks: msg.tasks, epics: msg.epics };
  }
  if (data === null) return null;
  switch (msg.type) {
    case 'session':
    case 'alert':
    case 'findings-available':
      return { ...data, sessions: upsertSession(data.sessions, msg.session) };
    case 'session-deleted':
      return { ...data, sessions: data.sessions.filter((s) => s.id !== msg.id) };
    case 'task':
      return { ...data, tasks: upsertById(data.tasks, msg.task) };
    case 'task-deleted':
      return { ...data, tasks: data.tasks.filter((t) => t.id !== msg.id) };
    case 'epic':
      return { ...data, epics: upsertById(data.epics, msg.epic) };
    case 'epic-deleted':
      return { ...data, epics: data.epics.filter((e) => e.id !== msg.id) };
    case 'projects':
      return { ...data, projects: msg.projects };
    default:
      return data;
  }
}

// Dernier état connu de chaque machine ('local' ou id distant) dans cette page. Le store de la machine affichée
// et les surveillances des autres le tiennent à jour : une bascule l'affiche aussitôt, puis le snapshot le remplace.
const lastKnown = new Map<string, MachineData>();

export function lastKnownData(machine: string): MachineData | undefined {
  return lastKnown.get(machine);
}

export function rememberData(machine: string, data: MachineData): void {
  lastKnown.set(machine, data);
}
