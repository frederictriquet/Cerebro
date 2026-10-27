import { appendFileSync } from 'node:fs';
import { HOOK_LOG, SLACK_ENABLED } from './config.ts';
import { handleHook, isHookPayload } from './hooks.ts';
import { isAgent } from '../shared/types.ts';
import { asRecord } from './util.ts';
import { error } from './routes-util.ts';
import type { RouteContext } from './route-context.ts';

// Routes appelées par les agents (hooks, cerebro-notify), authentifiées par le jeton de la session.
export function registerHookRoutes(ctx: RouteContext): void {
  const { app, sessions, notifier, requireSession, sessionTokenValid, tokenSession } = ctx;

  app.post<{ Params: { id: string } }>('/api/notify/:id', async (request, reply) => {
    const session = tokenSession(request, reply);
    if (session === null) return reply;
    const body = asRecord(request.body);
    if (body === null || (body.kind !== 'notify' && body.kind !== 'ask') || typeof body.text !== 'string') {
      return error(reply, 400, 'kind ou text invalide');
    }
    const text = body.text.trim();
    if (text === '' || text.length > 3_000) {
      return error(reply, 400, 'Le texte doit contenir entre 1 et 3 000 caractères');
    }
    appendFileSync(HOOK_LOG, `${JSON.stringify({
      at: new Date().toISOString(),
      session: session.id,
      agent: session.agent,
      event: 'cerebro-notify',
      payload: { kind: body.kind, text },
    })}\n`);
    // Even without Slack, the end of the turn must show as a question in the UI.
    if (body.kind === 'ask') sessions.markAsked(session.id, text);
    if (!SLACK_ENABLED) return error(reply, 503, "Slack n'est pas configuré");
    if (!notifier.agentMessagesAllowed()) {
      return error(reply, 503, "Messages des agents désactivés dans les réglages Slack de Cerebro");
    }
    try {
      await notifier.agentMessage(session.id, body.kind, text);
      return reply.send({ ok: true });
    } catch (caught) {
      console.error('[slack]', caught instanceof Error ? caught.message : caught);
      return error(reply, 502, "Impossible d'envoyer le message Slack");
    }
  });

  app.post<{ Params: { id: string } }>('/api/hook/:id', async (request, reply) => {
    if (!sessionTokenValid(request)) return error(reply, 403, 'Token de hook invalide');
    const body = asRecord(request.body);
    if (body === null || !isAgent(body.agent) || typeof body.event !== 'string' || !isHookPayload(body.payload)) {
      return error(reply, 400, 'Événement de hook invalide');
    }
    const session = requireSession(request, reply);
    if (session === null) return reply;
    if (body.agent !== session.agent) return error(reply, 400, "L'agent ne correspond pas à la session");
    // Keep a trace of every hook event: invaluable to debug state detection.
    appendFileSync(HOOK_LOG, `${JSON.stringify({ at: new Date().toISOString(), session: session.id, agent: body.agent, event: body.event, payload: body.payload })}\n`);
    handleHook(sessions, session.id, body.agent, body.event, body.payload);
    return reply.code(204).send();
  });
}
