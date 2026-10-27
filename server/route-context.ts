import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import type { CommandExecutor } from './commands.ts';
import type { Catalog } from './catalog.ts';
import { CouncilError } from './council-runner.ts';
import { resolveSessionDefaults, SessionProtectionError, type CerebroDatabase } from './db.ts';
import type { EpicRunner } from './epic-runner.ts';
import type { EpicWorkspaces } from './epic-workspace.ts';
import { saveReport } from './findings.ts';
import type { PeerSync } from './peers.ts';
import type { SessionManager } from './sessions.ts';
import type { SlackNotifier } from './slack.ts';
import type { VscodeServer } from './vscode.ts';
import type { WorktreeManager } from './worktrees.ts';
import type { GitPlanner } from './git-plan.ts';
import type { GitPushes } from './git-push.ts';
import type { Reviews } from './review.ts';
import type { SessionGit } from './session-git.ts';
import {
  isAgent,
  isMode,
  type Epic,
  type Project,
  type Session,
  type SessionDefaults,
  type Task,
} from '../shared/types.ts';
import type { CommitResult } from '../shared/git.ts';
import { asRecord } from './util.ts';
import { error, routeErrors, type Outcome } from './routes-util.ts';

// Erreurs métier connues : session protégée (409), council (son code) ; 500 pour les autres.
export const { orError } = routeErrors((cause) =>
  cause instanceof SessionProtectionError ? 409 : cause instanceof CouncilError ? cause.statusCode : 500,
);
export const badRequest = routeErrors(400);
export const conflict = routeErrors(409);

export function sendSocket(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

export type IdRequest = FastifyRequest<{ Params: { id: string } }>;

// Services du serveur, partagés par les modules de routes.
export interface RouteServices {
  app: FastifyInstance;
  db: CerebroDatabase;
  sessions: SessionManager;
  commands: CommandExecutor;
  notifier: SlackNotifier;
  peers: PeerSync;
  vscode: VscodeServer;
  epicRunner: EpicRunner;
  worktrees: WorktreeManager;
  catalog: Catalog;
  git: GitPlanner;
  pushes: GitPushes;
  reviews: Reviews;
  sessionGit: SessionGit;
  epicWorkspaces: EpicWorkspaces;
  broadcast: (event: unknown) => void;
}

export type RouteContext = ReturnType<typeof createRouteContext>;

export function parseSessionDefaults(
  catalog: Catalog,
  defaults: SessionDefaults,
  value: unknown,
): SessionDefaults | null {
  const body = asRecord(value);
  if (
    body === null ||
    ('agent' in body && !isAgent(body.agent)) ||
    ('mode' in body && !isMode(body.mode)) ||
    ('prompt' in body && typeof body.prompt !== 'string')
  )
    return null;
  const resolved = resolveSessionDefaults(defaults, body as Partial<SessionDefaults>);
  const tuning = catalog.parseTuning(resolved.agent, { ...resolved });
  return tuning === null ? null : { ...resolved, ...tuning };
}

export function createRouteContext(services: RouteServices) {
  const { db, sessions, notifier, catalog, broadcast } = services;

  // Préludes des routes `/:id` : rendent l'objet, ou répondent 404 et rendent null (la route rend alors `reply`).
  const found = <T>(value: T | null, reply: FastifyReply, message: string): T | null => {
    if (value === null) error(reply, 404, message);
    return value;
  };
  const requireProject = (request: IdRequest, reply: FastifyReply): Project | null =>
    found(db.getProject(request.params.id), reply, 'Projet introuvable');
  const requireSession = (request: IdRequest, reply: FastifyReply): Session | null =>
    found(db.getSession(request.params.id), reply, 'Session introuvable');
  const requireEpic = (request: IdRequest, reply: FastifyReply): Epic | null =>
    found(db.getEpic(request.params.id), reply, 'Epic introuvable');

  // Routes appelées par les agents : le jeton de la session (en-tête x-cerebro-token) tient lieu d'authentification.
  const sessionTokenValid = (request: IdRequest): boolean => {
    const token = request.headers['x-cerebro-token'];
    return typeof token === 'string' && sessions.tokenMatches(request.params.id, token);
  };
  // The session, or the error reply already sent in its place: the caller returns `reply` as is.
  const tokenSession = (request: IdRequest, reply: FastifyReply): Outcome<Session> => {
    if (!sessionTokenValid(request)) return { ok: false, reply: error(reply, 403, 'Token de hook invalide') };
    const session = db.getSession(request.params.id);
    if (session === null) return { ok: false, reply: error(reply, 404, 'Session introuvable') };
    return { ok: true, value: session };
  };

  const projectTasks = (projectId: string): Task[] => db.listTasks().filter((t) => t.projectId === projectId);

  const broadcastTasks = (ids: Iterable<string>): void => {
    for (const id of ids) {
      const task = db.getTask(id);
      if (task !== null) broadcast({ type: 'task', task });
    }
  };

  // Omitted fields inherit the project's last choices; null resets to the Cerebro default (parseTuning).
  // `remember` replaces rawBody as the form settings to keep when the prompt embeds generated instructions.
  // The launched prompt is not remembered: only the project's « Nouvelle session » form edits it (PATCH).
  const launchSession = async (
    reply: FastifyReply,
    project: Project,
    rawBody: unknown,
    respond: (session: Session) => unknown,
    validate?: () => Promise<void>,
    { epicId = null, remember }: { epicId?: string | null; remember?: unknown } = {},
  ): Promise<FastifyReply> => {
    await catalog.ready();
    const defaults = parseSessionDefaults(catalog, project.sessionDefaults, rawBody);
    if (defaults === null) return error(reply, 400, 'Paramètres de session invalides pour cet agent');
    const remembered = remember === undefined ? null : parseSessionDefaults(catalog, project.sessionDefaults, remember);
    try {
      const session = await sessions.create(project, defaults, {
        validate,
        epicId,
        rememberDefaults: remember === undefined,
        rememberPrompt: false,
      });
      if (remembered !== null) {
        const { prompt: _prompt, ...settings } = remembered;
        sessions.rememberDefaults(project.id, settings);
      }
      return reply.code(201).send(respond(session));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Impossible de lancer la session';
      return error(reply, 500, message);
    }
  };

  // Session de review : les consignes de review suivent le prompt saisi au lancement.
  const launchReview = (
    reply: FastifyReply,
    project: Project,
    rawLaunch: unknown,
    instructions: string,
    validate: () => Promise<void>,
  ): Promise<FastifyReply> => {
    const launch = asRecord(rawLaunch) ?? {};
    return launchSession(
      reply,
      project,
      { ...launch, prompt: `${typeof launch.prompt === 'string' ? launch.prompt : ''}\n\n${instructions}` },
      (session) => session,
      validate,
      { remember: launch },
    );
  };

  // Commit lancé depuis l'interface : l'opération est rattachée au plan (snapshotId) et rejoint le journal.
  const recordCommit = (
    result: CommitResult,
    body: unknown,
    projectId: string,
    sessionId: string | null,
    startedAt: number,
  ): void => {
    const id = `commit:${String(asRecord(body)?.snapshotId)}`;
    result.operationId = id;
    notifier.operations.record({
      id,
      projectId,
      sessionId,
      kind: 'commit',
      ok: !result.error,
      summary: result.error ?? result.commits.map((c) => `${c.hash} ${c.title}`).join(' ; '),
      startedAt,
      finishedAt: Date.now(),
    });
  };

  const publishFindings = (sessionId: string, raw: unknown) => {
    const before = db.getSession(sessionId)?.pendingFindings ?? 0;
    const report = saveReport(db, sessionId, raw);
    const session = db.getSession(sessionId);
    if (session) broadcast({ type: session.pendingFindings > before ? 'findings-available' : 'session', session });
    return report;
  };

  return {
    ...services,
    found,
    requireProject,
    requireSession,
    requireEpic,
    sessionTokenValid,
    tokenSession,
    projectTasks,
    broadcastTasks,
    launchSession,
    launchReview,
    recordCommit,
    publishFindings,
  };
}
