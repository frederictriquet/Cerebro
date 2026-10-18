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
import { getCatalog, parseTuning, startCatalogRefresh } from './catalog.ts';
import { ATTACHMENTS_DIR, BIND_TOKEN, HOOK_LOG, HOST, PORT, ROOT, SLACK_ENABLED } from './config.ts';
import { CerebroDatabase } from './db.ts';
import type { Agent, Epic, Mode, Project, Session, Task, TaskStatus } from './db.ts';
import { handleHook, installGrokHook, isHookPayload } from './hooks.ts';
import { incompatibleMessage, PeerSync, syncPayloadFrom } from './peers.ts';
import { assertLoopbackPortFree } from './ports.ts';
import { registerRemoteGateway } from './remotes.ts';
import { compatibility, VERSION_INFO } from './version.ts';
import { SessionManager } from './sessions.ts';
import { SlackNotifier } from './slack.ts';
import { UpdateManager } from './updates.ts';
import { UsageTracker } from './usage.ts';
import { registerVscodeRelay, VscodeServer } from './vscode.ts';

const MODES: readonly Mode[] = ['default', 'auto', 'acceptEdits', 'plan', 'bypass'];
const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TASK_LENGTH = 20_000;
const MAX_BACKLOG_TASKS = 100;
// Worst case: 3 UTF-8 bytes per UTF-16 code unit (non-ASCII text), plus JSON escaping and envelope.
const BACKLOG_BODY_LIMIT = MAX_BACKLOG_TASKS * MAX_TASK_LENGTH * 3 + 1024 * 1024;
const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'started', 'done'];
const MAX_EPIC_TITLE_LENGTH = 200;

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

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

function taskText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' || text.length > MAX_TASK_LENGTH ? null : text;
}

function epicTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title === '' || title.length > MAX_EPIC_TITLE_LENGTH ? null : title;
}

function epicDescription(value: unknown): string | null {
  if (value === undefined) return '';
  if (typeof value !== 'string') return null;
  const description = value.trim();
  return description.length > MAX_TASK_LENGTH ? null : description;
}

const EPIC_TITLE_ERROR = `Le titre de l'epic doit contenir entre 1 et ${MAX_EPIC_TITLE_LENGTH} caractères`;
const EPIC_DESCRIPTION_ERROR = `La description de l'epic doit contenir au plus ${MAX_TASK_LENGTH} caractères`;

// Valide l'epic proposé pour une tâche du projet : null (aucun) ou un epic du même projet.
function checkEpic(value: unknown, projectId: string, epics: Epic[]): { ok: true; id: string | null } | { ok: false; message: string } {
  if (value === null) return { ok: true, id: null };
  if (typeof value !== 'string' || !epics.some((e) => e.id === value && e.projectId === projectId)) {
    return { ok: false, message: 'Epic introuvable dans ce projet' };
  }
  return { ok: true, id: value };
}

// Valide la liste de dépendances proposée pour `task` : tâches existantes du même projet, sans cycle.
function checkDependencies(task: Task, value: unknown, projectTasks: Task[]): { ok: true; ids: string[] } | { ok: false; message: string } {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) {
    return { ok: false, message: 'dependsOn doit être une liste d\'identifiants' };
  }
  const ids = [...new Set(value as string[])];
  const byId = new Map(projectTasks.map((t) => [t.id, t]));
  if (ids.some((id) => !byId.has(id))) return { ok: false, message: 'Dépendance introuvable dans ce projet' };
  if (ids.includes(task.id)) return { ok: false, message: 'Une tâche ne peut pas dépendre d\'elle-même' };
  // Cycle si `task` est atteignable depuis l'une des nouvelles dépendances.
  const seen = new Set<string>();
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === task.id) return { ok: false, message: 'Cette dépendance créerait un cycle' };
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return { ok: true, ids };
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

// Cookie persistant (un an) : le jeton ne se ressaisit pas à chaque redémarrage du navigateur.
function tokenCookie(request: FastifyRequest): string {
  const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `cerebro_token=${encodeURIComponent(BIND_TOKEN ?? '')}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`;
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match?.[1];
}

function requestQueryToken(query: unknown): string | undefined {
  const record = bodyRecord(query);
  return typeof record?.token === 'string' ? record.token : undefined;
}

async function gitSummary(path: string): Promise<{
  branch: string | null;
  dirty: number;
  ahead: number | null;
  hasCommits: boolean;
  hasUpstream: boolean;
}> {
  const empty = { branch: null, dirty: 0, ahead: 0, hasCommits: false, hasUpstream: false };
  try {
    const repository = await execFileAsync('git', ['-C', path, 'rev-parse', '--is-inside-work-tree']);
    if (repository.stdout.trim() !== 'true') return empty;
    const [branchResult, statusResult, hasCommits, hasUpstream] = await Promise.all([
      execFileAsync('git', ['-C', path, 'branch', '--show-current']),
      execFileAsync('git', ['-C', path, 'status', '--porcelain']),
      execFileAsync('git', ['-C', path, 'rev-parse', '--verify', 'HEAD']).then(() => true, () => false),
      execFileAsync('git', ['-C', path, 'rev-parse', '--verify', '@{upstream}']).then(() => true, () => false),
    ]);
    const branch = branchResult.stdout.trim() || null;
    const status = statusResult.stdout.replace(/\r?\n$/, '');
    let ahead: number | null = hasCommits ? null : 0;
    if (hasCommits && hasUpstream) {
      try {
        const aheadResult = await execFileAsync('git', ['-C', path, 'rev-list', '--count', '@{upstream}..HEAD']);
        const parsed = Number(aheadResult.stdout.trim());
        if (Number.isInteger(parsed) && parsed >= 0) ahead = parsed;
      } catch {
        // Le compteur est indisponible ; les informations HEAD/upstream restent explicites.
      }
    }
    return { branch, dirty: status === '' ? 0 : status.split(/\r?\n/).length, ahead, hasCommits, hasUpstream };
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
  const peers = new PeerSync(db, () => {
    for (const socket of eventSockets) sendSocket(socket, { type: 'peers' });
  });
  const notifier = new SlackNotifier(sessions, db, peers);
  const vscode = new VscodeServer();

  installGrokHook();
  await sessions.initialize();
  await app.register(fastifyWebsocket);

  app.addHook('onRequest', async (request, reply) => {
    const queryToken = requestQueryToken(request.query);
    if (BIND_TOKEN !== undefined && request.url.split('?', 1)[0] === '/' && tokenMatches(queryToken)) {
      reply.header('set-cookie', tokenCookie(request));
    }

    const path = request.url.split('?', 1)[0] ?? request.url;
    const protectedRoute = (path.startsWith('/api/')
      && path !== '/api/auth'
      && !path.startsWith('/api/hook/')
      && !path.startsWith('/api/notify/')
      && !path.startsWith('/api/backlog/')) || path.startsWith('/ws/') || path.startsWith('/m/')
      || path === '/vscode' || path.startsWith('/vscode/');
    if (BIND_TOKEN === undefined || !protectedRoute) return;
    const authorized = tokenMatches(queryToken)
      || tokenMatches(bearerToken(request.headers.authorization))
      || tokenMatches(cookieValue(request.headers.cookie, 'cerebro_token'));
    if (!authorized) return error(reply, 401, 'Token requis');
  });

  // Échange du jeton contre le cookie via /api : passe aussi par le proxy de Vite en dev,
  // contrairement à `/?token=`, servi par Vite.
  app.post('/api/auth', async (request, reply) => {
    if (BIND_TOKEN === undefined) return reply.code(204).send();
    const token = bodyRecord(request.body)?.token;
    if (typeof token !== 'string' || !tokenMatches(token)) return error(reply, 401, 'Jeton invalide');
    return reply.header('set-cookie', tokenCookie(request)).code(204).send();
  });

  registerRemoteGateway(app, peers);
  registerVscodeRelay(app, vscode);

  app.addHook('onClose', async () => {
    peers.stop();
    notifier.stop();
    vscode.stop();
    await sessions.shutdown();
    db.close();
  });

  const broadcast = (event: unknown): void => {
    for (const socket of eventSockets) sendSocket(socket, event);
  };

  sessions.onEvent((event) => {
    if (event.type === 'turn-complete') return;
    broadcast(event);
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
    void peers.sync();
    return reply.code(201).send(project);
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const project = db.getProject(request.params.id);
    if (project === null) return error(reply, 404, 'Projet introuvable');
    const body = bodyRecord(request.body);
    if (body === null) return error(reply, 400, 'Corps de requête invalide');

    const changes: { name?: string; path?: string; color?: string | null } = {};
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
    if ('color' in body) {
      if (body.color !== null && (typeof body.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.color))) {
        return error(reply, 400, 'Couleur invalide (format #rrggbb attendu)');
      }
      changes.color = body.color === null ? null : body.color.toLowerCase();
    }
    const updated = db.updateProject(project.id, changes);
    if (updated === null) return error(reply, 404, 'Projet introuvable');
    // Un renommage compte comme une apparition : la machine qui renomme prend la main sur Slack.
    if (updated.name !== project.name) peers.renamed(project.id);
    else if (updated.path !== project.path) void peers.sync();
    const projects = db.listProjects();
    for (const socket of eventSockets) sendSocket(socket, { type: 'projects', projects });
    return reply.send(updated);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/git', async (request, reply) => {
    const project = db.getProject(request.params.id);
    if (project === null) return error(reply, 404, 'Projet introuvable');
    return reply.send(await gitSummary(project.path));
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/vscode', async (request, reply) => {
    const project = db.getProject(request.params.id);
    if (project === null) return error(reply, 404, 'Projet introuvable');
    try {
      const opened = await vscode.open(project.path);
      return reply.code(opened.ready ? 200 : 202).send(opened);
    } catch (caught) {
      return error(reply, 502, caught instanceof Error ? caught.message : 'VS Code indisponible');
    }
  });

  // Prise de main Slack entre machines partageant un projet (voir server/peers.ts).
  app.post('/api/peer/sync', async (request, reply) => {
    const payload = syncPayloadFrom(request.body);
    if (payload === null) return error(reply, 400, 'Échange invalide');
    // Une instance sans version (antérieure) est acceptée ; un autre protocole est refusé, avec notre version.
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

  app.get<{ Params: { id: string } }>('/api/projects/:id/slack', async (request, reply) => {
    const project = db.getProject(request.params.id);
    if (project === null) return error(reply, 404, 'Projet introuvable');
    return reply.send(peers.projectStatus(project));
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/slack/acquire', async (request, reply) => {
    const project = db.getProject(request.params.id);
    if (project === null) return error(reply, 404, 'Projet introuvable');
    const status = peers.acquire(project);
    if (status === null) return error(reply, 409, "Ce projet n'est pas partagé avec une autre machine");
    return reply.send(status);
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const result = await orError(reply, () => sessions.deleteProject(request.params.id));
    if (!result.ok) return result.reply;
    if (!result.value) return error(reply, 404, 'Projet introuvable');
    const projects = db.listProjects();
    for (const socket of eventSockets) sendSocket(socket, { type: 'projects', projects });
    void peers.sync();
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

  // Valide le corps {agent, mode, model?, effort?, prompt}, lance la session puis répond 201 avec ce que renvoie `respond`.
  const launchSession = async (
    reply: FastifyReply,
    project: Project,
    rawBody: unknown,
    respond: (session: Session) => unknown,
  ): Promise<FastifyReply> => {
    const body = bodyRecord(rawBody);
    if (body === null || !isAgent(body.agent) || !isMode(body.mode) || typeof body.prompt !== 'string') {
      return error(reply, 400, 'agent, mode ou prompt invalide');
    }
    const tuning = parseTuning(body.agent, body);
    if (tuning === null) return error(reply, 400, 'modèle ou effort invalide pour cet agent');
    try {
      const session = await sessions.create(project, body.agent, body.mode, body.prompt, tuning);
      return reply.code(201).send(respond(session));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Impossible de lancer la session';
      return error(reply, 500, message);
    }
  };

  app.post<{ Params: { id: string } }>('/api/projects/:id/sessions', async (request, reply) => {
    const project = db.getProject(request.params.id);
    if (project === null) return error(reply, 404, 'Projet introuvable');
    return launchSession(reply, project, request.body, (session) => session);
  });

  const projectTasks = (projectId: string): Task[] => db.listTasks().filter((t) => t.projectId === projectId);

  const broadcastTasks = (ids: Iterable<string>): void => {
    for (const id of ids) {
      const task = db.getTask(id);
      if (task !== null) broadcast({ type: 'task', task });
    }
  };

  // Valide { title, description?, taskIds? } puis crée l'epic et y range les tâches désignées.
  const createEpic = (projectId: string, body: Record<string, unknown> | null, sourceSessionId: string | null):
    { ok: true; epic: Epic; taskIds: string[] } | { ok: false; message: string } => {
    const title = epicTitle(body?.title);
    if (title === null) return { ok: false, message: EPIC_TITLE_ERROR };
    const description = epicDescription(body?.description);
    if (description === null) return { ok: false, message: EPIC_DESCRIPTION_ERROR };
    const rawIds = body?.taskIds ?? [];
    const own = new Set(projectTasks(projectId).map((t) => t.id));
    if (!Array.isArray(rawIds) || !rawIds.every((id) => typeof id === 'string' && own.has(id))) {
      return { ok: false, message: 'taskIds doit lister des tâches de ce projet' };
    }
    const epic = db.createEpic(projectId, title, description, sourceSessionId);
    broadcast({ type: 'epic', epic });
    const taskIds = [...new Set(rawIds as string[])];
    for (const id of taskIds) db.updateTask(id, { epicId: epic.id });
    broadcastTasks(taskIds);
    return { ok: true, epic, taskIds };
  };

  const updateEpic = (id: string, body: Record<string, unknown>):
    { ok: true; epic: Epic } | { ok: false; status: number; message: string } => {
    if (db.getEpic(id) === null) return { ok: false, status: 404, message: 'Epic introuvable' };
    const changes: { title?: string; description?: string } = {};
    if (body.title !== undefined) {
      const title = epicTitle(body.title);
      if (title === null) return { ok: false, status: 400, message: EPIC_TITLE_ERROR };
      changes.title = title;
    }
    if (body.description !== undefined) {
      const description = epicDescription(body.description);
      if (description === null) return { ok: false, status: 400, message: EPIC_DESCRIPTION_ERROR };
      changes.description = description;
    }
    const epic = db.updateEpic(id, changes);
    if (epic === null) return { ok: false, status: 404, message: 'Epic introuvable' };
    broadcast({ type: 'epic', epic });
    return { ok: true, epic };
  };

  const deleteEpic = (id: string): boolean => {
    const members = db.listTasks().filter((t) => t.epicId === id).map((t) => t.id);
    if (!db.deleteEpic(id)) return false;
    broadcast({ type: 'epic-deleted', id });
    broadcastTasks(members);
    return true;
  };

  app.get('/api/tasks', async () => db.listTasks());

  app.post<{ Params: { id: string } }>('/api/projects/:id/tasks', async (request, reply) => {
    if (db.getProject(request.params.id) === null) return error(reply, 404, 'Projet introuvable');
    const body = bodyRecord(request.body);
    const text = taskText(body?.text);
    if (text === null) return error(reply, 400, `Le texte doit contenir entre 1 et ${MAX_TASK_LENGTH} caractères`);
    const source = typeof body?.sourceSessionId === 'string' && db.getSession(body.sourceSessionId) !== null
      ? body.sourceSessionId
      : null;
    const epic = checkEpic(body?.epicId ?? null, request.params.id, db.listEpics());
    if (!epic.ok) return error(reply, 400, epic.message);
    const task = db.createTask(request.params.id, text, source, epic.id);
    broadcast({ type: 'task', task });
    return reply.code(201).send(task);
  });

  app.patch<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    if (db.getTask(request.params.id) === null) return error(reply, 404, 'Tâche introuvable');
    const body = bodyRecord(request.body);
    if (body === null) return error(reply, 400, 'Corps invalide');
    const changes: { text?: string; status?: TaskStatus; dependsOn?: string[]; epicId?: string | null } = {};
    if (body.text !== undefined) {
      const text = taskText(body.text);
      if (text === null) return error(reply, 400, `Le texte doit contenir entre 1 et ${MAX_TASK_LENGTH} caractères`);
      changes.text = text;
    }
    if (body.status !== undefined) {
      if (!isTaskStatus(body.status)) return error(reply, 400, 'Statut invalide');
      changes.status = body.status;
    }
    if (body.dependsOn !== undefined) {
      const current = db.getTask(request.params.id) as Task;
      const checked = checkDependencies(current, body.dependsOn, db.listTasks().filter((t) => t.projectId === current.projectId));
      if (!checked.ok) return error(reply, 400, checked.message);
      changes.dependsOn = checked.ids;
    }
    if (body.epicId !== undefined) {
      const epic = checkEpic(body.epicId, (db.getTask(request.params.id) as Task).projectId, db.listEpics());
      if (!epic.ok) return error(reply, 400, epic.message);
      changes.epicId = epic.id;
    }
    const task = db.updateTask(request.params.id, changes);
    if (task === null) return error(reply, 404, 'Tâche introuvable');
    broadcast({ type: 'task', task });
    return reply.send(task);
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const dependents = db.listDependents(request.params.id);
    if (!db.deleteTask(request.params.id)) return error(reply, 404, 'Tâche introuvable');
    broadcast({ type: 'task-deleted', id: request.params.id });
    for (const id of dependents) {
      const dependent = db.getTask(id);
      if (dependent !== null) broadcast({ type: 'task', task: dependent });
    }
    return reply.code(204).send();
  });

  // Confie la tâche à une nouvelle session ; le prompt peut différer du texte (édité avant lancement).
  app.post<{ Params: { id: string } }>('/api/tasks/:id/start', async (request, reply) => {
    const task = db.getTask(request.params.id);
    if (task === null) return error(reply, 404, 'Tâche introuvable');
    const project = db.getProject(task.projectId);
    if (project === null) return error(reply, 404, 'Projet introuvable');
    if (task.dependsOn.some((id) => db.getTask(id)?.status !== 'done')) {
      return error(reply, 409, 'Tâche bloquée : ses dépendances ne sont pas toutes terminées');
    }
    return launchSession(reply, project, request.body, (session) => {
      const updated = db.updateTask(task.id, { status: 'started', sessionId: session.id });
      if (updated !== null) broadcast({ type: 'task', task: updated });
      return { task: updated, session };
    });
  });

  app.get('/api/epics', async () => db.listEpics());

  // Crée un epic ; `taskIds` y range des tâches existantes du projet.
  app.post<{ Params: { id: string } }>('/api/projects/:id/epics', async (request, reply) => {
    if (db.getProject(request.params.id) === null) return error(reply, 404, 'Projet introuvable');
    const body = bodyRecord(request.body);
    const result = createEpic(request.params.id, body, null);
    if (!result.ok) return error(reply, 400, result.message);
    return reply.code(201).send(result.epic);
  });

  app.patch<{ Params: { id: string } }>('/api/epics/:id', async (request, reply) => {
    const body = bodyRecord(request.body);
    if (body === null) return error(reply, 400, 'Corps invalide');
    const result = updateEpic(request.params.id, body);
    if (!result.ok) return error(reply, result.status, result.message);
    return reply.send(result.epic);
  });

  // Supprime l'epic ; ses tâches restent dans le backlog, sans epic.
  app.delete<{ Params: { id: string } }>('/api/epics/:id', async (request, reply) => {
    if (!deleteEpic(request.params.id)) return error(reply, 404, 'Epic introuvable');
    return reply.code(204).send();
  });

  // Confie toutes les tâches ouvertes de l'epic à une seule session. Le prompt (construit par l'interface,
  // tâches dans l'ordre des dépendances) demande à l'agent de clore chacune via `cerebro-backlog --done`.
  app.post<{ Params: { id: string } }>('/api/epics/:id/start', async (request, reply) => {
    const epic = db.getEpic(request.params.id);
    if (epic === null) return error(reply, 404, 'Epic introuvable');
    const project = db.getProject(epic.projectId);
    if (project === null) return error(reply, 404, 'Projet introuvable');
    const all = projectTasks(epic.projectId);
    const byId = new Map(all.map((t) => [t.id, t]));
    const open = all.filter((t) => t.epicId === epic.id && t.status !== 'done');
    if (open.length === 0) return error(reply, 409, 'Aucune tâche à traiter dans cet epic');
    const outside = open.flatMap((t) => t.dependsOn).map((id) => byId.get(id))
      .filter((t): t is Task => t !== undefined && t.epicId !== epic.id && t.status !== 'done');
    if (outside.length > 0) {
      return error(reply, 409, 'Epic bloqué : des tâches hors de l\'epic dont il dépend ne sont pas terminées');
    }
    const busy = open.some((t) => t.status === 'started' && t.sessionId !== null
      && (db.getSession(t.sessionId)?.status ?? 'exited') !== 'exited');
    if (busy) return error(reply, 409, 'Une tâche de l\'epic est déjà traitée par une session active');
    return launchSession(reply, project, request.body, (session) => {
      const tasks = open.map((t) => db.updateTask(t.id, { status: 'started', sessionId: session.id }))
        .filter((t): t is Task => t !== null);
      for (const task of tasks) broadcast({ type: 'task', task });
      return { tasks, session };
    });
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

  app.get('/api/agents', async () => {
    const [availability, catalog] = await Promise.all([getAgentAvailability(), getCatalog()]);
    return availability.map((info) => ({ ...info, ...catalog[info.agent] }));
  });

  const usage = new UsageTracker();
  app.get('/api/usage', async () => usage.get());

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
    const body = bodyRecord(request.body);
    if (body === null || typeof body.auto !== 'boolean') return error(reply, 400, 'auto (booléen) attendu');
    return reply.send(updates.setAuto(request.params.agent, body.auto));
  });

  app.get('/api/slack', async () => notifier.status());

  app.patch('/api/slack', async (request, reply) => {
    const body = bodyRecord(request.body);
    if (body === null) return error(reply, 400, 'Corps invalide');
    const result = await orError(reply, async () => notifier.updateSettings(body));
    if (!result.ok) return result.reply;
    if (result.value === null) return error(reply, 400, 'Réglages Slack invalides');
    return reply.send(notifier.status());
  });

  app.post<{ Params: { id: string } }>('/api/notify/:id', async (request, reply) => {
    const token = request.headers['x-cerebro-token'];
    if (typeof token !== 'string' || !sessions.tokenMatches(request.params.id, token)) {
      return error(reply, 403, 'Token de hook invalide');
    }
    const session = db.getSession(request.params.id);
    if (session === null) return error(reply, 404, 'Session introuvable');
    const body = bodyRecord(request.body);
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

  // Routes de bin/cerebro-backlog, authentifiées par le jeton de session : elles n'agissent que sur le
  // backlog du projet de la session.
  const backlogSession = (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Session | null => {
    const token = request.headers['x-cerebro-token'];
    if (typeof token !== 'string' || !sessions.tokenMatches(request.params.id, token)) {
      error(reply, 403, 'Token de hook invalide');
      return null;
    }
    const session = db.getSession(request.params.id);
    if (session === null) error(reply, 404, 'Session introuvable');
    return session;
  };
  app.get<{ Params: { id: string } }>('/api/backlog/:id', async (request, reply) => {
    const session = backlogSession(request, reply);
    if (session === null) return reply;
    return projectTasks(session.projectId).map(({ id, status, text, dependsOn, epicId, sourceSessionId, sessionId }) =>
      ({ id, status, text, dependsOn, epicId, mine: sourceSessionId === session.id, assigned: sessionId === session.id }));
  });

  const projectEpic = (session: Session, epicId: string, reply: FastifyReply): Epic | null => {
    const epic = db.getEpic(epicId);
    if (epic === null || epic.projectId !== session.projectId) {
      error(reply, 404, 'Epic introuvable dans ce projet');
      return null;
    }
    return epic;
  };

  app.get<{ Params: { id: string } }>('/api/backlog/:id/epics', async (request, reply) => {
    const session = backlogSession(request, reply);
    if (session === null) return reply;
    const tasks = projectTasks(session.projectId);
    return db.listEpics().filter((e) => e.projectId === session.projectId).map(({ id, title, description, sourceSessionId }) =>
      ({ id, title, description, mine: sourceSessionId === session.id, tasks: tasks.filter((t) => t.epicId === id).map((t) => t.id) }));
  });

  // Crée un epic, vide ou avec des tâches existantes ({ title, description?, taskIds? }).
  app.post<{ Params: { id: string } }>('/api/backlog/:id/epics', async (request, reply) => {
    const session = backlogSession(request, reply);
    if (session === null) return reply;
    const result = createEpic(session.projectId, bodyRecord(request.body), session.id);
    if (!result.ok) return error(reply, 400, result.message);
    const { id, title, description } = result.epic;
    return reply.code(201).send({ id, title, description, tasks: result.taskIds });
  });

  app.patch<{ Params: { id: string; epicId: string } }>('/api/backlog/:id/epics/:epicId', async (request, reply) => {
    const session = backlogSession(request, reply);
    if (session === null) return reply;
    if (projectEpic(session, request.params.epicId, reply) === null) return reply;
    const body = bodyRecord(request.body);
    if (body === null) return error(reply, 400, 'Corps invalide');
    const result = updateEpic(request.params.epicId, body);
    if (!result.ok) return error(reply, result.status, result.message);
    const { id, title, description } = result.epic;
    return reply.send({ id, title, description });
  });

  // Supprime un epic créé par cette session ; ses tâches restent dans le backlog.
  app.delete<{ Params: { id: string; epicId: string } }>('/api/backlog/:id/epics/:epicId', async (request, reply) => {
    const session = backlogSession(request, reply);
    if (session === null) return reply;
    const epic = projectEpic(session, request.params.epicId, reply);
    if (epic === null) return reply;
    if (epic.sourceSessionId !== session.id) return error(reply, 403, 'Seuls les epics créés par cette session peuvent être supprimés ici');
    deleteEpic(epic.id);
    return reply.code(204).send();
  });

  // Clôt une tâche confiée à cette session (traitement d'un epic, tâche par tâche).
  app.post<{ Params: { id: string; taskId: string } }>('/api/backlog/:id/tasks/:taskId/done', async (request, reply) => {
    const session = backlogSession(request, reply);
    if (session === null) return reply;
    const current = db.getTask(request.params.taskId);
    if (current === null || current.projectId !== session.projectId) return error(reply, 404, 'Tâche introuvable dans ce projet');
    if (current.sessionId !== session.id) return error(reply, 403, "Cette tâche n'est pas confiée à cette session");
    const task = db.updateTask(current.id, { status: 'done' });
    if (task === null) return error(reply, 404, 'Tâche introuvable');
    broadcast({ type: 'task', task });
    return reply.send({ id: task.id, status: task.status });
  });

  // Ajoute des tâches. Chacune est un texte ou { text, dependsOn } ; une dépendance est l'identifiant
  // d'une tâche du projet ou le numéro (à partir de 1) d'une tâche précédente du même envoi.
  app.post<{ Params: { id: string } }>('/api/backlog/:id', { bodyLimit: BACKLOG_BODY_LIMIT }, async (request, reply) => {
    const session = backlogSession(request, reply);
    if (session === null) return reply;
    const body = bodyRecord(request.body);
    if (body === null || !Array.isArray(body.tasks) || body.tasks.length === 0 || body.tasks.length > MAX_BACKLOG_TASKS) {
      return error(reply, 400, `tasks doit contenir entre 1 et ${MAX_BACKLOG_TASKS} tâches`);
    }
    const existing = new Set(projectTasks(session.projectId).map((t) => t.id));
    const epics = db.listEpics();
    // `epic` : epic de toutes les tâches de l'envoi, existant (identifiant) ou à créer ({ title, description? }).
    let defaultEpic: string | null = null;
    let newEpic: Record<string, unknown> | null = null;
    if (typeof body.epic === 'string') {
      const checked = checkEpic(body.epic, session.projectId, epics);
      if (!checked.ok) return error(reply, 400, checked.message);
      defaultEpic = checked.id;
    } else if (body.epic !== undefined && body.epic !== null) {
      newEpic = bodyRecord(body.epic);
      if (epicTitle(newEpic?.title) === null) return error(reply, 400, EPIC_TITLE_ERROR);
      if (epicDescription(newEpic?.description) === null) return error(reply, 400, EPIC_DESCRIPTION_ERROR);
    }
    const items: { text: string; deps: (string | number)[]; epicId: string | null | undefined }[] = [];
    for (const [index, raw] of (body.tasks as unknown[]).entries()) {
      const item = typeof raw === 'string' ? { text: raw } : bodyRecord(raw);
      const text = taskText(item?.text);
      if (text === null) return error(reply, 400, `Tâche ${index + 1} : le texte doit contenir entre 1 et ${MAX_TASK_LENGTH} caractères`);
      const deps = item?.dependsOn ?? [];
      if (!Array.isArray(deps)) return error(reply, 400, `Tâche ${index + 1} : dependsOn doit être une liste`);
      for (const dep of deps) {
        const valid = typeof dep === 'number'
          ? Number.isInteger(dep) && dep >= 1 && dep <= index
          : typeof dep === 'string' && existing.has(dep);
        if (!valid) {
          return error(reply, 400, `Tâche ${index + 1} : dépendance invalide ${JSON.stringify(dep)} (identifiant d'une tâche du projet ou numéro d'une tâche précédente de l'envoi)`);
        }
      }
      let epicId: string | null | undefined;
      if (item?.epicId !== undefined) {
        const checked = checkEpic(item.epicId, session.projectId, epics);
        if (!checked.ok) return error(reply, 400, `Tâche ${index + 1} : ${checked.message}`);
        epicId = checked.id;
      }
      items.push({ text, deps: deps as (string | number)[], epicId });
    }
    let createdEpic: Epic | null = null;
    if (newEpic !== null) {
      const result = createEpic(session.projectId, { title: newEpic.title, description: newEpic.description }, session.id);
      if (!result.ok) return error(reply, 400, result.message);
      createdEpic = result.epic;
      defaultEpic = result.epic.id;
    }
    // Les nouvelles tâches ne dépendent que de tâches existantes ou antérieures : pas de cycle possible.
    const created: Task[] = [];
    for (const { text, deps, epicId } of items) {
      const task = db.createTask(session.projectId, text, session.id, epicId === undefined ? defaultEpic : epicId);
      const dependsOn = deps.map((dep) => typeof dep === 'number' ? (created[dep - 1] as Task).id : dep);
      created.push(dependsOn.length === 0 ? task : db.updateTask(task.id, { dependsOn }) ?? task);
    }
    for (const task of created) broadcast({ type: 'task', task });
    return reply.code(201).send({
      count: created.length,
      epic: createdEpic === null ? null : { id: createdEpic.id, title: createdEpic.title },
      tasks: created.map(({ id, text, dependsOn, epicId }) => ({ id, text, dependsOn, epicId })),
    });
  });

  // Remplace les dépendances d'une tâche du projet.
  app.patch<{ Params: { id: string; taskId: string } }>('/api/backlog/:id/tasks/:taskId', async (request, reply) => {
    const session = backlogSession(request, reply);
    if (session === null) return reply;
    const current = db.getTask(request.params.taskId);
    if (current === null || current.projectId !== session.projectId) return error(reply, 404, 'Tâche introuvable dans ce projet');
    const body = bodyRecord(request.body);
    if (body === null || (body.dependsOn === undefined && body.epicId === undefined)) {
      return error(reply, 400, 'dependsOn ou epicId attendu');
    }
    const changes: { dependsOn?: string[]; epicId?: string | null } = {};
    if (body.dependsOn !== undefined) {
      const checked = checkDependencies(current, body.dependsOn, projectTasks(session.projectId));
      if (!checked.ok) return error(reply, 400, checked.message);
      changes.dependsOn = checked.ids;
    }
    if (body.epicId !== undefined) {
      const checked = checkEpic(body.epicId, session.projectId, db.listEpics());
      if (!checked.ok) return error(reply, 400, checked.message);
      changes.epicId = checked.id;
    }
    const task = db.updateTask(current.id, changes);
    if (task === null) return error(reply, 404, 'Tâche introuvable');
    broadcast({ type: 'task', task });
    return reply.send({ id: task.id, text: task.text, dependsOn: task.dependsOn, epicId: task.epicId });
  });

  // Supprime une tâche, uniquement si elle a été créée par cette session et n'a pas été démarrée.
  app.delete<{ Params: { id: string; taskId: string } }>('/api/backlog/:id/tasks/:taskId', async (request, reply) => {
    const session = backlogSession(request, reply);
    if (session === null) return reply;
    const task = db.getTask(request.params.taskId);
    if (task === null || task.projectId !== session.projectId) return error(reply, 404, 'Tâche introuvable dans ce projet');
    if (task.sourceSessionId !== session.id) return error(reply, 403, "Seules les tâches créées par cette session peuvent être supprimées ici");
    if (task.status !== 'todo') return error(reply, 409, 'Tâche déjà démarrée : à supprimer depuis l\'interface');
    const dependents = db.listDependents(task.id);
    db.deleteTask(task.id);
    broadcast({ type: 'task-deleted', id: task.id });
    for (const id of dependents) {
      const dependent = db.getTask(id);
      if (dependent !== null) broadcast({ type: 'task', task: dependent });
    }
    return reply.code(204).send();
  });

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
    sendSocket(socket, {
      type: 'snapshot',
      projects: db.listProjects(),
      sessions: db.listSessions(),
      tasks: db.listTasks(),
      epics: db.listEpics(),
    });
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
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws/') || request.url.startsWith('/m/')) {
      return error(reply, 404, 'Route introuvable');
    }
    if (existsSync(join(webDist, 'index.html')) && 'sendFile' in reply) return reply.sendFile('index.html');
    return error(reply, 404, 'Interface web non construite');
  });

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  await assertLoopbackPortFree(HOST, PORT, 'Serveur Cerebro');
  const app = await buildServer();
  startCatalogRefresh();
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
