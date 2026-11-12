// Saisie dans une session depuis Slack ou l'interface web : texte tapé, réponse aux questions de l'agent.
import type { AgentQuestion } from './questions.ts';
import type { SessionManager } from './sessions.ts';

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Types `text` then Enter into a session; an open question dialog is dismissed (Esc) first. */
export async function typeIntoSession(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  dismissDialog = false,
): Promise<boolean> {
  if (dismissDialog) {
    if (!sessions.writeInput(sessionId, '\x1b')) return false;
    sessions.setPendingQuestions(sessionId, null);
    await delay(800);
  }
  if (!sessions.writeInput(sessionId, text)) return false;
  await delay(150);
  return sessions.writeInput(sessionId, '\r');
}

export function sameQuestions(left: AgentQuestion[] | null, right: AgentQuestion[]): boolean {
  return left === right || (left !== null && JSON.stringify(left) === JSON.stringify(right));
}

/**
 * Le dialogue est fermé (Échap) et la réponse tapée comme prochain message : piloter touche par touche un
 * dialogue à plusieurs onglets casserait dès que sa disposition change. `asked` : les questions auxquelles
 * la réponse se rapporte ; si elles ne sont plus affichées (répondues ou fermées entre-temps), la réponse
 * devient un message ordinaire.
 */
export function answerQuestions(
  sessions: SessionManager,
  sessionId: string,
  asked: AgentQuestion[],
  answer: string,
  origin: string,
): Promise<boolean> {
  const dialogOpen = sameQuestions(sessions.pendingQuestions(sessionId), asked);
  const prefix = dialogOpen
    ? `[Réponse ${origin} à tes questions, le dialogue a été fermé]`
    : `[Réponse ${origin} à tes questions]`;
  return typeIntoSession(sessions, sessionId, `${prefix} ${answer.replace(/\s*\n+\s*/g, ' ')}`, dialogOpen);
}
