import { getAgentAvailability } from './agents.ts';
import { incompatibleMessage, syncPayloadFrom } from './peers.ts';
import { TokenUsageTracker } from './token-usage.ts';
import { UpdateManager } from './updates.ts';
import { UsageTracker } from './usage.ts';
import { compatibility, VERSION_INFO } from './version.ts';
import { isAgent } from '../shared/types.ts';
import { asRecord } from './util.ts';
import { error, routeErrors, statusCodeOf } from './routes-util.ts';
import { orError, type RouteContext } from './route-context.ts';
import { WatchError } from './slack.ts';
import { deliveryModes, WATCH_LABEL_MAX, watchRequestFrom } from './slack-state.ts';
import { parseSlackPermalink } from '../bin/slack-permalink.mjs';
import { WATCH_DELIVERIES } from '../shared/machine.ts';

const { orError: watchOrError } = routeErrors(statusCodeOf(WatchError, 500));

// Routes propres à la machine : opérations, synchronisation entre machines, agents, quotas, mises à jour, Slack.
export function registerSystemRoutes(ctx: RouteContext): void {
  const { app, db, peers, notifier, catalog } = ctx;

  app.get<{ Querystring: { projectId?: string } }>('/api/operations', async (request) =>
    notifier.operations.list(request.query.projectId),
  );
  app.post<{ Params: { id: string } }>('/api/operations/:id/seen', async (request, reply) => {
    notifier.operations.seen(request.params.id);
    return reply.code(204).send();
  });

  // Prise de main Slack entre machines partageant un projet (voir server/peers.ts).
  app.post('/api/peer/sync', async (request, reply) => {
    const payload = syncPayloadFrom(request.body);
    if (payload === null) return error(reply, 400, 'Échange invalide');
    // Une instance sans version (antérieure) est acceptée ; une autre version majeure est refusée, avec notre version.
    if (payload.version !== null && compatibility(payload.version) === 'incompatible') {
      return reply
        .code(409)
        .send({ error: incompatibleMessage(payload.machine, payload.version), version: VERSION_INFO });
    }
    await peers.ready;
    return reply.send(peers.receive(payload));
  });

  app.get('/api/version', async () => VERSION_INFO);

  app.get('/api/peer/notices', async () => peers.notices());

  // Commandes Slack sans projet (aide, liste, questions « ? ») : une seule machine les traite.
  app.get('/api/slack/general', async () => {
    await peers.ready;
    return peers.generalStatus();
  });

  app.post('/api/slack/general/acquire', async () => {
    await peers.ready;
    return peers.acquireGeneral();
  });

  app.post<{ Params: { id: string } }>('/api/peer/notices/:id/dismiss', async (request, reply) => {
    if (!peers.dismissNotice(request.params.id)) return error(reply, 404, 'Avertissement introuvable');
    return reply.code(204).send();
  });

  app.get<{ Querystring: { refresh?: string } }>('/api/agents', async (request) => {
    // Rafraîchissement demandé : redécouvre le catalogue d'un agent installé depuis le démarrage.
    if (request.query.refresh === '1') await catalog.refresh();
    const [availability, catalogs] = await Promise.all([getAgentAvailability(), catalog.get()]);
    return availability.map((info) => ({ ...info, ...catalogs[info.agent] }));
  });

  const usage = new UsageTracker();
  app.get('/api/usage', async () => usage.get());
  const tokenUsage = new TokenUsageTracker();
  app.get('/api/usage/tokens', async () => tokenUsage.get(db.listSessions()));

  const updates = new UpdateManager();
  updates.start();
  app.addHook('onClose', async () => updates.stop());
  app.get('/api/updates', async () => updates.list());

  app.post('/api/updates/check', async () => {
    await updates.checkAll();
    return updates.list();
  });

  app.post<{ Params: { agent: string } }>('/api/updates/:agent', async (request, reply) => {
    if (!isAgent(request.params.agent)) return error(reply, 404, 'Agent inconnu');
    return reply.code(202).send(updates.update(request.params.agent));
  });

  app.patch<{ Params: { agent: string } }>('/api/updates/:agent', async (request, reply) => {
    if (!isAgent(request.params.agent)) return error(reply, 404, 'Agent inconnu');
    const body = asRecord(request.body);
    if (body === null || typeof body.auto !== 'boolean') return error(reply, 400, 'auto (booléen) attendu');
    return reply.send(updates.setAuto(request.params.agent, body.auto));
  });

  app.get('/api/slack', async () => notifier.status());

  // Watched threads and channels of every session; the web UI filters them by project or session.
  app.get('/api/slack/watches', async () => notifier.allWatches());

  // Watch added from the web UI: a Slack link (thread, message or channel) and an optional label.
  app.post<{ Params: { sessionId: string } }>('/api/slack/watches/:sessionId', async (request, reply) => {
    if (db.getSession(request.params.sessionId) === null) return error(reply, 404, 'Session introuvable');
    const body = asRecord(request.body);
    const link = typeof body?.link === 'string' ? parseSlackPermalink(body.link.trim()) : null;
    const asked =
      link === null
        ? 'Lien Slack attendu (« Copier le lien » d’un message ou d’un canal)'
        : watchRequestFrom({ ...link, ...(body?.label === undefined ? {} : { label: body.label }) });
    const result = await watchOrError(reply, () => {
      notifier.requireWatches();
      if (typeof asked === 'string') throw new WatchError(400, asked);
      return notifier.addWatch(request.params.sessionId, asked);
    });
    if (!result.ok) return result.reply;
    return reply.code(result.value.renewed ? 200 : 201).send(result.value);
  });

  app.delete<{ Params: { sessionId: string; watchId: string } }>(
    '/api/slack/watches/:sessionId/:watchId',
    async (request, reply) => {
      const result = await watchOrError(reply, () =>
        notifier.removeWatches(request.params.sessionId, request.params.watchId),
      );
      if (!result.ok) return result.reply;
      if (result.value.length === 0) return error(reply, 404, 'Surveillance introuvable');
      return reply.send({ removed: result.value });
    },
  );

  // Delivery of one watch (a non-empty list of modes, or null to follow the settings again) and/or its label
  // (empty to remove it).
  app.patch<{ Params: { sessionId: string; watchId: string } }>(
    '/api/slack/watches/:sessionId/:watchId',
    async (request, reply) => {
      const body = asRecord(request.body) ?? {};
      const { sessionId, watchId } = request.params;
      const asked = body.deliver;
      const deliver = asked === null ? null : deliveryModes(asked, WATCH_DELIVERIES, false);
      const label = typeof body.label === 'string' ? body.label.trim() : null;
      const result = await watchOrError(reply, () => {
        notifier.requireWatches();
        if (asked === undefined && body.label === undefined) throw new WatchError(400, 'deliver ou label attendu');
        if (asked !== undefined && asked !== null && deliver === null)
          throw new WatchError(
            400,
            `deliver attendu : null ou un ou plusieurs modes parmi ${WATCH_DELIVERIES.join(', ')}`,
          );
        if (body.label !== undefined && (label === null || label.length > WATCH_LABEL_MAX))
          throw new WatchError(400, `Libellé invalide : ${WATCH_LABEL_MAX} caractères au plus`);
        let watch = asked === undefined ? undefined : notifier.setWatchDelivery(sessionId, watchId, deliver);
        if (label !== null && watch !== null) watch = notifier.setWatchLabel(sessionId, watchId, label);
        return watch ?? null;
      });
      if (!result.ok) return result.reply;
      if (result.value === null) return error(reply, 404, 'Surveillance introuvable');
      return reply.send({ watch: result.value });
    },
  );

  app.patch('/api/slack', async (request, reply) => {
    const body = asRecord(request.body);
    if (body === null) return error(reply, 400, 'Corps invalide');
    const result = await orError(reply, async () => {
      const settings = notifier.updateSettings(body);
      if (settings !== null) await notifier.settingsSaved();
      return settings;
    });
    if (!result.ok) return result.reply;
    if (result.value === null) return error(reply, 400, 'Réglages Slack invalides');
    return reply.send(notifier.status());
  });
}
