// Partagé par le serveur (lancement depuis Slack, server/slack-format.ts ; compte-rendu, server/council.ts) et
// l'interface (catalogue des personas, lancement et rapport, web/src/PersonasDialog.tsx, web/src/CouncilLaunch.tsx et
// web/src/CouncilRunView.tsx).
import type { CouncilVerdict, PersonaNeed } from './types.ts';

// Accès qu'un council donne à ses conseillers.
export type CouncilAccess = Record<PersonaNeed, boolean>;

export interface MissingAccess {
  name: string;
  needs: PersonaNeed[];
}

const NEED_LABELS: Record<PersonaNeed, string> = { project: 'du dépôt', web: 'du web' };

// Complément de « a besoin » : « du dépôt et du web ».
export function needsText(needs: readonly PersonaNeed[]): string {
  return needs.map((need) => NEED_LABELS[need]).join(' et ');
}

// Personas qui ont besoin d'un accès que le council ne donne pas, avec ces seuls accès, dans l'ordre reçu.
// `needs` absent : copie figée d'un run antérieur aux besoins d'accès.
export function missingAccess(
  personas: readonly { name: string; needs?: readonly PersonaNeed[] }[],
  access: CouncilAccess,
): MissingAccess[] {
  return personas.flatMap(({ name, needs = [] }) => {
    const missing = needs.filter((need) => !access[need]);
    return missing.length === 0 ? [] : [{ name, needs: missing }];
  });
}

// Avertissement non bloquant qui nomme chaque persona privée d'un accès dont elle a besoin ; null sans manque.
export function accessWarning(
  personas: readonly { name: string; needs?: readonly PersonaNeed[] }[],
  access: CouncilAccess,
): string | null {
  const missing = missingAccess(personas, access);
  if (missing.length === 0) return null;
  const clauses = missing.map(({ name, needs }) => `${name} a besoin ${needsText(needs)}`);
  const evidence = missing.length > 1 ? 'leurs preuves risquent' : 'ses preuves risquent';
  return `${clauses.join(', ')} : ce council n’y donne pas accès, ${evidence} d’être inventées.`;
}

const VERDICT_LABELS: Record<CouncilVerdict, string> = {
  good: 'Bonne issue',
  mixed: 'Issue mitigée',
  bad: 'Mauvaise issue',
};

// Verdict porté sur l'issue observée d'un council ; null : pas encore jugée.
export function verdictLabel(verdict: CouncilVerdict | null): string {
  return verdict === null ? 'Non tranché' : VERDICT_LABELS[verdict];
}
