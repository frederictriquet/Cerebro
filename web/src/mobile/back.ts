import { replaceRoute } from '../route.ts';

/**
 * Origine de l'entrée d'historique, gardée dans `history.state` : `entry` pour l'entrée sur laquelle la vue mobile
 * s'est ouverte (lien Slack à froid compris), `internal` pour une entrée créée par une navigation dans la vue
 * mobile. Le retour Android de l'APK (`webView.goBack()`, MainActivity.java) parcourt ce même historique.
 */
const MARK = 'cerebroMobile';

type Mark = 'entry' | 'internal';

function currentMark(): Mark | null {
  const state: unknown = window.history.state;
  if (typeof state !== 'object' || state === null) return null;
  const mark = (state as Record<string, unknown>)[MARK];
  return mark === 'entry' || mark === 'internal' ? mark : null;
}

function stamp(mark: Mark): void {
  const state: unknown = window.history.state;
  const base = typeof state === 'object' && state !== null ? state : {};
  window.history.replaceState({ ...base, [MARK]: mark }, '');
}

/**
 * Marque l'entrée d'ouverture, puis chaque entrée créée par une navigation de la vue mobile (liens `<a href>` et
 * `go()` compris). Une entrée sans marque ne peut être que neuve : un retour arrière ou un `hashchange` sur le même
 * hash retrouve une entrée déjà marquée, qui garde sa marque. Une marque survit au rechargement de la page.
 * Renvoie la fonction de démontage.
 */
export function trackMobileHistory(): () => void {
  if (currentMark() === null) stamp('entry');
  const onHashChange = (): void => {
    if (currentMark() === null) stamp('internal');
  };
  window.addEventListener('hashchange', onHashChange);
  return () => {
    window.removeEventListener('hashchange', onHashChange);
  };
}

/**
 * Bouton ‹ : revient à l'écran précédent quand la vue mobile y est arrivée elle-même, comme le retour Android.
 * Sur l'entrée d'ouverture, remplace l'écran par l'accueil sans ajouter d'entrée : `history.back()` quitterait la
 * vue mobile, ou ne ferait rien dans l'APK.
 */
export function mobileBack(): void {
  if (currentMark() === 'internal') {
    window.history.back();
    return;
  }
  replaceRoute('#/');
}
