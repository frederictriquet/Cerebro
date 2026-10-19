import { loadRemotes, MACHINE_NAME, type RemoteMachine } from './config.ts';
import type { CerebroDatabase, Epic, Project, Session, Task } from './db.ts';
import { parseEpicList, parseProjectList, parseSessionList, parseTaskList } from '../web/src/types.ts';

export interface MachineData {
  machine: string;
  projects: Project[];
  sessions: Session[];
  tasks: Task[];
  epics: Epic[];
}
export type MachineState = { ok: true; data: MachineData } | { ok: false; machine: string; error: string };
async function fetchRemote<T>(remote: RemoteMachine, path: string, parse: (data: unknown) => T[]): Promise<T[]> {
  const url = new URL(remote.url);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  const response = await fetch(url, {
    headers: remote.token === undefined ? {} : { authorization: `Bearer ${remote.token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} sur ${path}`);
  const raw: unknown = await response.json();
  const parsed = parse(raw);
  if (!Array.isArray(raw) || raw.length !== parsed.length) throw new Error(`Données invalides sur ${path}`);
  return parsed;
}

/** Shared, complete state collection; no inference, no recent-session truncation. */
export async function collectMachines(db: CerebroDatabase): Promise<MachineState[]> {
  const local: MachineState = { ok: true, data: {
    machine: MACHINE_NAME, projects: db.listProjects(), sessions: db.listSessions(), tasks: db.listTasks(), epics: db.listEpics(),
  } };
  const remotes = await Promise.all(loadRemotes().map(async (remote): Promise<MachineState> => {
    try {
      const [projects, sessions, tasks, epics] = await Promise.all([
        fetchRemote(remote, '/api/projects', parseProjectList), fetchRemote(remote, '/api/sessions', parseSessionList),
        fetchRemote(remote, '/api/tasks', parseTaskList), fetchRemote(remote, '/api/epics', parseEpicList),
      ]);
      return { ok: true, data: { machine: remote.name, projects, sessions, tasks, epics } };
    } catch (cause) {
      return { ok: false, machine: remote.name, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }));
  return [local, ...remotes];
}
