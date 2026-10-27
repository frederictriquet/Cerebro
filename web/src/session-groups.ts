import { sessionTitle } from './format.ts';
import type { Epic, Session, SessionEpic, Task } from './types.ts';

export type SessionGroup =
  { kind: 'session'; session: Session } | { kind: 'epic'; epic: SessionEpic; projectId: string; sessions: Session[] };

export function sessionEpic(session: Session, tasks: Task[], epics: Epic[]): SessionEpic | null {
  let origin = session.epic;
  if (!origin) {
    // Compatibilité avec les serveurs antérieurs. Une session qui a créé le backlog
    // n'est pas une session qui l'a traité ; seul sessionId représente l'affectation.
    const ids = new Set(
      tasks
        .filter((task) => task.projectId === session.projectId && task.sessionId === session.id && task.epicId)
        .map((task) => task.epicId),
    );
    if (ids.size !== 1) return null;
    origin = epics.find((epic) => epic.projectId === session.projectId && ids.has(epic.id)) ?? null;
  }
  if (!origin) return null;
  const current = epics.find((epic) => epic.id === origin.id && epic.projectId === session.projectId);
  return { id: origin.id, title: current?.title ?? origin.title };
}

// Conserve l'ordre de création fourni par le store. Un groupe occupe la place de
// sa session la plus récente ; l'activité et le repli ne déplacent aucun élément.
export function groupSessions(sessions: Session[], tasks: Task[], epics: Epic[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  const byEpic = new Map<string, Extract<SessionGroup, { kind: 'epic' }>>();
  for (const session of sessions) {
    const epic = sessionEpic(session, tasks, epics);
    if (!epic) {
      groups.push({ kind: 'session', session });
      continue;
    }
    const key = JSON.stringify([session.projectId, epic.id]);
    const group = byEpic.get(key);
    if (group) group.sessions.push(session);
    else {
      const next = { kind: 'epic' as const, epic, projectId: session.projectId, sessions: [session] };
      byEpic.set(key, next);
      groups.push(next);
    }
  }
  return groups;
}

export function groupedSessionTitle(session: Session): string {
  const title = sessionTitle(session.title);
  // Le nom de l'epic est déjà dans l'en-tête. Ne raccourcir que les titres générés.
  return session.prompt.startsWith('[CEREBRO_EPIC_STEP ')
    ? title.replace(/^Epic « .* » · (?=étape \d+\/\d+ :)/, '')
    : title;
}
