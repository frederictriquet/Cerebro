import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AGENTS } from './agents.ts';
import { CouncilError, CouncilRuns } from './council-runner.ts';
import { exportMarkdown, validateCouncilSettings } from './council.ts';
import type { CerebroDatabase } from './db.ts';
import { imageMediaType } from './headless.ts';

// Réglages globaux, lancement, suivi et export des councils ; le gestionnaire est renvoyé pour câblage.
export function registerCouncilRoutes(app: FastifyInstance, db: CerebroDatabase): CouncilRuns {
  const councils = new CouncilRuns(db);
  const attempt = async (reply: FastifyReply, run: () => Promise<unknown>, status = 200): Promise<unknown> => {
    try {
      return reply.code(status).send(await run());
    } catch (cause) {
      return reply.code(cause instanceof CouncilError ? cause.statusCode : 500).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  app.get('/api/council/settings', async () => councils.settingsFor(null));
  app.put('/api/council/settings', async (request, reply) => {
    // Mêmes agents acceptés que pour la surcharge projet : une CLI absente n'invalide pas les réglages.
    const result = validateCouncilSettings(request.body, db.listPersonas(), AGENTS);
    if ('error' in result) return reply.code(400).send({ error: result.error });
    db.putSetting('council', result.settings);
    return result.settings;
  });
  // Réglages appliqués à un lancement : surcharge du projet, sinon réglages globaux.
  app.get<{ Querystring: { projectId?: string } }>('/api/council/settings/effective', async (request, reply) => {
    const projectId = request.query.projectId;
    if (projectId === undefined || projectId === '' || projectId === 'none') return councils.settingsFor(null);
    const project = db.getProject(projectId);
    return project === null ? reply.code(404).send({ error: 'Projet introuvable.' }) : councils.settingsFor(project);
  });

  app.post('/api/councils', async (request, reply) => attempt(reply, async () => {
    const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
    const projectId = body.projectId ?? null;
    if (projectId !== null && typeof projectId !== 'string') throw new CouncilError('Projet invalide.');
    return councils.start({
      projectId, origin: 'web', question: body.question as string, context: body.context as string | undefined,
      readProject: body.readProject as boolean | undefined, participants: body.participants, images: body.images,
    }, body.requestId);
  }, 202));
  // projectId absent : tous les councils ; `none` : ceux lancés hors projet.
  app.get<{ Querystring: { projectId?: string } }>('/api/councils', async (request) => {
    const projectId = request.query.projectId;
    return councils.list(projectId === undefined ? undefined : projectId === 'none' ? null : projectId);
  });
  app.get<{ Params: { id: string } }>('/api/councils/:id', async (request, reply) => {
    return councils.get(request.params.id) ?? reply.code(404).send({ error: 'Council introuvable.' });
  });
  // Image jointe `[Image #n]` d'un run, pour l'afficher dans le rapport.
  app.get<{ Params: { id: string; n: string } }>('/api/councils/:id/images/:n', async (request, reply) => {
    const run = councils.get(request.params.id);
    const image = run?.images.find((entry) => String(entry.n) === request.params.n);
    const type = image === undefined ? null : imageMediaType(image.path);
    if (run === null || image === undefined || type === null) return reply.code(404).send({ error: 'Image introuvable.' });
    const stream = createReadStream(image.path);
    stream.on('error', (cause) => { request.log.warn({ err: cause, path: image.path }, 'image du council illisible'); });
    return reply.header('content-type', type).header('content-disposition', `inline; filename="${basename(image.path)}"`).send(stream);
  });
  app.post<{ Params: { id: string } }>('/api/councils/:id/cancel', async (request, reply) => attempt(reply, async () => councils.cancel(request.params.id)));
  app.delete<{ Params: { id: string } }>('/api/councils/:id', async (request, reply) => attempt(reply, async () => {
    councils.delete(request.params.id);
    return null;
  }, 204));
  app.get<{ Params: { id: string } }>('/api/councils/:id/export', async (request, reply) => {
    const run = councils.get(request.params.id);
    if (run === null) return reply.code(404).send({ error: 'Council introuvable.' });
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="council-${run.id.slice(0, 8)}.md"`)
      .send(exportMarkdown(run));
  });
  return councils;
}
