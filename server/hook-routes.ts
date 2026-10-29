import { SLACK_ENABLED } from './config.ts';
import { appendHookLog } from './hook-log.ts';
import { handleHook, isHookPayload } from './hooks.ts';
import { WatchError } from './slack.ts';
import { watchRequestFrom } from './slack-state.ts';
import { isAgent } from '../shared/types.ts';
import { asRecord } from './util.ts';
import { error, routeErrors, statusCodeOf } from './routes-util.ts';
import type { RouteContext } from './route-context.ts';

const { orError: watchOrError } = routeErrors(statusCodeOf(WatchError, 500));

// Routes appelées par les agents (hooks, cerebro-notify), authentifiées par le jeton de la session.
export function registerHookRoutes(ctx: RouteContext): void {
  const { app, sessions, notifier, requireSession, sessionTokenValid, tokenSession } = ctx;

  app.post<{ Params: { id: string } }>('/api/notify/:id', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const session = checked.value;
    const body = asRecord(request.body);
    if (body === null || (body.kind !== 'notify' && body.kind !== 'ask') || typeof body.text !== 'string') {
      return error(reply, 400, 'kind ou text invalide');
    }
    const text = body.text.trim();
    if (text === '' || text.length > 3_000) {
      return error(reply, 400, 'Le texte doit contenir entre 1 et 3 000 caractères');
    }
    appendHookLog({
      at: new Date().toISOString(),
      session: session.id,
      agent: session.agent,
      event: 'cerebro-notify',
      payload: { kind: body.kind, text },
    });
    // Even without Slack, the end of the turn must show as a question in the UI.
    if (body.kind === 'ask') sessions.markAsked(session.id, text);
    if (!SLACK_ENABLED) return error(reply, 503, "Slack n'est pas configuré");
    const refusal = notifier.agentMessagesRefusal(session.id);
    if (refusal !== null) return error(reply, 503, refusal);
    try {
      const outcome = await notifier.agentMessage(session.id, body.kind, text);
      return reply.send({ ok: true, queued: outcome === 'queued' });
    } catch (caught) {
      console.error('[slack]', caught instanceof Error ? caught.message : caught);
      return error(reply, 502, "Impossible d'envoyer le message Slack");
    }
  });

  // Slack threads and channels watched for the session (`cerebro-slack-watch`), read with the user token.
  app.get<{ Params: { id: string } }>('/api/slack-watch/:id', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const listed = await watchOrError(reply, () => notifier.watchesFor(checked.value.id));
    return listed.ok ? reply.send({ watches: listed.value }) : listed.reply;
  });

  app.post<{ Params: { id: string } }>('/api/slack-watch/:id', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const body = asRecord(request.body);
    const asked = body === null ? 'Corps JSON attendu' : watchRequestFrom(body);
    const added = await watchOrError(reply, () => {
      notifier.requireWatches();
      if (typeof asked === 'string') throw new WatchError(400, asked);
      return notifier.addWatch(checked.value.id, asked);
    });
    if (!added.ok) return added.reply;
    return reply.code(added.value.renewed ? 200 : 201).send(added.value);
  });

  app.delete<{ Params: { id: string; ref: string } }>('/api/slack-watch/:id/:ref', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const removed = await watchOrError(reply, () => notifier.removeWatches(checked.value.id, request.params.ref));
    if (!removed.ok) return removed.reply;
    if (removed.value.length === 0) return error(reply, 404, 'Surveillance introuvable pour cette session');
    return reply.send({ removed: removed.value });
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
    appendHookLog({
      at: new Date().toISOString(),
      session: session.id,
      agent: body.agent,
      event: body.event,
      payload: body.payload,
    });
    handleHook(sessions, session.id, body.agent, body.event, body.payload);
    if (body.event === 'PostToolUse') notifier.watchAfterPost(session.id, body.payload);
    return reply.code(204).send();
  });
}
