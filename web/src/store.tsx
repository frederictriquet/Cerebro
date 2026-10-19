import type { EpicRun } from '../../server/epic-runner.ts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, wsUrl } from './api.ts';
import { isDormant } from './format.ts';
import {
  armNotificationPermission,
  playAlert,
  readDesktopNotif,
  readMuted,
  showAlertNotification,
  updateAttentionIndicators,
  writeDesktopNotif,
  writeMuted,
} from './notify.ts';
import {
  parseAgentInfoList,
  parseEpic,
  parseEpicList,
  parseEventsMessage,
  parseProject,
  parseProjectList,
  parseSession,
  parseSessionList,
  parseTask,
  parseTaskList,
  type AgentInfo,
  type Epic,
  type LaunchSpec,
  type Project,
  type Session,
  type Task,
  type TaskStatus,
} from './types.ts';

export interface Store {
  projects: Project[];
  sessions: Session[];
  tasks: Task[];
  epics: Epic[];
  agents: AgentInfo[];
  connected: boolean;
  // Incrémenté à chaque changement de prise de main Slack entre machines : déclenche un rechargement.
  peersVersion: number;
  muted: boolean;
  setMuted: (value: boolean) => void;
  desktopNotif: boolean;
  setDesktopNotif: (value: boolean) => void;
  createProject: (name: string, path: string) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  createSession: (projectId: string, spec: LaunchSpec) => Promise<Session>;
  killSession: (id: string) => Promise<void>;
  resumeSession: (id: string) => Promise<Session>;
  deleteSession: (id: string) => Promise<void>;
  purgeProjectSessions: (projectId: string) => Promise<void>;
  markSeen: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<Session>;
  updateProject: (id: string, patch: ProjectPatch) => Promise<Project>;
  sendSessionInput: (id: string, data: string) => Promise<void>;
  createTask: (projectId: string, text: string, sourceSessionId?: string, epicId?: string | null) => Promise<Task>;
  updateTask: (id: string, patch: TaskPatch) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  startTask: (id: string, spec: LaunchSpec) => Promise<Session>;
  createEpic: (projectId: string, title: string, description?: string) => Promise<Epic>;
  updateEpic: (id: string, patch: { title?: string; description?: string }) => Promise<Epic>;
  deleteEpic: (id: string) => Promise<void>;
  startEpic: (id: string, spec: LaunchSpec) => Promise<EpicRun>;
}

export interface TaskPatch {
  text?: string;
  status?: TaskStatus;
  dependsOn?: string[];
  epicId?: string | null;
}

export interface ProjectPatch {
  name?: string;
  path?: string;
  color?: string | null;
  sessionDefaults?: Partial<LaunchSpec>;
  commitSettings?: Partial<import('./types.ts').CommitSettings>;
}

const StoreContext = createContext<Store | null>(null);

// L'activité (statut, titre, attention) ne déplace pas une session.
function sortSessions(list: Session[]): Session[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

function upsertTask(list: Task[], task: Task): Task[] {
  const i = list.findIndex((t) => t.id === task.id);
  if (i === -1) return [...list, task];
  const next = list.slice();
  next[i] = task;
  return next;
}

function upsertEpic(list: Epic[], epic: Epic): Epic[] {
  const i = list.findIndex((e) => e.id === epic.id);
  if (i === -1) return [...list, epic];
  const next = list.slice();
  next[i] = epic;
  return next;
}

function upsertSession(list: Session[], session: Session): Session[] {
  const i = list.findIndex((s) => s.id === session.id);
  if (i === -1) return sortSessions([session, ...list]);
  const next = list.slice();
  next[i] = session;
  return sortSessions(next);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [connected, setConnected] = useState(false);
  const [peersVersion, setPeersVersion] = useState(0);
  const [muted, setMutedState] = useState<boolean>(() => readMuted());
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const setMuted = useCallback((value: boolean) => {
    mutedRef.current = value;
    setMutedState(value);
    writeMuted(value);
  }, []);

  const [desktopNotif, setDesktopNotifState] = useState<boolean>(() => readDesktopNotif());

  const setDesktopNotif = useCallback((value: boolean) => {
    setDesktopNotifState(value);
    writeDesktopNotif(value);
  }, []);

  useEffect(() => {
    armNotificationPermission();
  }, []);

  useEffect(() => {
    const awaiting = sessions.filter((s) => s.attention);
    const waiting = awaiting.filter((s) => s.status === 'waiting').length;
    updateAttentionIndicators(waiting, awaiting.length - waiting);
  }, [sessions]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [pRaw, sRaw, tRaw, aRaw, eRaw] = await Promise.all([
          api<unknown>('/api/projects'),
          api<unknown>('/api/sessions'),
          api<unknown>('/api/tasks'),
          api<unknown>('/api/agents'),
          // Serveur antérieur aux epics (machine distante) : aucun.
          api<unknown>('/api/epics').catch(() => []),
        ]);
        if (cancelled) return;
        setProjects(parseProjectList(pRaw));
        setSessions(sortSessions(parseSessionList(sRaw)));
        setTasks(parseTaskList(tRaw));
        setEpics(parseEpicList(eRaw));
        setAgents(parseAgentInfoList(aRaw));
      } catch {
        /* le snapshot WS prendra le relais */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = (): void => {
      if (closed) return;
      const socket = new WebSocket(wsUrl('/ws/events'));
      ws = socket;
      socket.addEventListener('open', () => {
        retry = 0;
        setConnected(true);
      });
      socket.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return;
        let raw: unknown;
        try {
          raw = JSON.parse(ev.data) as unknown;
        } catch {
          return;
        }
        const msg = parseEventsMessage(raw);
        if (!msg) return;
        switch (msg.type) {
          case 'snapshot':
            setProjects(msg.projects);
            setSessions(sortSessions(msg.sessions));
            setTasks(msg.tasks);
            setEpics(msg.epics);
            break;
          case 'session':
            setSessions((list) => upsertSession(list, msg.session));
            break;
          case 'session-deleted':
            setSessions((list) => list.filter((s) => s.id !== msg.id));
            // La base délie la tâche (ON DELETE SET NULL) sans émettre d'événement.
            setTasks((list) => list.map((t) => (t.sessionId === msg.id ? { ...t, sessionId: null } : t)));
            break;
          case 'task':
            setTasks((list) => upsertTask(list, msg.task));
            break;
          case 'task-deleted':
            setTasks((list) => list.filter((t) => t.id !== msg.id));
            break;
          case 'epic':
            setEpics((list) => upsertEpic(list, msg.epic));
            break;
          case 'epic-deleted':
            setEpics((list) => list.filter((e) => e.id !== msg.id));
            break;
          case 'projects':
            setProjects(msg.projects);
            break;
          case 'peers':
            setPeersVersion((n) => n + 1);
            break;
          case 'alert':
            setSessions((list) => upsertSession(list, msg.session));
            showAlertNotification(msg.session);
            if (!mutedRef.current) playAlert(msg.session.status);
            break;
        }
      });
      socket.addEventListener('close', () => {
        setConnected(false);
        if (closed) return;
        const delay = Math.min(8_000, 400 * 2 ** retry);
        retry += 1;
        timer = setTimeout(connect, delay);
      });
      socket.addEventListener('error', () => {
        socket.close();
      });
    };

    connect();
    return () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      ws?.close();
    };
  }, []);

  const createProject = useCallback(async (name: string, path: string): Promise<Project> => {
    const raw = await api<unknown>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, path }),
    });
    const project = parseProject(raw);
    if (!project) throw new Error('Réponse projet invalide');
    setProjects((list) => (list.some((p) => p.id === project.id) ? list : [...list, project]));
    return project;
  }, []);

  const deleteProject = useCallback(async (id: string): Promise<void> => {
    await api<unknown>(`/api/projects/${id}`, { method: 'DELETE' });
    setProjects((list) => list.filter((p) => p.id !== id));
    setSessions((list) => list.filter((s) => s.projectId !== id));
    setTasks((list) => list.filter((t) => t.projectId !== id));
    setEpics((list) => list.filter((e) => e.projectId !== id));
  }, []);

  const createSession = useCallback(
    async (projectId: string, spec: LaunchSpec): Promise<Session> => {
      const raw = await api<unknown>(`/api/projects/${projectId}/sessions`, {
        method: 'POST',
        body: JSON.stringify(spec),
      });
      const session = parseSession(raw);
      if (!session) throw new Error('Réponse session invalide');
      setSessions((list) => upsertSession(list, session));
      return session;
    },
    [],
  );

  const killSession = useCallback(async (id: string): Promise<void> => {
    await api<unknown>(`/api/sessions/${id}/kill`, { method: 'POST' });
  }, []);

  const resumeSession = useCallback(async (id: string): Promise<Session> => {
    const raw = await api<unknown>(`/api/sessions/${id}/resume`, { method: 'POST' });
    const session = parseSession(raw);
    if (!session) throw new Error('Réponse session invalide');
    setSessions((list) => upsertSession(list, session));
    return session;
  }, []);

  const deleteSession = useCallback(async (id: string): Promise<void> => {
    await api<unknown>(`/api/sessions/${id}`, { method: 'DELETE' });
    setSessions((list) => list.filter((s) => s.id !== id));
  }, []);

  const purgeProjectSessions = useCallback(async (projectId: string): Promise<void> => {
    await api<unknown>(`/api/projects/${projectId}/purge`, { method: 'POST' });
    const now = Date.now();
    setSessions((list) => list.filter((s) => s.projectId !== projectId || !isDormant(s, now)));
  }, []);

  const renameSession = useCallback(async (id: string, title: string): Promise<Session> => {
    const raw = await api<unknown>(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
    const session = parseSession(raw);
    if (!session) throw new Error('Réponse session invalide');
    setSessions((list) => upsertSession(list, session));
    return session;
  }, []);

  const updateProject = useCallback(
    async (id: string, patch: ProjectPatch): Promise<Project> => {
      const raw = await api<unknown>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      const project = parseProject(raw);
      if (!project) throw new Error('Réponse projet invalide');
      setProjects((list) => list.map((item) => (item.id === project.id ? project : item)));
      return project;
    },
    [],
  );

  const sendSessionInput = useCallback(async (id: string, data: string): Promise<void> => {
    await api<unknown>(`/api/sessions/${id}/input`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  }, []);

  const createTask = useCallback(
    async (projectId: string, text: string, sourceSessionId?: string, epicId?: string | null): Promise<Task> => {
      const raw = await api<unknown>(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ text, sourceSessionId, epicId: epicId ?? null }),
      });
      const task = parseTask(raw);
      if (!task) throw new Error('Réponse tâche invalide');
      setTasks((list) => upsertTask(list, task));
      return task;
    },
    [],
  );

  const updateTask = useCallback(
    async (id: string, patch: TaskPatch): Promise<Task> => {
      const raw = await api<unknown>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      const task = parseTask(raw);
      if (!task) throw new Error('Réponse tâche invalide');
      setTasks((list) => upsertTask(list, task));
      return task;
    },
    [],
  );

  const deleteTask = useCallback(async (id: string): Promise<void> => {
    await api<unknown>(`/api/tasks/${id}`, { method: 'DELETE' });
    setTasks((list) => list.filter((t) => t.id !== id).map((t) => (t.dependsOn.includes(id) ? { ...t, dependsOn: t.dependsOn.filter((d) => d !== id) } : t)));
  }, []);

  const startTask = useCallback(
    async (id: string, spec: LaunchSpec): Promise<Session> => {
      const raw = await api<{ task: unknown; session: unknown }>(`/api/tasks/${id}/start`, {
        method: 'POST',
        body: JSON.stringify(spec),
      });
      const session = parseSession(raw.session);
      if (!session) throw new Error('Réponse session invalide');
      const task = parseTask(raw.task);
      setSessions((list) => upsertSession(list, session));
      if (task) setTasks((list) => upsertTask(list, task));
      return session;
    },
    [],
  );

  const createEpic = useCallback(async (projectId: string, title: string, description?: string): Promise<Epic> => {
    const raw = await api<unknown>(`/api/projects/${projectId}/epics`, {
      method: 'POST',
      body: JSON.stringify({ title, description }),
    });
    const epic = parseEpic(raw);
    if (!epic) throw new Error('Réponse epic invalide');
    setEpics((list) => upsertEpic(list, epic));
    return epic;
  }, []);

  const updateEpic = useCallback(async (id: string, patch: { title?: string; description?: string }): Promise<Epic> => {
    const raw = await api<unknown>(`/api/epics/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    const epic = parseEpic(raw);
    if (!epic) throw new Error('Réponse epic invalide');
    setEpics((list) => upsertEpic(list, epic));
    return epic;
  }, []);

  const deleteEpic = useCallback(async (id: string): Promise<void> => {
    await api<unknown>(`/api/epics/${id}`, { method: 'DELETE' });
    setEpics((list) => list.filter((e) => e.id !== id));
    setTasks((list) => list.map((t) => (t.epicId === id ? { ...t, epicId: null } : t)));
  }, []);

  const startEpic = useCallback(async (id: string, spec: LaunchSpec): Promise<EpicRun> => {
    return api<EpicRun>(`/api/epics/${id}/start`, { method: 'POST', body: JSON.stringify(spec) });
  }, []);

  const markSeen = useCallback(async (id: string): Promise<void> => {
    setSessions((list) =>
      list.map((s) => (s.id === id ? { ...s, attention: false } : s)),
    );
    try {
      await api<unknown>(`/api/sessions/${id}/seen`, { method: 'POST' });
    } catch {
      /* le prochain snapshot corrigera */
    }
  }, []);

  const value = useMemo<Store>(
    () => ({
      projects,
      sessions,
      tasks,
      epics,
      agents,
      connected,
      peersVersion,
      muted,
      setMuted,
      desktopNotif,
      setDesktopNotif,
      createProject,
      deleteProject,
      createSession,
      killSession,
      resumeSession,
      deleteSession,
      purgeProjectSessions,
      markSeen,
      renameSession,
      updateProject,
      sendSessionInput,
      createTask,
      updateTask,
      deleteTask,
      startTask,
      createEpic,
      updateEpic,
      deleteEpic,
      startEpic,
    }),
    [
      projects,
      sessions,
      tasks,
      epics,
      agents,
      connected,
      peersVersion,
      muted,
      setMuted,
      desktopNotif,
      setDesktopNotif,
      createProject,
      deleteProject,
      createSession,
      killSession,
      resumeSession,
      deleteSession,
      purgeProjectSessions,
      markSeen,
      renameSession,
      updateProject,
      sendSessionInput,
      createTask,
      updateTask,
      deleteTask,
      startTask,
      createEpic,
      updateEpic,
      deleteEpic,
      startEpic,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('Store manquant');
  return ctx;
}
