import { timingSafeEqual } from 'node:crypto';
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
import { startCatalogRefresh } from './catalog.ts';
import { BIND_TOKEN, HOST, PORT, ROOT } from './config.ts';
import { CerebroDatabase } from './db.ts';
import { onPushComplete } from './git-push.ts';
import { installGrokHook } from './hooks.ts';
import { PeerSync } from './peers.ts';
import { workspaceFor } from './provenance.ts';
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
  const record = asRecord(query);
  return typeof record?.token === 'string' ? record.token : undefined;
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, forceCloseConnections: true });
  const db = new CerebroDatabase();
  const sessions = new SessionManager(db);
  const commands = new CommandExecutor(db);
  commands.initialize();
  const eventSockets = new Set<WebSocket>();
  const broadcast = (event: unknown): void => {
    for (const socket of eventSockets) sendSocket(socket, event);
  };
  const peers = new PeerSync(db, () => broadcast({ type: 'peers' }));
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
      && !path.startsWith('/api/session-tasks/')
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
    const token = asRecord(request.body)?.token;
    if (typeof token !== 'string' || !tokenMatches(token)) return error(reply, 401, 'Jeton invalide');
    return reply.header('set-cookie', tokenCookie(request)).code(204).send();
  });

  registerRemoteGateway(app, peers);
  registerVscodeRelay(app, vscode);

  app.addHook('onClose', async () => {
    peers.stop();
    notifier.stop();
    unsubscribePush();
    vscode.stop();
    await automaticCommits.shutdown();
    await councils.shutdown();
    await worktrees.shutdown();
    await epicRunner.shutdown();
    await commands.shutdown();
    await sessions.shutdown();
    db.close();
  });

  const worktrees=registerWorktreeRoutes(app,db);
  const automaticCommits=registerAutomaticCommitRoutes(app,db,worktrees);
  registerPersonaRoutes(app, db);
  const councils=registerCouncilRoutes(app,db);
  sessions.withProjectDeletion=(id,remove)=>councils.withProjectDeletion(id,remove);
  notifier.councils=councils;
  councils.onComplete=run=>{
    const id=`council:${run.id}`;
    notifier.operations.record({id,projectId:run.projectId,sessionId:null,kind:'council',ok:run.status==='succeeded',summary:run.synthesis?.recommendation??`${run.status} : ${run.error??'aucune synthèse'}`,startedAt:run.startedAt,finishedAt:run.finishedAt??Date.now()});
    // Slack receives the synthesis in the request thread: no separate notification.
    if(run.origin==='slack')notifier.operations.seen(id);
  };
  automaticCommits.onComplete=operation=>{
    if(operation.projectId)notifier.operations.record({id:`auto-commit:${operation.id}`,projectId:operation.projectId,sessionId:operation.sessionId,kind:'commit',ok:operation.status==='succeeded',summary:[...operation.commits.map(commit=>`${commit.hash} ${commit.title}`),operation.error??'',operation.pushOperation?`Push : ${operation.pushOperation.status}`:''].filter(Boolean).join(' ; ')||'Aucun changement à commiter.',startedAt:operation.startedAt,finishedAt:operation.finishedAt??Date.now()});
  };
  const epicRunner = new EpicRunner(db, sessions, commands, broadcast);
  epicRunner.onResult=run=>{
    notifier.operations.record({id:`epic:${run.id}:${run.status}`,projectId:run.projectId,sessionId:run.sessionId,kind:'epic',ok:run.status==='succeeded',summary:run.status==='succeeded'?'Toutes les étapes ont satisfait leur critère de clôture.':`${run.status} : ${run.error??'progression arrêtée'}`,startedAt:run.startedAt,finishedAt:run.updatedAt});
    // Copies held back while the epic ran become eligible once it ends.
    if(run.status!=='blocked')void worktrees.resumeAutomaticCleanup(run.projectId);
  };
  const unsubscribePush=onPushComplete((path,operation)=>{
    if(automaticCommits.list().some(commit=>commit.pushOperation?.id===operation.id))return;
    let project=db.listProjects().find(p=>resolve(p.path)===resolve(path));
    let source:Session|undefined;
    if(!project){source=db.listSessions().find(s=>workspaceFor(db,s.id)?.root===path);if(source)project=db.getProject(source.projectId)??undefined;}
    if(!project)return;
    notifier.operations.record({id:operation.id,projectId:project.id,sessionId:source?.id??null,kind:'push',ok:operation.status==='succeeded',summary:operation.error??operation.remotes.map(r=>`${r.remote} : ${r.status}`).join(' ; '),startedAt:operation.startedAt,finishedAt:operation.finishedAt??Date.now()});
  });
  epicRunner.initialize();
  sessions.onSessionReleased=(id,root)=>{void worktrees.releaseSession(id,root);};
  worktrees.onSessionsChanged=ids=>{for(const id of ids){const session=db.getSession(id);if(session)broadcast({type:'session',session});}};
  // Copies whose conversation ended while the server was down, or before automatic cleanup existed.
  void worktrees.resumeAutomaticCleanup();
  commands.onChange = run => {
    epicRunner.poke();
    const task = db.getTask(run.taskId);
    if(task&&run.finishedAt!==null)notifier.operations.record({id:run.id,projectId:task.projectId,sessionId:null,kind:'command',ok:run.status==='succeeded',summary:`${run.command.name} : ${run.status}, code ${run.exitCode??'inconnu'}${run.error?` ; ${run.error}`:''} ; clôture du travail distincte.`,startedAt:run.startedAt,finishedAt:run.finishedAt});
    if (task) broadcast({type:'task',task});
  };
  sessions.onEvent((event) => {
    epicRunner.poke();
    if (event.type === 'turn-complete') return;
    broadcast(event);
  });

  const context = createRouteContext({ app, db, sessions, commands, notifier, peers, vscode, epicRunner, worktrees, broadcast });
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
    sendSocket(socket, {
      type: 'snapshot',
      projects: db.listProjects(),
      sessions: db.listSessions(),
      tasks: db.listTasks(),
      epics: db.listEpics(),
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
