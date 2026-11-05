import { isAwaiting } from '../format.ts';
import type { Session } from '../../../shared/types.ts';

/**
 * Sessions de l'onglet « À traiter », dans l'ordre du store : celles qui attendent l'utilisateur (`isAwaiting`,
 * terminées comprises si l'attention reste posée), puis celles qui tournent. Pas `needsAttention` : les findings
 * en attente ne se traitent pas depuis la vue mobile et garderaient la session dans la liste.
 */
export function todoSessions<T extends Pick<Session, 'attention' | 'status'>>(
  sessions: readonly T[],
): { awaiting: T[]; running: T[] } {
  const awaiting = sessions.filter(isAwaiting);
  const running = sessions.filter(
    (session) => !isAwaiting(session) && (session.status === 'starting' || session.status === 'running'),
  );
  return { awaiting, running };
}
