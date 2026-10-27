import type { FastifyReply } from 'fastify';
import { errorMessage } from './util.ts';

// Code HTTP d'une erreur levée par une route : fixe, ou déduit de l'erreur.
export type ErrorStatus = number | ((cause: unknown) => number);
export type Outcome<T> = { ok: true; value: T } | { ok: false; reply: FastifyReply };

export function error(reply: FastifyReply, statusCode: number, message: string): FastifyReply {
  return reply.code(statusCode).send({ error: message });
}

// Code porté par les erreurs de `type` (WorktreeError, CouncilError…), `fallback` pour les autres.
export function statusCodeOf(type: abstract new (...args: never[]) => Error & { statusCode: number }, fallback: number): (cause: unknown) => number {
  return cause => cause instanceof type ? cause.statusCode : fallback;
}

// Conversion « erreur levée → réponse HTTP » partagée par toutes les routes : le corps porte le message brut,
// sans préfixe « Error: ». `orError` rend la main à la route ; `attempt` envoie directement le résultat.
export function routeErrors(failure: ErrorStatus) {
  const statusOf = (cause: unknown): number => typeof failure === 'number' ? failure : failure(cause);
  const orError = async <T>(reply: FastifyReply, run: () => T | Promise<T>): Promise<Outcome<T>> => {
    try {
      return { ok: true, value: await run() };
    } catch (cause) {
      return { ok: false, reply: error(reply, statusOf(cause), errorMessage(cause)) };
    }
  };
  const attempt = async (reply: FastifyReply, run: () => unknown, status = 200): Promise<FastifyReply> => {
    const result = await orError(reply, run);
    return result.ok ? reply.code(status).send(result.value) : result.reply;
  };
  return { orError, attempt };
}
