import { getAgentAvailability } from './agents.ts';
import { getCatalog, refreshCatalog } from './catalog.ts';
import { incompatibleMessage, syncPayloadFrom } from './peers.ts';
import { TokenUsageTracker } from './token-usage.ts';
import { UpdateManager } from './updates.ts';
import { UsageTracker } from './usage.ts';
import { compatibility, VERSION_INFO } from './version.ts';
import { isAgent } from '../shared/types.ts';
import { asRecord } from './util.ts';
import { error } from './routes-util.ts';
import { orError, type RouteContext } from './route-context.ts';

// Routes propres à la machine : opérations, synchronisation entre machines, agents, quotas, mises à jour, Slack.
export function registerSystemRoutes(ctx: RouteContext): void {
  const { app, db, peers, notifier } = ctx;

  app.get<{Querystring:{projectId?:string}}>('/api/operations',async request=>notifier.operations.list(request.query.projectId));
  app.post<{Params:{id:string}}>('/api/operations/:id/seen',async(request,reply)=>{notifier.operations.seen(request.params.id);return reply.code(204).send();});

  // Prise de main Slack entre machines partageant un projet (voir server/peers.ts).
  app.post('/api/peer/sync', async (request, reply) => {
    const payload = syncPayloadFrom(request.body);
    if (payload === null) return error(reply, 400, 'Échange invalide');
    // Une instance sans version (antérieure) est acceptée ; une autre version majeure est refusée, avec notre version.
    if (payload.version !== null && compatibility(payload.version) === 'incompatible') {
      return reply.code(409).send({ error: incompatibleMessage(payload.machine, payload.version), version: VERSION_INFO });
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
    if (request.query.refresh === '1') await refreshCatalog();
    const [availability, catalog] = await Promise.all([getAgentAvailability(), getCatalog()]);
    return availability.map((info) => ({ ...info, ...catalog[info.agent] }));
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
