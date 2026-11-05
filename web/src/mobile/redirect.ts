import { readStored, writeStored } from '../storage.ts';

/** Choix « version complète » fait sur ce navigateur : la page d'accueil ne redirige plus vers /mobile. */
export const FULL_VERSION_KEY = 'cerebro.fullVersion';

const PHONE_QUERY = '(max-width: 800px) and (pointer: coarse)';

/**
 * Sur un écran tactile étroit, remplace `/` par la vue mobile en gardant le hash : un lien d'alerte Slack
 * `/#/s/<id>` ouvre la session dans la vue mobile. Appelée avant tout rendu (`main.tsx`) : sinon le desktop
 * monterait `Term`, qui imposerait la taille du téléphone au PTY partagé. Renvoie true si la page part.
 */
export function redirectToMobile(): boolean {
  if (window.location.pathname !== '/') return false;
  if (!window.matchMedia(PHONE_QUERY).matches) return false;
  if (readStored(FULL_VERSION_KEY) === '1') return false;
  window.location.replace(`/mobile${window.location.hash}`);
  return true;
}

/**
 * Retient le choix de la version complète et l'ouvre sur la même route. Si le choix ne peut pas être enregistré,
 * reste sur place et renvoie l'erreur : `/` renverrait aussitôt le téléphone vers /mobile.
 */
export function openFullVersion(): string | null {
  const error = writeStored(FULL_VERSION_KEY, '1');
  if (error !== null) return error;
  window.location.assign(`/${window.location.hash}`);
  return null;
}
