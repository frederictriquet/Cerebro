import { isActiveRun } from '../shared/backlog.ts';
import type { Epic, Task } from '../shared/types.ts';
import { asRecord } from './util.ts';
import { error } from './routes-util.ts';
import type { RouteContext } from './route-context.ts';

const MAX_CLAIMED = 100;

// Rattachement : une session s'approprie des tâches (ou les tâches ouvertes d'un epic) qui existent déjà dans le
// backlog de son projet, par exemple parce que l'utilisateur a commencé à les traiter sans passer par « Traiter ».
// Elles prennent l'état d'une tâche lancée depuis le backlog : démarrées, confiées à cette session, que
// `cerebro-backlog --done <id>` peut ensuite clore. Tout ou rien : une tâche refusée n'en rattache aucune.
export function registerClaimRoutes(ctx: RouteContext): void {
  const { app, db, epicRunner, broadcast, tokenSession } = ctx;

  const label = (t: Task): string => `« ${t.text.split('\n')[0]?.slice(0, 60)} »`;

  // Identifiants demandés (tâches ou epics du projet de la session) → tâches concernées, ou la raison du refus.
  const resolve = (
    projectId: string,
    body: unknown,
    selectMembers: (epic: Epic, members: Task[]) => Task[],
  ): { ok: true; tasks: Task[]; explicit: Set<string> } | { ok: false; status: number; message: string } => {
    const ids = asRecord(body)?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > MAX_CLAIMED ||
      !ids.every((id) => typeof id === 'string')
    )
      return {
        ok: false,
        status: 400,
        message: `ids doit lister entre 1 et ${MAX_CLAIMED} identifiants de tâche ou d'epic`,
      };
    const all = db.listTasks();
    const found = new Map<string, Task>();
    const explicit = new Set<string>();
    for (const id of new Set(ids as string[])) {
      const task = all.find((t) => t.id === id);
      if (task !== undefined) {
        if (task.projectId !== projectId)
          return { ok: false, status: 404, message: `Introuvable dans ce projet : ${id}` };
        found.set(task.id, task);
        explicit.add(task.id);
        continue;
      }
      const epic = db.getEpic(id);
      if (epic === null || epic.projectId !== projectId)
        return { ok: false, status: 404, message: `Introuvable dans ce projet : ${id}` };
      const members = selectMembers(
        epic,
        all.filter((t) => t.epicId === epic.id),
      );
      if (members.length === 0)
        return { ok: false, status: 409, message: `Aucune tâche concernée dans l'epic « ${epic.title.slice(0, 60)} »` };
      if (epicRunner.list(epic.id).some(isActiveRun))
        return { ok: false, status: 409, message: `Epic en cours d'exécution : « ${epic.title.slice(0, 60)} »` };
      for (const member of members) found.set(member.id, member);
    }
    return { ok: true, tasks: [...found.values()], explicit };
  };

  app.post<{ Params: { id: string } }>('/api/backlog/:id/claim', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const session = checked.value;
    const resolved = resolve(session.projectId, request.body, (_epic, members) =>
      members.filter((t) => t.status !== 'done'),
    );
    if (!resolved.ok) return error(reply, resolved.status, resolved.message);
    const all = db.listTasks();
    const already: string[] = [];
    const toClaim: Task[] = [];
    for (const task of resolved.tasks) {
      if (task.status === 'done') return error(reply, 409, `Tâche déjà terminée : ${label(task)}`);
      if (task.status === 'started' && task.sessionId === session.id) {
        already.push(task.id);
        continue;
      }
      if (task.status === 'started') {
        // Une session arrêtée ou supprimée ne retient plus la tâche (comme « Relancer » depuis le backlog).
        const holder = task.sessionId === null ? null : db.getSession(task.sessionId);
        if (holder !== null && holder.status !== 'exited')
          return error(reply, 409, `Tâche déjà confiée à une autre session en cours : ${label(task)}`);
      }
      if (task.execution.type !== 'llm')
        return error(reply, 409, `Une commande ne se rattache pas à une session : ${label(task)}`);
      if (epicRunner.reserved(task.id))
        return error(reply, 409, `Tâche réservée par un epic en cours : ${label(task)}`);
      if (all.some((t) => t.originTaskId === task.id))
        return error(reply, 409, `Tâche traitée dans un autre projet : ${label(task)}`);
      toClaim.push(task);
    }
    const claimed = db.transaction(() =>
      toClaim.map((task) => db.updateTask(task.id, { status: 'started', sessionId: session.id }) ?? task),
    );
    for (const task of claimed) broadcast({ type: 'task', task });
    return reply.send({
      claimed: claimed.map(({ id, text, epicId }) => ({ id, text, epicId })),
      already,
    });
  });

  // Rend au backlog des tâches rattachées par erreur : de nouveau à faire, plus confiées à la session.
  app.post<{ Params: { id: string } }>('/api/backlog/:id/release', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const session = checked.value;
    const mine = (t: Task): boolean => t.status === 'started' && t.sessionId === session.id;
    const resolved = resolve(session.projectId, request.body, (_epic, members) => members.filter(mine));
    if (!resolved.ok) return error(reply, resolved.status, resolved.message);
    const foreign = resolved.tasks.find((t) => resolved.explicit.has(t.id) && !mine(t));
    if (foreign) return error(reply, 409, `Tâche non rattachée à cette session : ${label(foreign)}`);
    const released = db.transaction(() =>
      resolved.tasks.map((task) => db.updateTask(task.id, { status: 'todo', sessionId: null }) ?? task),
    );
    for (const task of released) broadcast({ type: 'task', task });
    return reply.send({ released: released.map(({ id, text }) => ({ id, text })) });
  });
}
