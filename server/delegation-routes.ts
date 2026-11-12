import { isActiveRun } from '../shared/backlog.ts';
import type { Epic, Task } from '../shared/types.ts';
import { asRecord } from './util.ts';
import { error } from './routes-util.ts';
import type { RouteContext } from './route-context.ts';

// Délégation : faire traiter une tâche ou un epic par un autre projet. La source reste où elle est ; le projet
// cible reçoit une copie qui pointe vers elle (originTaskId / originEpicId). « Traité dans … » côté source se
// déduit de cette copie : supprimer la copie rend la source de nouveau disponible.
export function registerDelegationRoutes(ctx: RouteContext): void {
  const { app, db, epicRunner, broadcast } = ctx;

  const projectName = (id: string): string => db.getProject(id)?.name ?? id;

  // Cible demandée : un projet existant, différent de celui de la source.
  const target = (
    body: unknown,
    sourceProjectId: string,
  ): { ok: true; id: string } | { ok: false; status: number; message: string } => {
    const projectId = asRecord(body)?.projectId;
    if (typeof projectId !== 'string' || projectId === '')
      return { ok: false, status: 400, message: 'projectId attendu' };
    if (db.getProject(projectId) === null) return { ok: false, status: 404, message: 'Projet introuvable' };
    if (projectId === sourceProjectId)
      return { ok: false, status: 400, message: 'Choisissez un autre projet que celui de la source' };
    return { ok: true, id: projectId };
  };

  const delegateOfTask = (task: Task): Task | undefined => db.listTasks().find((t) => t.originTaskId === task.id);
  const delegateOfEpic = (epic: Epic): Epic | undefined => db.listEpics().find((e) => e.originEpicId === epic.id);

  app.post<{ Params: { id: string } }>('/api/tasks/:id/delegate', async (request, reply) => {
    const task = db.getTask(request.params.id);
    if (task === null) return error(reply, 404, 'Tâche introuvable');
    const to = target(request.body, task.projectId);
    if (!to.ok) return error(reply, to.status, to.message);
    const existing = delegateOfTask(task);
    if (existing) return error(reply, 409, `Tâche déjà traitée dans le projet ${projectName(existing.projectId)}`);
    if (task.status !== 'todo') return error(reply, 409, 'Seule une tâche à faire peut être déléguée');
    if (task.execution.type !== 'llm')
      return error(reply, 409, 'Une commande est propre à son projet : elle ne se délègue pas');
    if (task.epicId !== null)
      return error(reply, 409, "Tâche rangée dans un epic : déléguez l'epic, ou sortez la tâche de l'epic");
    if (task.dependsOn.some((id) => db.getTask(id)?.status !== 'done'))
      return error(reply, 409, 'Tâche bloquée par des dépendances ouvertes : terminez-les avant de la déléguer');
    const created = db.createTask(to.id, task.text, null, null, { type: 'llm' }, task.id, task.dueDate);
    broadcast({ type: 'task', task: created });
    return reply.code(201).send(created);
  });

  app.post<{ Params: { id: string } }>('/api/epics/:id/delegate', async (request, reply) => {
    const epic = db.getEpic(request.params.id);
    if (epic === null) return error(reply, 404, 'Epic introuvable');
    const to = target(request.body, epic.projectId);
    if (!to.ok) return error(reply, to.status, to.message);
    const existing = delegateOfEpic(epic);
    if (existing) return error(reply, 409, `Epic déjà traité dans le projet ${projectName(existing.projectId)}`);
    if (epicRunner.list(epic.id).some(isActiveRun))
      return error(reply, 409, 'Epic en cours : arrêtez-le avant de le déléguer');
    const all = db.listTasks();
    const open = all.filter((t) => t.epicId === epic.id && t.status !== 'done');
    if (open.length === 0) return error(reply, 409, 'Aucune tâche ouverte dans cet epic : rien à déléguer');
    const label = (t: Task): string => `« ${t.text.split('\n')[0]?.slice(0, 60)} »`;
    const started = open.find((t) => t.status !== 'todo');
    if (started) return error(reply, 409, `Tâche déjà démarrée dans l'epic : ${label(started)}`);
    const command = open.find((t) => t.execution.type !== 'llm');
    if (command) return error(reply, 409, `Une commande est propre à son projet : ${label(command)} ne se délègue pas`);
    const delegated = open.find((t) => all.some((other) => other.originTaskId === t.id));
    if (delegated) return error(reply, 409, `Tâche déjà traitée dans un autre projet : ${label(delegated)}`);
    const openIds = new Set(open.map((t) => t.id));
    for (const t of open) {
      const outside = t.dependsOn.find((id) => !openIds.has(id) && all.find((o) => o.id === id)?.status !== 'done');
      if (outside !== undefined)
        return error(reply, 409, `${label(t)} dépend d'une tâche ouverte hors de l'epic : terminez-la d'abord`);
    }
    const { createdEpic, tasks } = db.transaction(() => {
      const createdEpic = db.createEpic(to.id, epic.title, epic.description, null, epic.id, epic.dueDate);
      const copies = new Map<string, Task>();
      for (const t of open)
        copies.set(t.id, db.createTask(to.id, t.text, null, createdEpic.id, { type: 'llm' }, t.id, t.dueDate));
      const tasks = open.map((t) => {
        const copy = copies.get(t.id) as Task;
        const dependsOn = t.dependsOn.flatMap((id) => (copies.get(id) ? [(copies.get(id) as Task).id] : []));
        return dependsOn.length === 0 ? copy : (db.updateTask(copy.id, { dependsOn }) ?? copy);
      });
      return { createdEpic, tasks };
    });
    broadcast({ type: 'epic', epic: createdEpic });
    for (const task of tasks) broadcast({ type: 'task', task });
    return reply.code(201).send({ epic: createdEpic, tasks });
  });
}
