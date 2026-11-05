import type { Agent, SessionDefaults } from '../../../shared/types.ts';

/**
 * Corps de POST /api/projects/:id/sessions envoyé par la vue mobile. Le serveur mémorise agent, mode et modèle du
 * lancement dans les réglages par défaut du projet (`launchSession`, server/route-context.ts). Avec l'agent du
 * projet, seul le prompt part : les champs omis reprennent ces réglages. Avec un autre agent, modèle et effort
 * repartent du défaut de Cerebro, et le formulaire desktop affichera ensuite cet agent avec ces valeurs.
 */
export function launchSpec(projectAgent: Agent, agent: Agent, prompt: string): Partial<SessionDefaults> {
  return agent === projectAgent ? { prompt } : { agent, prompt, model: null, effort: null };
}
