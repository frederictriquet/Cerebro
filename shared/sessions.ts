// Partagé par le serveur (purge, server/sessions.ts) et l'interface (statut affiché, web/src/format.ts).

// Une session inactive ou terminée depuis plus d'une heure passe « en sommeil », signe qu'on n'en
// aura sans doute plus besoin : ce sont celles que la purge supprime.
export const DORMANT_AFTER_MS = 60 * 60_000;

export function isDormant(
  session: { status: string; updatedAt: number; pendingFindings?: number },
  now: number,
): boolean {
  return (
    !session.pendingFindings &&
    (session.status === 'idle' || session.status === 'exited') &&
    now - session.updatedAt >= DORMANT_AFTER_MS
  );
}
