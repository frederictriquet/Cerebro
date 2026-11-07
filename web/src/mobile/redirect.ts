import { machineHash } from '../route.ts';
import { readStored, writeStored } from '../storage.ts';
import type { Project } from '../../../shared/types.ts';

/**
 * Choix « version complète » fait sur ce navigateur : la page d'accueil ne redirige plus vers /mobile, jusqu'à la
 * prochaine ouverture de la vue mobile (`forgetFullVersion`).
 */
export const FULL_VERSION_KEY = 'cerebro.fullVersion';

const PHONE_QUERY = '(max-width: 800px) and (pointer: coarse)';

/**
 * Chemin de la vue mobile, barres finales comprises : le serveur sert aussi index.html pour `/mobile/`, et y
 * monter le desktop ferait monter `Term`, qui imposerait la taille du téléphone au PTY partagé.
 */
export function isMobilePath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === '/mobile';
}

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
 * Hash du projet épinglé de la machine quand la vue mobile n'a pas encore de route (l'APK charge `/mobile` sans
 * hash), sinon null. Un lien d'alerte (`#/s/<id>`) ou un `#/` explicite, comme celui que pose ‹, gardent leur route.
 */
export function pinnedProjectHash(hash: string, projects: readonly Pick<Project, 'id' | 'pinned'>[]): string | null {
  if (hash !== '') return null;
  const target = machineHash(null, projects);
  return target === '#/' ? null : target;
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

/**
 * Efface le choix de la version complète : ouvrir la vue mobile vaut choix du mobile. Sinon un lien d'alerte Slack
 * `/#/s/<id>` ouvrirait pour toujours le desktop sur le téléphone, et `Term` imposerait sa largeur au PTY partagé.
 * Renvoie le message d'erreur si le stockage échoue.
 */
export function forgetFullVersion(): string | null {
  return writeStored(FULL_VERSION_KEY, null);
}
