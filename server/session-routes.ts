import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ATTACHMENTS_DIR } from './config.ts';
import { importFindings, listReports } from './findings.ts';
import { sessionProvenance } from './provenance.ts';
import { sessionGitContext } from './session-git.ts';
import { startingResolutionPrompt } from './starting-resolution.ts';
import { conflictResolutionPrompt } from './conflict-resolution.ts';
import { councilSessionPrompt, exportMarkdown } from './council.ts';
import { MAX_CONTEXT_LENGTH } from './council-runner.ts';
import { readSessionTranscript, transcriptContext } from './transcripts.ts';
import { WorktreeError } from './worktrees.ts';
import { normalizeMode } from '../shared/types.ts';
import { asRecord, errorMessage } from './util.ts';
import { error, routeErrors, statusCodeOf } from './routes-util.ts';
import { badRequest, orError, sendSocket, type RouteContext } from './route-context.ts';

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// Sous la limite d'un argument de commande (128 Kio sous Linux), consignes de l'agent comprises.
const MAX_INLINE_COUNCIL_REPORT_BYTES = 100 * 1024;
// Contexte d'un council tiré d'une session : de la marge pour ce que l'utilisateur y ajoute.
const COUNCIL_CONTEXT_FROM_SESSION = MAX_CONTEXT_LENGTH - 10_000;

const worktreeConflict = routeErrors(statusCodeOf(WorktreeError, 409));

// Saves a pasted image under DATA_DIR/attachments/<owner>/ and returns its absolute path,
// which the agent can read (Claude/Codex turn an image path in the prompt into an attachment).
function saveImage(owner: string, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const type = (request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const extension = IMAGE_EXTENSIONS[type];
  if (extension === undefined || !Buffer.isBuffer(request.body) || request.body.length === 0) {
    return error(reply, 400, 'Image PNG, JPEG, GIF ou WebP attendue');
  }
  const dir = join(ATTACHMENTS_DIR, owner);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${stamp}-${randomBytes(3).toString('hex')}.${extension}`);
  writeFileSync(path, request.body, { mode: 0o600 });
  return reply.code(201).send({ path });
}

export function registerSessionRoutes(ctx: RouteContext): void {
  const {
    app,
    db,
    sessions,
    worktrees,
    catalog,
    git,
    pushes,
    sessionGit,
    broadcast,
    requireProject,
    requireSession,
    launchSession,
    launchReview,
    recordCommit,
    publishFindings,
  } = ctx;

  app.get('/api/sessions', async () => db.listSessions());

  app.post<{ Params: { id: string } }>('/api/projects/:id/sessions', async (request, reply) => {
    const project = requireProject(request, reply);
    if (project === null) return reply;
    return launchSession(reply, project, request.body, (session) => session);
  });

  // Reprise d'un council terminé : la session reçoit protagonistes et compte-rendu complet, suivis de la consigne saisie.
  app.post<{ Params: { id: string } }>('/api/councils/:id/session', async (request, reply) => {
    const run = db.getCouncilRun(request.params.id);
    if (run === null) return error(reply, 404, 'Council introuvable.');
    if (run.finishedAt === null) return error(reply, 409, 'Le council n’est pas terminé.');
    const body = asRecord(request.body) ?? {};
    const projectId = run.projectId !== null && db.getProject(run.projectId) !== null ? run.projectId : body.projectId;
    const project = typeof projectId === 'string' ? db.getProject(projectId) : null;
    if (project === null) return error(reply, 400, 'Choisissez le projet de la session.');
    const launch = asRecord(body.launch) ?? {};
    const instructions = typeof launch.prompt === 'string' ? launch.prompt : '';
    let prompt = councilSessionPrompt(run, instructions);
    // Le prompt est passé en argument à la CLI : au-delà, le compte-rendu complet passe par un fichier.
    if (Buffer.byteLength(prompt) > MAX_INLINE_COUNCIL_REPORT_BYTES) {
      const dir = join(ATTACHMENTS_DIR, `project-${project.id}`, `council-${run.id}`);
      const path = join(dir, 'compte-rendu.md');
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(path, exportMarkdown(run), { mode: 0o600 });
      } catch (cause) {
        return error(reply, 500, `Compte-rendu non enregistré : ${errorMessage(cause)}`);
      }
      prompt = councilSessionPrompt(run, instructions, path);
    }
    const question = run.question.trim().split('\n')[0] ?? '';
    return launchSession(reply, project, { ...launch, prompt }, (session) => session, undefined, {
      remember: launch,
      title: `Council · ${question}`.slice(0, 120),
    });
  });

  // Conversation d'une session, mise en forme pour servir de contexte à un council.
  app.get<{ Params: { id: string } }>('/api/sessions/:id/transcript', async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    return transcriptContext(session, await readSessionTranscript(session), COUNCIL_CONTEXT_FROM_SESSION);
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/git/prepare-commit', async (request, reply) => {
    if (requireSession(request, reply) === null) return reply;
    const result = await orError(reply, () => sessionGit.prepareCommit(request.params.id));
    return result.ok ? reply.send(result.value) : result.reply;
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/git/context', async (request, reply) => {
    if (requireSession(request, reply) === null) return reply;
    return reply.send(sessionGitContext(db, request.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/git/commit', async (request, reply) => {
    // Projet lu avant l’await : la session peut être supprimée pendant le commit déjà effectué.
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const startedAt = Date.now();
    const result = await orError(reply, () => sessionGit.executeCommit(request.params.id, request.body));
    if (result.ok) recordCommit(result.value, request.body, session.projectId, request.params.id, startedAt);
    return result.ok ? reply.send(result.value) : result.reply;
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/git/push', async (request, reply) => {
    const provenance = await orError(reply, () => sessionProvenance(db, git, request.params.id));
    if (!provenance.ok) return provenance.reply;
    return reply.send(await pushes.current(provenance.value.workspace.root));
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/git/review', async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const body = asRecord(request.body);
    const result = await orError(reply, () => sessionGit.reviewContext(session.id, body?.selection));
    if (!result.ok) return result.reply;
    const project = db.getProject(session.projectId)!;
    return launchReview(reply, project, body?.launch, result.value.prompt, async () => {
      await sessionGit.reviewContext(session.id, body?.selection);
    });
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/provenance', async (request, reply) => {
    if (requireSession(request, reply) === null) return reply;
    const result = await orError(reply, () => sessionProvenance(db, git, request.params.id));
    return result.ok ? reply.send(result.value) : result.reply;
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/findings', async (request) =>
    listReports(db, request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/findings', async (request, reply) => {
    return badRequest.attempt(reply, () => publishFindings(request.params.id, request.body));
  });
  app.post<{ Params: { id: string; report: string } }>(
    '/api/sessions/:id/findings/:report/import',
    async (request, reply) => {
      return badRequest.attempt(reply, () => {
        const body = asRecord(request.body);
        const result = importFindings(db, request.params.id, request.params.report, body?.selected, body?.epicId);
        broadcast({ type: 'epic', epic: result.epic });
        for (const task of result.tasks) broadcast({ type: 'task', task });
        const session = db.getSession(request.params.id);
        if (session) broadcast({ type: 'session', session });
        return result;
      });
    },
  );

  app.patch<{ Params: { id: string } }>('/api/sessions/:id/protection', async (request, reply) => {
    const body = asRecord(request.body);
    if (body === null || typeof body.protected !== 'boolean')
      return error(reply, 400, 'Le champ protected doit être un booléen');
    const value = body.protected;
    const result = await orError(reply, async () => sessions.setProtected(request.params.id, value));
    if (!result.ok) return result.reply;
    return result.value === null ? error(reply, 404, 'Session introuvable') : reply.send(result.value);
  });

  app.patch<{ Params: { id: string } }>('/api/sessions/:id/pin', async (request, reply) => {
    const body = asRecord(request.body);
    if (body === null || typeof body.pinned !== 'boolean')
      return error(reply, 400, 'Le champ pinned doit être un booléen');
    const value = body.pinned;
    const result = await orError(reply, async () => sessions.setPinned(request.params.id, value));
    if (!result.ok) return result.reply;
    return result.value === null ? error(reply, 404, 'Session introuvable') : reply.send(result.value);
  });

  app.patch<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    if (requireSession(request, reply) === null) return reply;
    const body = asRecord(request.body);
    if (body === null || typeof body.title !== 'string') return error(reply, 400, 'Le titre est requis');
    const title = body.title.trim();
    if (title === '' || title.length > 120)
      return error(reply, 400, 'Le titre doit contenir entre 1 et 120 caractères');
    const session = sessions.rename(request.params.id, title);
    return session === null ? error(reply, 404, 'Session introuvable') : reply.send(session);
  });

  // Les fichiers que le retrait automatique du contenu de départ laisse à examiner sont confiés à une session, dans la copie.
  app.post<{ Params: { id: string } }>('/api/worktrees/:id/resolve-starting-content', async (request, reply) => {
    await catalog.ready();
    const resolution = await worktreeConflict.orError(reply, () =>
      worktrees.startingContentResolution(request.params.id),
    );
    if (!resolution.ok) return resolution.reply;
    const { view, workspace, plan } = resolution.value;
    const project = view.projectId ? db.getProject(view.projectId) : null;
    if (!project)
      return error(reply, 409, 'Le projet de cette copie a été retiré : aucune session ne peut y être lancée.');
    const settings = { ...project.resolutionSettings, mode: normalizeMode(project.resolutionSettings.mode) };
    const tuning = catalog.parseTuning(settings.agent, { ...settings });
    if (!tuning)
      return error(
        reply,
        400,
        'Le modèle ou l’effort de résolution n’est plus proposé par cet agent : modifiez-les dans « Réglages LLM ».',
      );
    const origin = view.sessionId ? db.getSession(view.sessionId) : null;
    const conversation = origin
      ? { title: origin.title, prompt: origin.prompt }
      : view.sessionTitle
        ? { title: view.sessionTitle, prompt: '' }
        : null;
    const prompt = startingResolutionPrompt(view, workspace, plan, conversation);
    try {
      const session = await sessions.create(
        project,
        { ...settings, ...tuning, prompt },
        {
          contextPath: view.path,
          title: `Contenu de départ · ${conversation?.title ?? basename(view.path)}`.slice(0, 120),
          rememberDefaults: false,
          workspace: { mode: 'isolated', path: view.path },
        },
      );
      return reply.code(201).send(session);
    } catch (caught) {
      return error(reply, 500, caught instanceof Error ? caught.message : 'Impossible de lancer la session');
    }
  });

  // Les conflits laissés par « Mettre à jour avec … » sont confiés à une session, dans la copie ; l'utilisateur termine la mise à jour.
  const launchingResolvers = new Set<string>();
  app.post<{ Params: { id: string } }>('/api/worktrees/:id/resolve-conflicts', async (request, reply) => {
    await catalog.ready();
    const { id } = request.params;
    if (launchingResolvers.has(id))
      return error(reply, 409, 'Une session de résolution est déjà en cours de lancement pour cette copie.');
    const resolution = await worktreeConflict.orError(reply, () => worktrees.conflictResolution(id));
    if (!resolution.ok) return resolution.reply;
    const context = resolution.value;
    const { view } = context;
    if (view.resolver && view.resolver.status !== 'exited')
      return reply.code(409).send({
        error: `La session « ${view.resolver.title} » résout déjà ces conflits.`,
        sessionId: view.resolver.sessionId,
      });
    const project = view.projectId ? db.getProject(view.projectId) : null;
    if (!project)
      return error(reply, 409, 'Le projet de cette copie a été retiré : aucune session ne peut y être lancée.');
    const settings = { ...project.resolutionSettings, mode: normalizeMode(project.resolutionSettings.mode) };
    const tuning = catalog.parseTuning(settings.agent, { ...settings });
    if (!tuning)
      return error(
        reply,
        400,
        'Le modèle ou l’effort de résolution n’est plus proposé par cet agent : modifiez-les dans « Réglages LLM ».',
      );
    const origin = view.sessionId ? db.getSession(view.sessionId) : null;
    const conversation = origin
      ? { title: origin.title, prompt: origin.prompt }
      : view.sessionTitle
        ? { title: view.sessionTitle, prompt: '' }
        : null;
    // The epic step the original conversation carried out, the most recently updated when it took several.
    const linked = origin
      ? db
          .listTasks()
          .filter((task) => task.projectId === project.id && task.sessionId === origin.id)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      : undefined;
    const task = linked
      ? {
          title:
            linked.text
              .split('\n')
              .find((line) => line.trim())
              ?.trim() ?? '',
          text: linked.text,
        }
      : null;
    const prompt = conflictResolutionPrompt(context, conversation, task);
    launchingResolvers.add(id);
    try {
      const session = await sessions.create(
        project,
        { ...settings, ...tuning, prompt },
        {
          contextPath: view.path,
          title: `Conflits · ${conversation?.title ?? basename(view.path)}`.slice(0, 120),
          rememberDefaults: false,
          workspace: { mode: 'isolated', path: view.path },
        },
      );
      worktrees.rememberResolver(id, session.id, context.mergeHead);
      return reply.code(201).send(session);
    } catch (caught) {
      return error(reply, 500, caught instanceof Error ? caught.message : 'Impossible de lancer la session');
    } finally {
      launchingResolvers.delete(id);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/kill', async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    if (session.status === 'exited' || !sessions.kill(session.id))
      return error(reply, 409, "La session n'est pas active");
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/resume', async (request, reply) => {
    if (requireSession(request, reply) === null) return reply;
    try {
      return reply.send(await sessions.resume(request.params.id));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Impossible de reprendre la session';
      return error(reply, 409, message);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/seen', async (request, reply) => {
    const session = sessions.seen(request.params.id);
    return session === null ? error(reply, 404, 'Session introuvable') : reply.send(session);
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/input', async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const body = asRecord(request.body);
    if (body === null || typeof body.data !== 'string') return error(reply, 400, 'Le champ data est requis');
    if (session.status === 'exited' || !sessions.writeInput(session.id, body.data)) {
      return error(reply, 409, "La session n'est pas active");
    }
    return reply.code(204).send();
  });

  app.addContentTypeParser(
    Object.keys(IMAGE_EXTENSIONS),
    { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.post<{ Params: { id: string } }>('/api/sessions/:id/attachments', async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    return saveImage(session.id, request, reply);
  });

  // Images pasted into the "new session" prompt, before the session exists.
  app.post<{ Params: { id: string } }>('/api/projects/:id/attachments', async (request, reply) => {
    const project = requireProject(request, reply);
    if (project === null) return reply;
    return saveImage(`project-${project.id}`, request, reply);
  });

  // Images pasted into a council launched outside any project (a project council uses the project route).
  app.post('/api/council/attachments', async (request, reply) => saveImage('council', request, reply));

  app.get<{ Params: { id: string } }>('/api/sessions/:id/screen', async (request, reply) => {
    if (requireSession(request, reply) === null) return reply;
    return reply.send({ lines: sessions.screenText(request.params.id) ?? [] });
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const result = await orError(reply, () => sessions.delete(request.params.id));
    if (!result.ok) return result.reply;
    if (!result.value) return error(reply, 404, 'Session introuvable');
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/ws/term/:id', { websocket: true }, (socket, request) => {
    const id = request.params.id;
    const session = db.getSession(id);
    const snapshot = sessions.terminalSnapshot(id);
    if (session === null || snapshot === null) {
      socket.close(1008, 'Session introuvable');
      return;
    }

    const unsubscribe = sessions.onTerminalEvent(id, (event) => sendSocket(socket, event));
    // The size first: the snapshot is laid out for it, and a client writing it at another width garbles it.
    const size = sessions.terminalSize(id);
    if (size !== null) sendSocket(socket, { type: 'size', ...size });
    sendSocket(socket, { type: 'snapshot', data: snapshot });
    if (session.status === 'exited') sendSocket(socket, { type: 'exit', exitCode: session.exitCode });

    socket.on('message', (raw) => {
      try {
        const message: unknown = JSON.parse(raw.toString());
        const record = asRecord(message);
        if (record?.type === 'input' && typeof record.data === 'string') {
          sessions.writeInput(id, record.data);
        } else if (record?.type === 'resize' && typeof record.cols === 'number' && typeof record.rows === 'number') {
          sessions.resize(id, record.cols, record.rows);
        }
      } catch {
        // Ignore malformed websocket messages.
      }
    });
    socket.on('close', () => unsubscribe?.());
  });
}
