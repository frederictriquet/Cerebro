import type { SessionDefaults } from '../../../shared/types.ts';

/**
 * Corps de POST /api/projects/:id/sessions envoyé par la vue mobile : tous les choix du formulaire partent
 * explicitement. Le serveur les mémorise comme réglages par défaut du projet (`launchSession`,
 * server/route-context.ts), comme au lancement depuis le bureau.
 */
export function launchSpec(
  choice: Pick<SessionDefaults, 'agent' | 'model' | 'effort' | 'mode'>,
  prompt: string,
): Partial<SessionDefaults> {
  return { agent: choice.agent, model: choice.model, effort: choice.effort, mode: choice.mode, prompt };
}
