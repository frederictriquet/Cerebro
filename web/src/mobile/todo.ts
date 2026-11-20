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

/** Action a session in « À traiter » waits for, named on its card, or null when it waits for nothing. */
export type ExpectedAction = 'Répondre' | 'Autoriser' | 'Relire';

/**
 * [SPEC: vue mobile, accueil] A waiting session asks for an answer, or for a permission when its detail says so; a
 * finished turn that keeps the attention asks to be read. Epic validation is not derived here: it depends on the epic
 * run, and the button under the card already names it.
 */
export function expectedAction(
  session: Pick<Session, 'attention' | 'status' | 'attentionDetail'>,
): ExpectedAction | null {
  if (!isAwaiting(session)) return null;
  if (session.status !== 'waiting') return 'Relire';
  return session.attentionDetail?.kind === 'permission' ? 'Autoriser' : 'Répondre';
}
