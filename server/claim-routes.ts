import { isActiveRun } from '../shared/backlog.ts';
import type { Epic, Session, Task } from '../shared/types.ts';
import { asRecord } from './util.ts';
import { error } from './routes-util.ts';
import { typeIntoSession } from './session-input.ts';
import { insertSessionTask } from './session-tasks.ts';
import type { RouteContext } from './route-context.ts';

const MAX_CLAIMED = 100;

// Rattachement : une session s'approprie des tâches (ou les tâches ouvertes d'un epic) qui existent déjà dans le
// backlog de son projet, par exemple parce que l'utilisateur a commencé à les traiter sans passer par « Traiter ».
// Elles prennent l'état d'une tâche lancée depuis le backlog : démarrées, confiées à cette session, que
// `cerebro-backlog --done <id>` peut ensuite clore. Tout ou rien : une tâche refusée n'en rattache aucune.
export function registerClaimRoutes(ctx: RouteContext): void {
  const { app, db, sessions, epicRunner, broadcast, tokenSession, requireSession } = ctx;

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

  type Claimed = { ok: true; claimed: Task[]; already: string[] } | { ok: false; status: number; message: string };
  const refuse = (message: string): Claimed => ({ ok: false, status: 409, message });
  const claim = (session: Session, body: unknown): Claimed => {
    const resolved = resolve(session.projectId, body, (_epic, members) => members.filter((t) => t.status !== 'done'));
    if (!resolved.ok) return resolved;
    const all = db.listTasks();
    const already: string[] = [];
    const toClaim: Task[] = [];
    for (const task of resolved.tasks) {
      if (task.status === 'done') return refuse(`Tâche déjà terminée : ${label(task)}`);
      if (task.status === 'started' && task.sessionId === session.id) {
        already.push(task.id);
        continue;
      }
      if (task.status === 'started') {
        // Une session arrêtée ou supprimée ne retient plus la tâche (comme « Relancer » depuis le backlog).
        const holder = task.sessionId === null ? null : db.getSession(task.sessionId);
        if (holder !== null && holder.status !== 'exited')
          return refuse(`Tâche déjà confiée à une autre session en cours : ${label(task)}`);
      }
      if (task.execution.type !== 'llm')
        return refuse(`Une commande ne se rattache pas à une session : ${label(task)}`);
      if (epicRunner.reserved(task.id)) return refuse(`Tâche réservée par un epic en cours : ${label(task)}`);
      if (all.some((t) => t.originTaskId === task.id))
        return refuse(`Tâche traitée dans un autre projet : ${label(task)}`);
      toClaim.push(task);
    }
    const claimed = db.transaction(() =>
      toClaim.map((task) => db.updateTask(task.id, { status: 'started', sessionId: session.id }) ?? task),
    );
    for (const task of claimed) broadcast({ type: 'task', task });
    return { ok: true, claimed, already };
  };
  const summary = (claimed: Task[]) => claimed.map(({ id, text, epicId }) => ({ id, text, epicId }));

  // Depuis l'agent : `cerebro-backlog --claim`, authentifié par le jeton de la session.
  app.post<{ Params: { id: string } }>('/api/backlog/:id/claim', async (request, reply) => {
    const checked = tokenSession(request, reply);
    if (!checked.ok) return checked.reply;
    const result = claim(checked.value, request.body);
    if (!result.ok) return error(reply, result.status, result.message);
    return reply.send({ claimed: summary(result.claimed), already: result.already });
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

  // Depuis l'interface : boutons « Rattacher » du backlog et de la vue session. L'agent l'ignorerait : chaque
  // tâche devient une sous-tâche de la session (rappel qui survit à une compaction) et un message tapé dans
  // son terminal lui en donne le texte. Une session arrêtée ne reprendrait pas la tâche (« Traiter » ou
  // « Relancer » s'en chargent) ; une session qui attend une réponse ou une autorisation recevrait le message
  // dans son dialogue, où Entrée validerait le choix affiché.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/claim', async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    if (session.status === 'exited')
      return error(reply, 409, 'Session arrêtée : reprenez-la avant de lui confier une tâche');
    if (session.status === 'waiting')
      return error(
        reply,
        409,
        'La session attend votre réponse ou une autorisation : traitez-la avant de lui confier une tâche',
      );
    const result = claim(session, request.body);
    if (!result.ok) return error(reply, result.status, result.message);
    let notified = true;
    for (const task of result.claimed) {
      insertSessionTask(db, session.id, {
        title: taskTitle(task.text).slice(0, 500),
        note: `Tâche du backlog ${task.id} : à clore avec cerebro-backlog --done ${task.id} une fois terminée et vérifiée.`,
      });
      notified = (await typeIntoSession(sessions, session.id, claimMessage(task))) && notified;
    }
    return reply.send({ claimed: summary(result.claimed), already: result.already, notified });
  });
}

function taskTitle(text: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? text.trim()
  );
}

// Tapé dans le terminal : une seule ligne, un retour à la ligne enverrait le message en plusieurs morceaux.
export function claimMessage(task: Pick<Task, 'id' | 'text'>): string {
  const text = task.text.trim().replace(/\s*\n+\s*/g, ' · ');
  return (
    `[Cerebro] Tâche du backlog confiée à cette session (id ${task.id}) : « ${text} ». ` +
    `Traite-la après ton travail en cours, puis clos-la avec cerebro-backlog --done ${task.id} une fois ` +
    'terminée et vérifiée. Elle figure aussi dans tes sous-tâches.'
  );
}
