import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Catalog } from './catalog.ts';
import { validateCouncilSettings } from './council.ts';
import { assertNoGitOperation } from './git-plan.ts';
import { gitSummary } from './git-summary.ts';
import { reviewInstructions } from './review.ts';
import { AGENTS, isAgent, isMode, normalizeMode, type Agent, type Project } from '../shared/types.ts';
import { asRecord } from './util.ts';
import { error } from './routes-util.ts';
import { orError, parseSessionDefaults, type RouteContext } from './route-context.ts';
import { normalizeRegenerablePath } from '../shared/worktrees.ts';

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

// Réglages LLM d'un projet (commits, résolution) : `keys` sont les champs admis, `valid` contrôle ceux propres
// au réglage. Changer d'agent réinitialise modèle et effort.
function patchLlmSettings<T extends { agent: Agent }>(
  catalog: Catalog,
  previous: T,
  raw: unknown,
  keys: readonly string[],
  valid: (patch: Record<string, unknown>) => boolean,
): T | 'invalid' | 'tuning' {
  const patch = asRecord(raw);
  if (
    !patch ||
    Object.keys(patch).some((key) => !keys.includes(key)) ||
    ('agent' in patch && !isAgent(patch.agent)) ||
    !valid(patch)
  )
    return 'invalid';
  const agent = (patch.agent ?? previous.agent) as Agent;
  const resolved = {
    ...previous,
    ...(agent !== previous.agent ? { model: null, effort: null } : {}),
    ...patch,
    agent,
  } as T;
  const tuning = catalog.parseTuning(agent, { ...resolved });
  return tuning ? { ...resolved, ...tuning } : 'tuning';
}

const TUNING_ERROR = 'Modèle ou effort invalide pour cet agent';

export function registerProjectRoutes(ctx: RouteContext): void {
  const {
    app,
    db,
    sessions,
    peers,
    vscode,
    catalog,
    git,
    pushes,
    reviews,
    broadcast,
    requireProject,
    launchReview,
    recordCommit,
    worktrees,
  } = ctx;

  const broadcastProjects = (): void => broadcast({ type: 'projects', projects: db.listProjects() });

  app.get('/api/projects', async () => db.listProjects());

  app.put('/api/projects/order', async (request, reply) => {
    const ids = asRecord(request.body)?.ids;
    if (
      !Array.isArray(ids) ||
      !ids.every((id): id is string => typeof id === 'string') ||
      new Set(ids).size !== ids.length
    ) {
      return error(reply, 400, 'Une liste d’identifiants de projets sans doublons est requise');
    }
    const projects = db.reorderProjects(ids);
    if (projects === null) return error(reply, 409, 'La liste des projets a changé. Rechargez la page puis réessayez.');
    broadcast({ type: 'projects', projects });
    return projects;
  });

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
    const body = asRecord(request.body);
    if (
      body === null ||
      typeof body.name !== 'string' ||
      body.name.trim() === '' ||
      typeof body.path !== 'string' ||
      body.path.trim() === ''
    ) {
      return error(reply, 400, 'Les champs name et path sont requis');
    }
    const projectPath = expandProjectPath(body.path.trim());
    if (!validDirectory(projectPath)) return error(reply, 400, "Le répertoire n'existe pas ou n'est pas un répertoire");
    if ('workspaceMode' in body && body.workspaceMode !== 'isolated' && body.workspaceMode !== 'shared')
      return error(reply, 400, 'Mode de travail invalide');
    const project = db.createProject(
      body.name.trim(),
      projectPath,
      body.workspaceMode === 'shared' ? 'shared' : 'isolated',
    );
    broadcastProjects();
    void peers.sync();
    return reply.code(201).send(project);
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const body = asRecord(request.body);
    // Réglages LLM : validés contre le catalogue réel, pas contre le repli du démarrage.
    if (
      body !== null &&
      ['sessionDefaults', 'commitSettings', 'resolutionSettings', 'councilSettings'].some((key) => key in body)
    )
      await catalog.ready();
    const project = requireProject(request, reply);
    if (project === null) return reply;
    if (body === null) return error(reply, 400, 'Corps de requête invalide');

    const changes: Partial<
      Pick<
        Project,
        | 'name'
        | 'path'
        | 'color'
        | 'sessionDefaults'
        | 'commitSettings'
        | 'resolutionSettings'
        | 'councilSettings'
        | 'workspaceMode'
        | 'regenerablePaths'
      >
    > = {};
    if ('workspaceMode' in body) {
      if (body.workspaceMode !== 'isolated' && body.workspaceMode !== 'shared')
        return error(reply, 400, 'Mode de travail invalide');
      changes.workspaceMode = body.workspaceMode;
    }
    if ('regenerablePaths' in body) {
      const raw = body.regenerablePaths;
      if (!Array.isArray(raw) || raw.length > 50 || raw.some((item) => typeof item !== 'string'))
        return error(reply, 400, 'Chemins régénérables invalides (50 au plus)');
      const paths = (raw as string[]).map(normalizeRegenerablePath);
      const invalid = (raw as string[]).find((_, index) => paths[index] === null);
      if (invalid !== undefined)
        return error(reply, 400, `Chemin régénérable invalide : « ${invalid} » (chemin relatif à la copie attendu)`);
      changes.regenerablePaths = [...new Set(paths as string[])];
    }
    if ('name' in body) {
      if (typeof body.name !== 'string' || body.name.trim() === '')
        return error(reply, 400, 'Le nom ne peut pas être vide');
      changes.name = body.name.trim();
    }
    if ('path' in body) {
      if (typeof body.path !== 'string' || body.path.trim() === '')
        return error(reply, 400, 'Le chemin ne peut pas être vide');
      const projectPath = expandProjectPath(body.path.trim());
      if (!validDirectory(projectPath))
        return error(reply, 400, "Le répertoire n'existe pas ou n'est pas un répertoire");
      changes.path = projectPath;
    }
    if ('color' in body) {
      if (body.color !== null && (typeof body.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.color))) {
        return error(reply, 400, 'Couleur invalide (format #rrggbb attendu)');
      }
      changes.color = body.color === null ? null : body.color.toLowerCase();
    }
    if ('sessionDefaults' in body) {
      const defaults = parseSessionDefaults(catalog, project.sessionDefaults, body.sessionDefaults);
      if (defaults === null) return error(reply, 400, 'Paramètres de session invalides pour cet agent');
      changes.sessionDefaults = defaults;
    }
    if ('commitSettings' in body) {
      const settings = patchLlmSettings(
        catalog,
        project.commitSettings,
        body.commitSettings,
        ['agent', 'model', 'effort', 'strategy'],
        (patch) => !('strategy' in patch) || patch.strategy === 'single' || patch.strategy === 'atomic',
      );
      if (settings === 'invalid') return error(reply, 400, 'Paramètres de commits invalides');
      if (settings === 'tuning') return error(reply, 400, TUNING_ERROR);
      changes.commitSettings = settings;
    }
    if ('councilSettings' in body) {
      // null : le projet revient aux réglages globaux.
      if (body.councilSettings === null) changes.councilSettings = null;
      else {
        const result = validateCouncilSettings(catalog, body.councilSettings, db.listPersonas(), AGENTS);
        if ('error' in result) return error(reply, 400, result.error);
        changes.councilSettings = result.settings;
      }
    }
    if ('resolutionSettings' in body) {
      const settings = patchLlmSettings(
        catalog,
        project.resolutionSettings,
        body.resolutionSettings,
        ['agent', 'mode', 'model', 'effort'],
        (patch) => !('mode' in patch) || isMode(patch.mode),
      );
      if (settings === 'invalid') return error(reply, 400, 'Paramètres de résolution invalides');
      if (settings === 'tuning') return error(reply, 400, TUNING_ERROR);
      changes.resolutionSettings = { ...settings, mode: normalizeMode(settings.mode) };
    }
    const updated = db.updateProject(project.id, changes);
    if (updated === null) return error(reply, 404, 'Projet introuvable');
    if (updated.path !== project.path) sessions.forgetInputContexts();
    // Copies kept only because of a newly declared path can now go.
    if (JSON.stringify(updated.regenerablePaths) !== JSON.stringify(project.regenerablePaths))
      void worktrees.resumeAutomaticCleanup(project.id);
    // Un renommage compte comme une apparition : la machine qui renomme prend la main sur Slack.
    if (updated.name !== project.name) peers.renamed(project.id);
    else if (updated.path !== project.path) void peers.sync();
    broadcastProjects();
    return reply.send(updated);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/git/prepare-review', async (request, reply) => {
    const project = requireProject(request, reply);
    if (project === null) return reply;
    const result = await orError(reply, () => reviews.prepare(project.path));
    return result.ok ? reply.send(result.value) : result.reply;
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/git/review', async (request, reply) => {
    const project = requireProject(request, reply);
    if (project === null) return reply;
    const body = asRecord(request.body);
    if (typeof body?.reviewId !== 'string') return error(reply, 400, 'reviewId requis');
    const id = body.reviewId;
    const result = await orError(reply, () => reviews.verify(project.path, id));
    if (!result.ok) return result.reply;
    const prepared = result.value;
    return launchReview(
      reply,
      project,
      body.launch,
      reviewInstructions(prepared.root, { ...prepared, context: undefined }, prepared.context),
      async () => {
        await reviews.verify(project.path, id);
      },
    );
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/git/prepare-commit', async (request, reply) => {
    const project = requireProject(request, reply);
    if (project === null) return reply;
    // Early refusal: a plan prepared during a merge or rebase could not be executed anyway.
    const result = await orError(reply, async () => {
      await assertNoGitOperation(project.path);
      return git.prepareCommit(project.path);
    });
    return result.ok ? reply.send(result.value) : result.reply;
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/git/commit', async (request, reply) => {
    const project = requireProject(request, reply);
    if (project === null) return reply;
    const startedAt = Date.now();
    const result = await orError(reply, () => git.executeCommitPlan(project.path, request.body));
    if (result.ok) recordCommit(result.value, request.body, project.id, null, startedAt);
    return result.ok ? reply.send(result.value) : result.reply;
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/git/push', async (request, reply) => {
    const project = requireProject(request, reply);
    if (project === null) return reply;
    const result = await orError(reply, () => pushes.current(project.path));
    return result.ok ? reply.send(result.value) : result.reply;
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/git/push', async (request, reply) => {
    const project = requireProject(request, reply);
    if (project === null) return reply;
    // Pushing only sends existing commits: uncommitted files may stay when the caller says so.
    const result = await orError(reply, () =>
      pushes.start(project.path, { allowDirty: asRecord(request.body)?.allowDirty === true }),
    );
    return result.ok ? reply.code(202).send(result.value) : result.reply;
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/git', async (request, reply) => {
    const project = requireProject(request, reply);
    if (project === null) return reply;
    return reply.send(await gitSummary(project.path, asRecord(request.query)?.commits === 'true'));
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/vscode', async (request, reply) => {
    const project = requireProject(request, reply);
    if (project === null) return reply;
    try {
      const opened = await vscode.open(project.path);
      return reply.code(opened.ready ? 200 : 202).send(opened);
    } catch (caught) {
      return error(reply, 502, caught instanceof Error ? caught.message : 'VS Code indisponible');
    }
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/slack', async (request, reply) => {
    const project = requireProject(request, reply);
    if (project === null) return reply;
    return reply.send(peers.projectStatus(project));
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/slack/acquire', async (request, reply) => {
    const project = requireProject(request, reply);
    if (project === null) return reply;
    const status = peers.acquire(project);
    if (status === null) return error(reply, 409, "Ce projet n'est pas partagé avec une autre machine");
    return reply.send(status);
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    // La base supprime aussi le backlog du projet (ON DELETE CASCADE) : le relever avant.
    const taskIds = db
      .listTasks()
      .filter((task) => task.projectId === request.params.id)
      .map((task) => task.id);
    const epicIds = db
      .listEpics()
      .filter((epic) => epic.projectId === request.params.id)
      .map((epic) => epic.id);
    const result = await orError(reply, () => sessions.deleteProject(request.params.id));
    if (!result.ok) return result.reply;
    if (!result.value) return error(reply, 404, 'Projet introuvable');
    for (const id of taskIds) broadcast({ type: 'task-deleted', id });
    for (const id of epicIds) broadcast({ type: 'epic-deleted', id });
    broadcastProjects();
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
}
