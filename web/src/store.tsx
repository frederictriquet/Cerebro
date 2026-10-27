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
import { api, apiPath, fetchParsed, wsUrl } from './api.ts';
import { openReconnectingSocket } from './socket.ts';
import {
  armNotificationPermission,
  playAlert,
  readDesktopNotif,
  readMuted,
  showAlertNotification,
  showFindingsNotification,
  updateAttentionIndicators,
  writeDesktopNotif,
  writeMuted,
} from './notify.ts';
import { needsAttention } from './format.ts';
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
  refreshAgents: () => Promise<void>;
  connected: boolean;
  // Incrémenté à chaque changement de prise de main Slack entre machines : déclenche un rechargement.
  peersVersion: number;
  muted: boolean;
  setMuted: (value: boolean) => void;
  desktopNotif: boolean;
  setDesktopNotif: (value: boolean) => void;
  createProject: (name: string, path: string) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  reorderProjects: (ids: string[]) => Promise<void>;
  createSession: (projectId: string, spec: LaunchSpec) => Promise<Session>;
  killSession: (id: string) => Promise<void>;
  resumeSession: (id: string) => Promise<Session>;
  deleteSession: (id: string) => Promise<void>;
  setSessionProtected: (id: string, value: boolean) => Promise<void>;
  purgeProjectSessions: (projectId: string) => Promise<void>;
  markSeen: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<Session>;
  updateProject: (id: string, patch: ProjectPatch) => Promise<Project>;
  sendSessionInput: (id: string, data: string) => Promise<void>;
  createTask: (projectId: string, text: string, sourceSessionId?: string, epicId?: string | null) => Promise<Task>;
  updateTask: (id: string, patch: TaskPatch) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  deleteCompletedBacklog: (projectId: string) => Promise<void>;
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
  resolutionSettings?: Partial<import('./types.ts').ResolutionSettings>;
  workspaceMode?: import('./types.ts').WorkspaceMode;
  // null : le projet revient aux réglages globaux du council.
  councilSettings?: import('./types.ts').CouncilSettings | null;
}

const StoreContext = createContext<Store | null>(null);

// L'activité (statut, titre, attention) ne déplace pas une session.
function sortSessions(list: Session[]): Session[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

/** Remplace l'élément de même id, sinon l'ajoute en tête (start) ou en fin de liste. */
export function upsertById<T extends { id: string }>(list: readonly T[], item: T, insert: 'start' | 'end' = 'end'): T[] {
  const i = list.findIndex((existing) => existing.id === item.id);
  if (i === -1) return insert === 'start' ? [item, ...list] : [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function upsertSession(list: Session[], session: Session): Session[] {
  return sortSessions(upsertById(list, session, 'start'));
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
    const awaiting = sessions.filter(needsAttention);
    const waiting = awaiting.filter((s) => s.status === 'waiting').length;
    updateAttentionIndicators(waiting, awaiting.length - waiting, sessions.reduce((total, session) => total + session.pendingFindings, 0));
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
    const connection = openReconnectingSocket(wsUrl('/ws/events'), {
      onOpen: () => {
        setConnected(true);
      },
      onMessage: (raw) => {
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
            setTasks((list) => upsertById(list, msg.task));
            break;
          case 'task-deleted':
            setTasks((list) => list.filter((t) => t.id !== msg.id));
            break;
          case 'epic':
            setEpics((list) => upsertById(list, msg.epic));
            setSessions((list) => list.map((session) => session.epic?.id === msg.epic.id
              ? { ...session, epic: { id: msg.epic.id, title: msg.epic.title } } : session));
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
          case 'findings-available':
            setSessions((list) => upsertSession(list, msg.session));
            showFindingsNotification(msg.session);
            if (!mutedRef.current) playAlert('idle');
            break;
        }
      },
      onClose: () => {
        setConnected(false);
      },
    });
    return () => {
      connection.close();
    };
  }, []);

  const createProject = useCallback(async (name: string, path: string): Promise<Project> => {
    const project = await fetchParsed('/api/projects', parseProject, 'projet', {
      method: 'POST',
      body: JSON.stringify({ name, path }),
    });
    setProjects((list) => (list.some((p) => p.id === project.id) ? list : [...list, project]));
    return project;
  }, []);

  const deleteProject = useCallback(async (id: string): Promise<void> => {
    await api<unknown>(apiPath`/api/projects/${id}`, { method: 'DELETE' });
    setProjects((list) => list.filter((p) => p.id !== id));
    setSessions((list) => list.filter((s) => s.projectId !== id));
    setTasks((list) => list.filter((t) => t.projectId !== id));
    setEpics((list) => list.filter((e) => e.projectId !== id));
  }, []);

  const reorderProjects = useCallback(async (ids: string[]): Promise<void> => {
    const raw = await api<unknown>('/api/projects/order', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    });
    setProjects(parseProjectList(raw));
  }, []);

  const refreshAgents = useCallback(async (): Promise<void> => {
    setAgents(parseAgentInfoList(await api<unknown>('/api/agents?refresh=1')));
  }, []);

  const createSession = useCallback(
    async (projectId: string, spec: LaunchSpec): Promise<Session> => {
      const session = await fetchParsed(apiPath`/api/projects/${projectId}/sessions`, parseSession, 'session', {
        method: 'POST',
        body: JSON.stringify(spec),
      });
      setSessions((list) => upsertSession(list, session));
      return session;
    },
    [],
  );

  const killSession = useCallback(async (id: string): Promise<void> => {
    await api<unknown>(apiPath`/api/sessions/${id}/kill`, { method: 'POST' });
  }, []);

  const resumeSession = useCallback(async (id: string): Promise<Session> => {
    const session = await fetchParsed(apiPath`/api/sessions/${id}/resume`, parseSession, 'session', { method: 'POST' });
    setSessions((list) => upsertSession(list, session));
    return session;
  }, []);

  const deleteSession = useCallback(async (id: string): Promise<void> => {
    await api<unknown>(apiPath`/api/sessions/${id}`, { method: 'DELETE' });
    setSessions((list) => list.filter((s) => s.id !== id));
  }, []);

  const purgeProjectSessions = useCallback(async (projectId: string): Promise<void> => {
    await api<unknown>(apiPath`/api/projects/${projectId}/purge`, { method: 'POST' });
    const raw = await api<unknown>('/api/sessions');
    setSessions(sortSessions(parseSessionList(raw)));
  }, []);

  const setSessionProtected = useCallback(async (id: string, value: boolean): Promise<void> => {
    const session = await fetchParsed(apiPath`/api/sessions/${id}/protection`, parseSession, 'session', {
      method: 'PATCH',
      body: JSON.stringify({ protected: value }),
    });
    setSessions((list) => upsertSession(list, session));
  }, []);

  const renameSession = useCallback(async (id: string, title: string): Promise<Session> => {
    const session = await fetchParsed(apiPath`/api/sessions/${id}`, parseSession, 'session', {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
    setSessions((list) => upsertSession(list, session));
    return session;
  }, []);

  const updateProject = useCallback(
    async (id: string, patch: ProjectPatch): Promise<Project> => {
      const project = await fetchParsed(apiPath`/api/projects/${id}`, parseProject, 'projet', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setProjects((list) => list.map((item) => (item.id === project.id ? project : item)));
      return project;
    },
    [],
  );

  const sendSessionInput = useCallback(async (id: string, data: string): Promise<void> => {
    await api<unknown>(apiPath`/api/sessions/${id}/input`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  }, []);

  const createTask = useCallback(
    async (projectId: string, text: string, sourceSessionId?: string, epicId?: string | null): Promise<Task> => {
      const task = await fetchParsed(apiPath`/api/projects/${projectId}/tasks`, parseTask, 'tâche', {
        method: 'POST',
        body: JSON.stringify({ text, sourceSessionId, epicId: epicId ?? null }),
      });
      setTasks((list) => upsertById(list, task));
      return task;
    },
    [],
  );

  const updateTask = useCallback(
    async (id: string, patch: TaskPatch): Promise<Task> => {
      const task = await fetchParsed(apiPath`/api/tasks/${id}`, parseTask, 'tâche', { method: 'PATCH', body: JSON.stringify(patch) });
      setTasks((list) => upsertById(list, task));
      return task;
    },
    [],
  );

  const deleteTask = useCallback(async (id: string): Promise<void> => {
    await api<unknown>(apiPath`/api/tasks/${id}`, { method: 'DELETE' });
    setTasks((list) => list.filter((t) => t.id !== id).map((t) => (t.dependsOn.includes(id) ? { ...t, dependsOn: t.dependsOn.filter((d) => d !== id) } : t)));
  }, []);

  const deleteCompletedBacklog = useCallback(async (projectId: string): Promise<void> => {
    const { taskIds, epicIds } = await api<{ taskIds: string[]; epicIds: string[] }>(
      apiPath`/api/projects/${projectId}/backlog/completed`, { method: 'DELETE' },
    );
    const deletedTasks = new Set(taskIds);
    const deletedEpics = new Set(epicIds);
    setTasks((list) => list.filter((task) => !deletedTasks.has(task.id)).map((task) => ({
      ...task, dependsOn: task.dependsOn.filter((id) => !deletedTasks.has(id)),
    })));
    setEpics((list) => list.filter((epic) => !deletedEpics.has(epic.id)));
  }, []);

  const startTask = useCallback(
    async (id: string, spec: LaunchSpec): Promise<Session> => {
      const raw = await api<{ task: unknown; session: unknown }>(apiPath`/api/tasks/${id}/start`, {
        method: 'POST',
        body: JSON.stringify(spec),
      });
      const session = parseSession(raw.session);
      if (!session) throw new Error('Réponse du serveur invalide (session)');
      const task = parseTask(raw.task);
      setSessions((list) => upsertSession(list, session));
      if (task) setTasks((list) => upsertById(list, task));
      return session;
    },
    [],
  );

  const createEpic = useCallback(async (projectId: string, title: string, description?: string): Promise<Epic> => {
    const epic = await fetchParsed(apiPath`/api/projects/${projectId}/epics`, parseEpic, 'epic', {
      method: 'POST',
      body: JSON.stringify({ title, description }),
    });
    setEpics((list) => upsertById(list, epic));
    return epic;
  }, []);

  const updateEpic = useCallback(async (id: string, patch: { title?: string; description?: string }): Promise<Epic> => {
    const epic = await fetchParsed(apiPath`/api/epics/${id}`, parseEpic, 'epic', { method: 'PATCH', body: JSON.stringify(patch) });
    setEpics((list) => upsertById(list, epic));
    setSessions((list) => list.map((session) => session.epic?.id === epic.id
      ? { ...session, epic: { id: epic.id, title: epic.title } } : session));
    return epic;
  }, []);

  const deleteEpic = useCallback(async (id: string): Promise<void> => {
    await api<unknown>(apiPath`/api/epics/${id}`, { method: 'DELETE' });
    setEpics((list) => list.filter((e) => e.id !== id));
    setTasks((list) => list.map((t) => (t.epicId === id ? { ...t, epicId: null } : t)));
  }, []);

  const startEpic = useCallback(async (id: string, spec: LaunchSpec): Promise<EpicRun> => {
    return api<EpicRun>(apiPath`/api/epics/${id}/start`, { method: 'POST', body: JSON.stringify(spec) });
  }, []);

  const markSeen = useCallback(async (id: string): Promise<void> => {
    setSessions((list) =>
      list.map((s) => (s.id === id ? { ...s, attention: false } : s)),
    );
    try {
      await api<unknown>(apiPath`/api/sessions/${id}/seen`, { method: 'POST' });
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
      refreshAgents,
      connected,
      peersVersion,
      muted,
      setMuted,
      desktopNotif,
      setDesktopNotif,
      createProject,
      deleteProject,
      reorderProjects,
      createSession,
      killSession,
      resumeSession,
      deleteSession,
      setSessionProtected,
      purgeProjectSessions,
      markSeen,
      renameSession,
      updateProject,
      sendSessionInput,
      createTask,
      updateTask,
      deleteTask,
      deleteCompletedBacklog,
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
      refreshAgents,
      connected,
      peersVersion,
      muted,
      setMuted,
      desktopNotif,
      setDesktopNotif,
      createProject,
      deleteProject,
      reorderProjects,
      createSession,
      killSession,
      resumeSession,
      deleteSession,
      setSessionProtected,
      purgeProjectSessions,
      markSeen,
      renameSession,
      updateProject,
      sendSessionInput,
      createTask,
      updateTask,
      deleteTask,
      deleteCompletedBacklog,
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
