import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import { EpicRunner } from './epic-runner.ts';
import { CommandExecutor } from './commands.ts';
import { registerWorktreeRoutes } from './worktree-routes.ts';
import { registerAutomaticCommitRoutes } from './automatic-commit-routes.ts';
import { registerPersonaRoutes } from './persona-routes.ts';
import { registerCouncilRoutes } from './council-routes.ts';
import type { Catalog } from './catalog.ts';
import { BIND_TOKEN, ensureDataDirs, HOST, PORT, ROOT } from './config.ts';
import { CerebroDatabase } from './db.ts';
import { installGrokHook } from './hooks.ts';
import { PeerSync } from './peers.ts';
import { workspaceFor } from './provenance.ts';
import { secretMatches } from './secret-compare.ts';
import { startHeartbeat } from './ws-heartbeat.ts';
import { originAllowed } from './origin.ts';
import { LOGGER_OPTIONS } from './log-redaction.ts';
import { createServices } from './services.ts';
import { assertLoopbackPortFree } from './ports.ts';
import { registerRemoteGateway } from './remotes.ts';
import { SessionManager } from './sessions.ts';
import { registerSessionTaskRoutes } from './session-tasks.ts';
import { SlackNotifier } from './slack.ts';
import { registerVscodeRelay, VscodeServer } from './vscode.ts';
import type { Session } from '../shared/types.ts';
import { asRecord } from './util.ts';
import { error } from './routes-util.ts';
import { createRouteContext, sendSocket } from './route-context.ts';
import { registerProjectRoutes } from './project-routes.ts';
import { registerSessionRoutes } from './session-routes.ts';
import { registerTaskRoutes } from './task-routes.ts';
import { registerEpicRoutes } from './epic-routes.ts';
import { registerBacklogRoutes } from './backlog-routes.ts';
import { registerHookRoutes } from './hook-routes.ts';
import { registerSystemRoutes } from './system-routes.ts';

const HISTORY_RETENTION_MS = 30 * 86_400_000;

function tokenMatches(candidate: string | undefined): boolean {
  return secretMatches(BIND_TOKEN, candidate);
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
  const record = asRecord(query);
  return typeof record?.token === 'string' ? record.token : undefined;
}

/**
 * `catalog`: model lists to start from (fallback lists by default).
 * `refreshCatalog`: discover the installed CLIs' models now and hourly, until the server closes.
 */
export async function buildServer(
  options: { catalog?: Catalog; refreshCatalog?: boolean } = {},
): Promise<FastifyInstance> {
  ensureDataDirs();
  const app = Fastify({ logger: LOGGER_OPTIONS, forceCloseConnections: true });
  const db = new CerebroDatabase();
  const services = createServices(db, options.catalog);
  const { catalog, epicWorkspaces, git, pushes, reviews, sessionGit } = services;
  if (options.refreshCatalog) {
    const stopRefresh = catalog.startRefresh();
    app.addHook('onClose', async () => stopRefresh());
  }
  const sessions = new SessionManager(db, services);
  const commands = new CommandExecutor(db, services.gate);
  const interruptedRuns = commands.initialize();
  const eventSockets = new Set<WebSocket>();
  const eventHeartbeat = startHeartbeat();
  const broadcast = (event: unknown): void => {
    for (const socket of eventSockets) sendSocket(socket, event);
  };
  const peers = new PeerSync(db, () => broadcast({ type: 'peers' }));
  const notifier = new SlackNotifier(sessions, db, peers);
  const vscode = new VscodeServer();
  // Au-delà de 30 jours, résultats d’opérations et runs terminés ne servent plus : la purge borne les tables.
  const purgeHistory = (): void => {
    const before = Date.now() - HISTORY_RETENTION_MS;
    try {
      notifier.operations.purge(before);
      commands.purge(before);
    } catch (cause) {
      app.log.error(cause, 'Purge de l’historique impossible');
    }
  };
  purgeHistory();
  const purgeTimer = setInterval(purgeHistory, 86_400_000);
  purgeTimer.unref();

  installGrokHook();
  await sessions.initialize();
  await app.register(fastifyWebsocket);

  app.addHook('onRequest', async (request, reply) => {
    const queryToken = requestQueryToken(request.query);
    const explicitToken = tokenMatches(queryToken) || tokenMatches(bearerToken(request.headers.authorization));
    if (!originAllowed(request, explicitToken)) return error(reply, 403, 'Origine refusée');
    const path = request.url.split('?', 1)[0];
    if (BIND_TOKEN !== undefined && path === '/' && tokenMatches(queryToken)) {
      reply.header('set-cookie', tokenCookie(request));
    }

    const protectedRoute =
      (path.startsWith('/api/') &&
        path !== '/api/auth' &&
        !path.startsWith('/api/hook/') &&
        !path.startsWith('/api/notify/') &&
        !path.startsWith('/api/session-tasks/') &&
        !path.startsWith('/api/backlog/')) ||
      path.startsWith('/ws/') ||
      path.startsWith('/m/') ||
      path === '/vscode' ||
      path.startsWith('/vscode/');
    if (BIND_TOKEN === undefined || !protectedRoute) return;
    const authorized = explicitToken || tokenMatches(cookieValue(request.headers.cookie, 'cerebro_token'));
    if (!authorized) return error(reply, 401, 'Token requis');
  });

  // Échange du jeton contre le cookie via /api : passe aussi par le proxy de Vite en dev,
  // contrairement à `/?token=`, servi par Vite.
  app.post('/api/auth', async (request, reply) => {
    if (BIND_TOKEN === undefined) return reply.code(204).send();
    const token = asRecord(request.body)?.token;
    if (typeof token !== 'string' || !tokenMatches(token)) return error(reply, 401, 'Jeton invalide');
    return reply.header('set-cookie', tokenCookie(request)).code(204).send();
  });

  registerRemoteGateway(app, peers);
  registerVscodeRelay(app, vscode);

  app.addHook('onClose', async () => {
    clearInterval(purgeTimer);
    eventHeartbeat.stop();
    peers.stop();
    notifier.stop();
    unsubscribePush();
    await vscode.stop();
    await automaticCommits.shutdown();
    await councils.shutdown();
    await worktrees.shutdown();
    await epicRunner.shutdown();
    await commands.shutdown();
    await sessions.shutdown();
    db.close();
  });

  const worktrees = registerWorktreeRoutes(app, db, services);
  const automaticCommits = registerAutomaticCommitRoutes(app, db, worktrees, services);
  registerPersonaRoutes(app, db);
  const councils = registerCouncilRoutes(app, db, catalog);
  sessions.withProjectDeletion = (id, remove) => councils.withProjectDeletion(id, remove);
  notifier.councils = councils;
  councils.onComplete = (run) => {
    const id = `council:${run.id}`;
    notifier.operations.record({
      id,
      projectId: run.projectId,
      sessionId: null,
      kind: 'council',
      ok: run.status === 'succeeded',
      summary: run.synthesis?.recommendation ?? `${run.status} : ${run.error ?? 'aucune synthèse'}`,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? Date.now(),
    });
    // Slack receives the synthesis in the request thread: no separate notification.
    if (run.origin === 'slack') notifier.operations.seen(id);
  };
  automaticCommits.onComplete = (operation) => {
    if (operation.projectId)
      notifier.operations.record({
        id: `auto-commit:${operation.id}`,
        projectId: operation.projectId,
        sessionId: operation.sessionId,
        kind: 'commit',
        ok: operation.status === 'succeeded',
        summary:
          [
            ...operation.commits.map((commit) => `${commit.hash} ${commit.title}`),
            operation.commits.length && operation.overridden.length
              ? `Inclus malgré un secret détecté (dérogation) : ${operation.overridden.join(', ')}`
              : '',
            operation.error ?? '',
            operation.pushOperation ? `Push : ${operation.pushOperation.status}` : '',
          ]
            .filter(Boolean)
            .join(' ; ') || 'Aucun changement à commiter.',
        startedAt: operation.startedAt,
        finishedAt: operation.finishedAt ?? Date.now(),
      });
  };
  const epicRunner = new EpicRunner(db, sessions, commands, broadcast, epicWorkspaces);
  epicRunner.onResult = (run) => {
    notifier.operations.record({
      id: `epic:${run.id}:${run.status}`,
      projectId: run.projectId,
      sessionId: run.sessionId,
      kind: 'epic',
      ok: run.status === 'succeeded',
      summary:
        run.status === 'succeeded'
          ? 'Toutes les étapes ont satisfait leur critère de clôture.'
          : `${run.status} : ${run.error ?? 'progression arrêtée'}`,
      startedAt: run.startedAt,
      finishedAt: run.updatedAt,
    });
    // Copies held back while the epic ran become eligible once it ends.
    if (run.status !== 'blocked') void worktrees.resumeAutomaticCleanup(run.projectId);
  };
  const unsubscribePush = pushes.onComplete((path, operation) => {
    if (automaticCommits.list().some((commit) => commit.pushOperation?.id === operation.id)) return;
    let project = db.listProjects().find((p) => resolve(p.path) === resolve(path));
    let source: Session | undefined;
    if (!project) {
      source = db.listSessions().find((s) => workspaceFor(db, s.id)?.root === path);
      if (source) project = db.getProject(source.projectId) ?? undefined;
    }
    if (!project) return;
    notifier.operations.record({
      id: operation.id,
      projectId: project.id,
      sessionId: source?.id ?? null,
      kind: 'push',
      ok: operation.status === 'succeeded',
      summary: operation.error ?? operation.remotes.map((r) => `${r.remote} : ${r.status}`).join(' ; '),
      startedAt: operation.startedAt,
      finishedAt: operation.finishedAt ?? Date.now(),
    });
  });
  epicRunner.initialize();
  sessions.onSessionReleased = (id, root) => {
    void worktrees.releaseSession(id, root);
  };
  worktrees.onSessionsChanged = (ids) => {
    for (const id of ids) {
      const session = db.getSession(id);
      if (session) broadcast({ type: 'session', session });
    }
  };
  // Copies whose conversation ended while the server was down, or before automatic cleanup existed.
  void worktrees.resumeAutomaticCleanup();
  commands.onChange = (run) => {
    epicRunner.commandChanged(run);
    epicRunner.poke();
    const task = db.getTask(run.taskId);
    if (task && run.finishedAt !== null)
      notifier.operations.record({
        id: run.id,
        projectId: task.projectId,
        sessionId: null,
        kind: 'command',
        ok: run.status === 'succeeded',
        summary: `${run.command.name} : ${run.status}, code ${run.exitCode ?? 'inconnu'}${run.error ? ` ; ${run.error}` : ''} ; clôture du travail distincte.`,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      });
    if (task) broadcast({ type: 'task', task });
    // Without its output (up to 1 MiB): an open view fetches it through /api/tasks/:id/runs.
    broadcast({ type: 'command-run', run: { ...run, output: undefined } });
  };
  // Runs cut short by the previous shutdown: broadcast and recorded like any other ending.
  for (const run of interruptedRuns) commands.onChange(run);
  sessions.onEvent((event) => {
    // Sessions, their copies and project folders all feed the recovery of an epic's folder.
    epicRunner.sessionChanged(event);
    epicRunner.poke();
    if (event.type === 'turn-complete') return;
    broadcast(event);
  });

  const context = createRouteContext({
    app,
    db,
    sessions,
    commands,
    notifier,
    peers,
    vscode,
    epicRunner,
    worktrees,
    catalog,
    git,
    pushes,
    reviews,
    sessionGit,
    epicWorkspaces,
    broadcast,
  });
  registerSessionTaskRoutes(app, db, context.sessionTokenValid);
  registerSystemRoutes(context);
  registerProjectRoutes(context);
  registerSessionRoutes(context);
  registerTaskRoutes(context);
  registerEpicRoutes(context);
  registerBacklogRoutes(context);
  registerHookRoutes(context);

  app.get('/ws/events', { websocket: true }, (socket) => {
    eventSockets.add(socket);
    eventHeartbeat.watch(socket);
    sendSocket(socket, {
      type: 'snapshot',
      projects: db.listProjects(),
      sessions: db.listSessions(),
      tasks: db.listTasks(),
      epics: db.listEpics(),
      // Annonce les événements epic-run et command-run : sans ce champ (instance antérieure), l'UI les relit périodiquement.
      runEvents: true,
    });
    socket.on('close', () => eventSockets.delete(socket));
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
  const app = await buildServer({ refreshCatalog: true });
  await app.listen({ host: HOST, port: PORT });
  return app;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer()
    .then((app) => {
      let closing = false;
      const shutdown = async (code = 0): Promise<void> => {
        if (closing) return;
        closing = true;
        try {
          await app.close();
          process.exit(code);
        } catch (caught) {
          const message = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
          process.stderr.write(`${message}\n`);
          process.exit(1);
        }
      };
      process.once('SIGINT', () => void shutdown());
      process.once('SIGTERM', () => void shutdown());
      // Dernier filet : une promesse rejetée sans gestionnaire est journalisée sans arrêter le serveur ;
      // une exception synchrone laisse un état incertain, le serveur s'arrête alors proprement.
      process.on('unhandledRejection', (reason) => {
        process.stderr.write(
          `${new Date().toISOString()} Promesse rejetée non gérée : ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
        );
      });
      process.on('uncaughtException', (caught) => {
        process.stderr.write(
          `${new Date().toISOString()} Exception non gérée, arrêt du serveur : ${caught.stack ?? caught.message}\n`,
        );
        process.exitCode = 1;
        // Une fermeture bloquée ne doit pas laisser un serveur à moitié arrêté.
        setTimeout(() => process.exit(1), 10_000).unref();
        void shutdown(1);
      });
    })
    .catch((caught: unknown) => {
      const message = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
