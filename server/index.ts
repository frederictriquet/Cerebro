import { appendFileSync } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type WebSocket from 'ws';
import { AGENTS, getAgentAvailability } from './agents.ts';
import { HOOK_LOG, HOST, PORT, ROOT } from './config.ts';
import { CerebroDatabase } from './db.ts';
import type { Agent, Mode } from './db.ts';
import { handleHook, installGrokHook, isHookPayload } from './hooks.ts';
import { SessionManager } from './sessions.ts';

const MODES: readonly Mode[] = ['default', 'acceptEdits', 'plan', 'bypass'];

function error(reply: FastifyReply, statusCode: number, message: string): FastifyReply {
  return reply.code(statusCode).send({ error: message });
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

function sendSocket(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const db = new CerebroDatabase();
  const sessions = new SessionManager(db);
  const eventSockets = new Set<WebSocket>();

  installGrokHook();
  await app.register(fastifyWebsocket);

  sessions.onEvent((event) => {
    for (const socket of eventSockets) sendSocket(socket, event);
  });

  app.get('/api/projects', async () => db.listProjects());

  app.post('/api/projects', async (request, reply) => {
    const body = bodyRecord(request.body);
    if (body === null || typeof body.name !== 'string' || body.name.trim() === '' || typeof body.path !== 'string' || body.path.trim() === '') {
      return error(reply, 400, 'Les champs name et path sont requis');
    }
    const projectPath = expandProjectPath(body.path.trim());
    try {
      if (!statSync(projectPath).isDirectory()) return error(reply, 400, "Le chemin n'est pas un répertoire");
    } catch {
      return error(reply, 400, "Le répertoire n'existe pas");
    }
    const project = db.createProject(body.name.trim(), projectPath);
    const projects = db.listProjects();
    for (const socket of eventSockets) sendSocket(socket, { type: 'projects', projects });
    return reply.code(201).send(project);
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    if (!sessions.deleteProject(request.params.id)) return error(reply, 404, 'Projet introuvable');
    const projects = db.listProjects();
    for (const socket of eventSockets) sendSocket(socket, { type: 'projects', projects });
    return reply.code(204).send();
  });

  app.get('/api/sessions', async () => db.listSessions());

  app.post<{ Params: { id: string } }>('/api/projects/:id/sessions', async (request, reply) => {
    const project = db.getProject(request.params.id);
    if (project === null) return error(reply, 404, 'Projet introuvable');
    const body = bodyRecord(request.body);
    if (body === null || !isAgent(body.agent) || !isMode(body.mode) || typeof body.prompt !== 'string') {
      return error(reply, 400, 'agent, mode ou prompt invalide');
    }
    try {
      return reply.code(201).send(sessions.create(project, body.agent, body.mode, body.prompt));
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
      return reply.send(sessions.resume(request.params.id));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Impossible de reprendre la session';
      return error(reply, 409, message);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/seen', async (request, reply) => {
    const session = sessions.seen(request.params.id);
    return session === null ? error(reply, 404, 'Session introuvable') : reply.send(session);
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/screen', async (request, reply) => {
    if (sessions.db.getSession(request.params.id) === null) return error(reply, 404, 'Session introuvable');
    return reply.send({ lines: sessions.screenText(request.params.id) ?? [] });
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    if (!sessions.delete(request.params.id)) return error(reply, 404, 'Session introuvable');
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
  startServer().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
