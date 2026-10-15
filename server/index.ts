import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import { AGENTS, getAgentAvailability } from './agents.ts';
import { ATTACHMENTS_DIR, BIND_TOKEN, HOOK_LOG, HOST, PORT, ROOT } from './config.ts';
import { CerebroDatabase } from './db.ts';
import type { Agent, Mode } from './db.ts';
import { handleHook, installGrokHook, isHookPayload } from './hooks.ts';
import { SessionManager } from './sessions.ts';

const MODES: readonly Mode[] = ['default', 'auto', 'acceptEdits', 'plan', 'bypass'];
const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function error(reply: FastifyReply, statusCode: number, message: string): FastifyReply {
  return reply.code(statusCode).send({ error: message });
}

async function orError<T>(reply: FastifyReply, run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reply: FastifyReply }> {
  try {
    return { ok: true, value: await run() };
  } catch (cause) {
    return { ok: false, reply: error(reply, 500, cause instanceof Error ? cause.message : String(cause)) };
  }
}

function isAgent(value: unknown): value is Agent {
  return typeof value === 'string' && (AGENTS as readonly string[]).includes(value);
}

function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

function bodyRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function expandProjectPath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return resolve(value);
}

function validDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function tokenMatches(candidate: string | undefined): boolean {
  if (BIND_TOKEN === undefined || candidate === undefined) return false;
  const expected = Buffer.from(BIND_TOKEN);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match?.[1];
}

function requestQueryToken(query: unknown): string | undefined {
  const record = bodyRecord(query);
  return typeof record?.token === 'string' ? record.token : undefined;
}

async function gitSummary(path: string): Promise<{ branch: string | null; dirty: number; ahead: number | null }> {
  const empty = { branch: null, dirty: 0, ahead: null };
  try {
    const repository = await execFileAsync('git', ['-C', path, 'rev-parse', '--is-inside-work-tree']);
    if (repository.stdout.trim() !== 'true') return empty;
    const [branchResult, statusResult] = await Promise.all([
      execFileAsync('git', ['-C', path, 'branch', '--show-current']),
      execFileAsync('git', ['-C', path, 'status', '--porcelain']),
    ]);
    const branch = branchResult.stdout.trim() || null;
    const status = statusResult.stdout.replace(/\r?\n$/, '');
    let ahead: number | null = null;
    try {
      const aheadResult = await execFileAsync('git', ['-C', path, 'rev-list', '--count', '@{upstream}..HEAD']);
      const parsed = Number(aheadResult.stdout.trim());
      if (Number.isInteger(parsed) && parsed >= 0) ahead = parsed;
    } catch {
      // No configured upstream (or no commits yet).
    }
    return { branch, dirty: status === '' ? 0 : status.split(/\r?\n/).length, ahead };
  } catch {
    return empty;
  }
}

function sendSocket(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, forceCloseConnections: true });
  const db = new CerebroDatabase();
  const sessions = new SessionManager(db);
  const eventSockets = new Set<WebSocket>();

  installGrokHook();
  await sessions.initialize();
  await app.register(fastifyWebsocket);

  app.addHook('onRequest', async (request, reply) => {
    const queryToken = requestQueryToken(request.query);
    if (BIND_TOKEN !== undefined && request.url.split('?', 1)[0] === '/' && tokenMatches(queryToken)) {
      reply.header(
        'set-cookie',
        `cerebro_token=${encodeURIComponent(queryToken ?? '')}; Path=/; HttpOnly; SameSite=Strict`,
      );
    }

    const path = request.url.split('?', 1)[0] ?? request.url;
    const protectedRoute = (path.startsWith('/api/') && !path.startsWith('/api/hook/')) || path.startsWith('/ws/');
    if (BIND_TOKEN === undefined || !protectedRoute) return;
    const authorized = tokenMatches(queryToken)
      || tokenMatches(bearerToken(request.headers.authorization))
      || tokenMatches(cookieValue(request.headers.cookie, 'cerebro_token'));
    if (!authorized) return error(reply, 401, 'Token requis');
  });

  app.addHook('onClose', async () => {
    await sessions.shutdown();
    db.close();
  });

  sessions.onEvent((event) => {
    for (const socket of eventSockets) sendSocket(socket, event);
  });

  app.get('/api/projects', async () => db.listProjects());

  app.get<{ Querystring: { path?: string } }>('/api/fs/dirs', async (request, reply) => {
    const raw = request.query.path?.trim();
    const dirPath = raw === undefined || raw === '' ? homedir() : expandProjectPath(raw);
    if (!validDirectory(dirPath)) return error(reply, 400, "Le répertoire n'existe pas ou n'est pas un répertoire");
    let dirs: string[];
    try {
      dirs = readdirSync(dirPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && validDirectory(join(dirPath, entry.name))))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return error(reply, 403, 'Lecture du répertoire impossible');
    }
    const parent = dirname(dirPath);
    return { path: dirPath, parent: parent === dirPath ? null : parent, home: homedir(), dirs };
  });

  app.post('/api/projects', async (request, reply) => {
    const body = bodyRecord(request.body);
    if (body === null || typeof body.name !== 'string' || body.name.trim() === '' || typeof body.path !== 'string' || body.path.trim() === '') {
      return error(reply, 400, 'Les champs name et path sont requis');
    }
    const projectPath = expandProjectPath(body.path.trim());
    if (!validDirectory(projectPath)) return error(reply, 400, "Le répertoire n'existe pas ou n'est pas un répertoire");
    const project = db.createProject(body.name.trim(), projectPath);
    const projects = db.listProjects();
    for (const socket of eventSockets) sendSocket(socket, { type: 'projects', projects });
    return reply.code(201).send(project);
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const project = db.getProject(request.params.id);
    if (project === null) return error(reply, 404, 'Projet introuvable');
    const body = bodyRecord(request.body);
    if (body === null) return error(reply, 400, 'Corps de requête invalide');

    const changes: { name?: string; path?: string } = {};
    if ('name' in body) {
      if (typeof body.name !== 'string' || body.name.trim() === '') return error(reply, 400, 'Le nom ne peut pas être vide');
      changes.name = body.name.trim();
    }
    if ('path' in body) {
      if (typeof body.path !== 'string' || body.path.trim() === '') return error(reply, 400, 'Le chemin ne peut pas être vide');
      const projectPath = expandProjectPath(body.path.trim());
      if (!validDirectory(projectPath)) return error(reply, 400, "Le répertoire n'existe pas ou n'est pas un répertoire");
      changes.path = projectPath;
    }
    const updated = db.updateProject(project.id, changes);
    if (updated === null) return error(reply, 404, 'Projet introuvable');
    const projects = db.listProjects();
    for (const socket of eventSockets) sendSocket(socket, { type: 'projects', projects });
    return reply.send(updated);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/git', async (request, reply) => {
    const project = db.getProject(request.params.id);
    if (project === null) return error(reply, 404, 'Projet introuvable');
    return reply.send(await gitSummary(project.path));
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const result = await orError(reply, () => sessions.deleteProject(request.params.id));
    if (!result.ok) return result.reply;
    if (!result.value) return error(reply, 404, 'Projet introuvable');
    const projects = db.listProjects();
    for (const socket of eventSockets) sendSocket(socket, { type: 'projects', projects });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/purge', async (request, reply) => {
    const result = await orError(reply, () => sessions.purgeProject(request.params.id));
    if (!result.ok) return result.reply;
    const deleted = result.value;
    if (deleted === null) return error(reply, 404, 'Projet introuvable');
    return reply.send({ deleted });
  });

  app.get('/api/sessions', async () => db.listSessions());

  app.patch<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    if (db.getSession(request.params.id) === null) return error(reply, 404, 'Session introuvable');
    const body = bodyRecord(request.body);
    if (body === null || typeof body.title !== 'string') return error(reply, 400, 'Le titre est requis');
    const title = body.title.trim();
    if (title === '' || title.length > 120) return error(reply, 400, 'Le titre doit contenir entre 1 et 120 caractères');
    const session = sessions.rename(request.params.id, title);
    return session === null ? error(reply, 404, 'Session introuvable') : reply.send(session);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/sessions', async (request, reply) => {
    const project = db.getProject(request.params.id);
    if (project === null) return error(reply, 404, 'Projet introuvable');
    const body = bodyRecord(request.body);
    if (body === null || !isAgent(body.agent) || !isMode(body.mode) || typeof body.prompt !== 'string') {
      return error(reply, 400, 'agent, mode ou prompt invalide');
    }
    try {
      return reply.code(201).send(await sessions.create(project, body.agent, body.mode, body.prompt));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Impossible de lancer la session';
      return error(reply, 500, message);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/kill', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (session === null) return error(reply, 404, 'Session introuvable');
    if (session.status === 'exited' || !sessions.kill(session.id)) return error(reply, 409, "La session n'est pas active");
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/resume', async (request, reply) => {
    if (db.getSession(request.params.id) === null) return error(reply, 404, 'Session introuvable');
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
    const session = db.getSession(request.params.id);
    if (session === null) return error(reply, 404, 'Session introuvable');
    const body = bodyRecord(request.body);
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

  // Saves a pasted image under DATA_DIR/attachments/<owner>/ and returns its absolute path,
  // which the agent can read (Claude/Codex turn an image path in the prompt into an attachment).
  const saveImage = (owner: string, request: FastifyRequest, reply: FastifyReply) => {
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
  };

  app.post<{ Params: { id: string } }>('/api/sessions/:id/attachments', async (request, reply) => {
    const session = db.getSession(request.params.id);
    if (session === null) return error(reply, 404, 'Session introuvable');
    return saveImage(session.id, request, reply);
  });

  // Images pasted into the "new session" prompt, before the session exists.
  app.post<{ Params: { id: string } }>('/api/projects/:id/attachments', async (request, reply) => {
    const project = db.getProject(request.params.id);
    if (project === null) return error(reply, 404, 'Projet introuvable');
    return saveImage(`project-${project.id}`, request, reply);
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/screen', async (request, reply) => {
    if (sessions.db.getSession(request.params.id) === null) return error(reply, 404, 'Session introuvable');
    return reply.send({ lines: sessions.screenText(request.params.id) ?? [] });
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const result = await orError(reply, () => sessions.delete(request.params.id));
    if (!result.ok) return result.reply;
    if (!result.value) return error(reply, 404, 'Session introuvable');
    return reply.code(204).send();
  });

  app.get('/api/agents', async () => getAgentAvailability());

  app.post<{ Params: { id: string } }>('/api/hook/:id', async (request, reply) => {
    const token = request.headers['x-cerebro-token'];
    if (typeof token !== 'string' || !sessions.tokenMatches(request.params.id, token)) {
      return error(reply, 403, 'Token de hook invalide');
    }
    const body = bodyRecord(request.body);
    if (body === null || !isAgent(body.agent) || typeof body.event !== 'string' || !isHookPayload(body.payload)) {
      return error(reply, 400, 'Événement de hook invalide');
    }
    const session = db.getSession(request.params.id);
    if (session === null) return error(reply, 404, 'Session introuvable');
    if (body.agent !== session.agent) return error(reply, 400, "L'agent ne correspond pas à la session");
    // Keep a trace of every hook event: invaluable to debug state detection.
    appendFileSync(HOOK_LOG, `${JSON.stringify({ at: new Date().toISOString(), session: session.id, agent: body.agent, event: body.event, payload: body.payload })}\n`);
    handleHook(sessions, session.id, body.agent, body.event, body.payload);
    return reply.code(204).send();
  });

  app.get('/ws/events', { websocket: true }, (socket) => {
    eventSockets.add(socket);
    sendSocket(socket, { type: 'snapshot', projects: db.listProjects(), sessions: db.listSessions() });
    socket.on('close', () => eventSockets.delete(socket));
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
    sendSocket(socket, { type: 'snapshot', data: snapshot });
    if (session.status === 'exited') sendSocket(socket, { type: 'exit', exitCode: session.exitCode });

    socket.on('message', (raw) => {
      try {
        const message: unknown = JSON.parse(raw.toString());
        const record = bodyRecord(message);
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

  const webDist = join(ROOT, 'web', 'dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
  }
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws/')) {
      return error(reply, 404, 'Route introuvable');
    }
    if (existsSync(join(webDist, 'index.html')) && 'sendFile' in reply) return reply.sendFile('index.html');
    return error(reply, 404, 'Interface web non construite');
  });

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const app = await buildServer();
  await app.listen({ host: HOST, port: PORT });
  return app;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().then((app) => {
    let closing = false;
    const shutdown = async (): Promise<void> => {
      if (closing) return;
      closing = true;
      try {
        await app.close();
        process.exit(0);
      } catch (caught) {
        const message = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
        process.stderr.write(`${message}\n`);
        process.exit(1);
      }
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  }).catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
