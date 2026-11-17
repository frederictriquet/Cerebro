import type { SessionDefaults, SessionLaunchSpec } from '../../../shared/types.ts';

/**
 * Corps de POST /api/projects/:id/sessions envoyé par la vue mobile : tous les choix du formulaire partent
 * explicitement. Le serveur les mémorise comme réglages par défaut du projet (`launchSession`,
 * server/route-context.ts), comme au lancement depuis le bureau ; `extensionIds` ne vaut que pour la session lancée.
 */
export function launchSpec(
  choice: Pick<SessionDefaults, 'agent' | 'model' | 'effort' | 'mode'>,
  prompt: string,
  extensionIds?: string[],
): Partial<SessionLaunchSpec> {
  return {
    agent: choice.agent,
    model: choice.model,
    effort: choice.effort,
    mode: choice.mode,
    prompt,
    ...(extensionIds === undefined ? {} : { extensionIds }),
  };
}
