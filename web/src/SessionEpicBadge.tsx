import { sessionEpic } from './session-groups.ts';
import { useStore } from './store.tsx';
import type { Session } from '../../shared/types.ts';

export function SessionEpicBadge({ session }: { session: Session }) {
  const { tasks, epics } = useStore();
  const epic = sessionEpic(session, tasks, epics);
  return epic ? <span className="session-epic-badge" title={`Epic : ${epic.title}`}>Epic · {epic.title}</span> : null;
}
