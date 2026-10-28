import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLatest } from './use-latest.ts';
import { api, apiParsed, apiPath, wsUrl } from './api.ts';
import {
  armNotificationPermission,
  playAlert,
  readDesktopNotif,
  readMuted,
  sessionIsWatched,
  showAlertNotification,
  showFindingsNotification,
  updateAttentionIndicators,
  writeDesktopNotif,
  writeMuted,
} from './notify.ts';
import { attentionCounts, errorMessage } from './format.ts';
import { openReconnectingSocket } from './reconnectingSocket.ts';
import {
  parseAgentInfoList,
  parseEpic,
  parseEventsMessage,
  parseProject,
  parseProjectList,
  parseSession,
  parseSessionList,
  parseTask,
  parseTaskList,
  type AgentInfo,
  type Epic,
  type EventsMessage,
  type SessionDefaults,
  type Project,
  type Session,
  type Task,
  type TaskExecution,
  type TaskStatus,
} from '../../shared/types.ts';
import { parseCompletedBacklogDeletion, parseEpicRun, type EpicRun } from '../../shared/backlog.ts';
import { isRecord } from '../../shared/parse.ts';

export interface Store {
  projects: Project[];
  sessions: Session[];
  tasks: Task[];
  epics: Epic[];
  agents: AgentInfo[];
  refreshAgents: () => Promise<void>;
  agentsRefreshing: boolean;
  agentsRefreshError: string | null;
  // Abonne un sélecteur : tant qu'il en reste un et qu'aucun agent n'est disponible,
  // une boucle unique relance refreshAgents toutes les 5 s. Retourne le désabonnement.
  watchAgents: () => () => void;
  connected: boolean;
  // Intervalle de relecture des runs d'epic et de commande : null tant que la connexion courante diffuse
  // leurs événements (ou que son snapshot n'est pas arrivé), RUN_FALLBACK_POLL_MS face à une instance antérieure.
  runPollMs: number | null;
  // Incrémenté à chaque changement de prise de main Slack entre machines : déclenche un rechargement.
  peersVersion: number;
  muted: boolean;
  setMuted: (value: boolean) => void;
  desktopNotif: boolean;
  setDesktopNotif: (value: boolean) => void;
  createProject: (name: string, path: string) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  reorderProjects: (ids: string[]) => Promise<void>;
  createSession: (projectId: string, spec: SessionDefaults) => Promise<Session>;
  killSession: (id: string) => Promise<void>;
  resumeSession: (id: string) => Promise<Session>;
  deleteSession: (id: string) => Promise<void>;
  setSessionProtected: (id: string, value: boolean) => Promise<void>;
  purgeProjectSessions: (projectId: string) => Promise<void>;
  /** Supprime les sessions non protégées d'un epic. */
  deleteEpicSessions: (epicId: string) => Promise<void>;
  markSeen: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<Session>;
  updateProject: (id: string, patch: ProjectPatch) => Promise<Project>;
  sendSessionInput: (id: string, data: string) => Promise<void>;
  createTask: (projectId: string, text: string, options?: NewTaskOptions) => Promise<Task>;
  updateTask: (id: string, patch: TaskPatch) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  deleteCompletedBacklog: (projectId: string) => Promise<void>;
  startTask: (id: string, spec: SessionDefaults) => Promise<Session>;
  /** Lance une tâche « commande » : aucune session, le serveur démarre la commande configurée. */
  startCommandTask: (id: string) => Promise<void>;
  createEpic: (projectId: string, title: string, description?: string) => Promise<Epic>;
  updateEpic: (id: string, patch: { title?: string; description?: string }) => Promise<Epic>;
  deleteEpic: (id: string) => Promise<void>;
  /** Sans `spec`, l'epic ne compte que des tâches « commande » : aucun réglage de session. */
  startEpic: (id: string, spec?: SessionDefaults) => Promise<EpicRun>;
  addEpicReviewTask: (epicId: string) => Promise<Task>;
  startEpicReview: (epicId: string, spec: SessionDefaults) => Promise<Session>;
  importFindings: (sessionId: string, reportId: string, selected: string[], epicId: string | null) => Promise<void>;
}

export interface NewTaskOptions {
  sourceSessionId?: string;
  epicId?: string | null;
  execution?: TaskExecution;
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
  sessionDefaults?: Partial<SessionDefaults>;
  commitSettings?: Partial<import('../../shared/types.ts').CommitSettings>;
  resolutionSettings?: Partial<import('../../shared/types.ts').ResolutionSettings>;
  workspaceMode?: import('../../shared/types.ts').WorkspaceMode;
  regenerablePaths?: string[];
  // null : le projet revient aux réglages globaux du council.
  councilSettings?: import('../../shared/types.ts').CouncilSettings | null;
}

const StoreContext = createContext<Store | null>(null);

export type RunEvent = Extract<EventsMessage, { type: 'epic-run' | 'command-run' }>;
const runListeners = new Set<(event: RunEvent) => void>();

// Polling de secours des runs face à une machine de même majeure antérieure à leurs événements.
const RUN_FALLBACK_POLL_MS = 5000;

// Avancement des runs d'epic et de commande, diffusé par /ws/events : remplace leur polling (sauf runPollMs).
// Les événements manqués pendant une déconnexion se rattrapent en rechargeant quand `connected` repasse à vrai.
export function useRunEvents(listener: (event: RunEvent) => void): void {
  const current = useLatest(listener);
  useEffect(() => {
    const forward = (event: RunEvent): void => current.current(event);
    runListeners.add(forward);
    return () => {
      runListeners.delete(forward);
    };
  }, [current]);
}

// L'activité (statut, titre, attention) ne déplace pas une session.
function sortSessions(list: Session[]): Session[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

/** Remplace l'élément de même id, sinon l'ajoute en tête (start) ou en fin de liste. */
export function upsertById<T extends { id: string }>(
  list: readonly T[],
  item: T,
  insert: 'start' | 'end' = 'end',
): T[] {
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
  // null : snapshot de la connexion courante pas encore reçu.
  const [runEvents, setRunEvents] = useState<boolean | null>(null);
  const [peersVersion, setPeersVersion] = useState(0);
  const [muted, setMutedState] = useState<boolean>(() => readMuted());
  const mutedRef = useLatest(muted);

  const setMuted = useCallback(
    (value: boolean) => {
      mutedRef.current = value;
      setMutedState(value);
      writeMuted(value);
    },
    [mutedRef],
  );

  const [desktopNotif, setDesktopNotifState] = useState<boolean>(() => readDesktopNotif());

  const setDesktopNotif = useCallback((value: boolean) => {
    setDesktopNotifState(value);
    writeDesktopNotif(value);
  }, []);

  useEffect(() => armNotificationPermission(), []);

  useEffect(() => {
    const { total, waiting, pendingFindings } = attentionCounts(sessions);
    updateAttentionIndicators(waiting, total - waiting, pendingFindings);
  }, [sessions]);

  // Projets, sessions, tâches et epics arrivent par le snapshot que le serveur
  // envoie à l'ouverture de /ws/events : un chargement REST concurrent pourrait
  // écraser un état plus récent. Seuls les agents, absents du snapshot, passent par REST.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await api('/api/agents');
        if (!cancelled) setAgents(parseAgentInfoList(raw));
      } catch (error) {
        // Liste d'agents vide : refreshAgents permet de réessayer.
        console.warn('[store] chargement des agents impossible :', errorMessage(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const markSeen = useCallback(async (id: string): Promise<void> => {
    setSessions((list) => list.map((s) => (s.id === id ? { ...s, attention: false } : s)));
    try {
      await api(apiPath`/api/sessions/${id}/seen`, { method: 'POST' });
    } catch {
      /* le prochain snapshot corrigera */
    }
  }, []);

  useEffect(() => {
    const socket = openReconnectingSocket(wsUrl('/ws/events'), {
      onOpen: () => {
        setRunEvents(null);
        setConnected(true);
      },
      onMessage: (raw) => {
        const msg = parseEventsMessage(raw);
        if (!msg) return;
        // Le serveur diffuse aussi les éléments modifiés par les cascades de la base
        // (dépendances, epic, session) : ni ce flux ni les actions locales ne les recopient.
        switch (msg.type) {
          case 'snapshot':
            setProjects(msg.projects);
            setSessions(sortSessions(msg.sessions));
            setTasks(msg.tasks);
            setEpics(msg.epics);
            setRunEvents(msg.runEvents);
            break;
          case 'session':
            setSessions((list) => upsertSession(list, msg.session));
            break;
          case 'session-deleted':
            setSessions((list) => list.filter((s) => s.id !== msg.id));
            break;
          case 'task':
            setTasks((list) => upsertById(list, msg.task));
            break;
          case 'task-deleted':
            setTasks((list) => list.filter((t) => t.id !== msg.id));
            break;
          case 'epic':
            setEpics((list) => upsertById(list, msg.epic));
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
            // Session réellement regardée (affichée et fenêtre focalisée) : l'alerte est vue. Sinon
            // l'attention reste posée pour « À traiter » et l'alerte Slack différée.
            if (sessionIsWatched(msg.session.id)) void markSeen(msg.session.id);
            showAlertNotification(msg.session);
            if (!mutedRef.current) playAlert(msg.session.status);
            break;
          case 'findings-available':
            setSessions((list) => upsertSession(list, msg.session));
            showFindingsNotification(msg.session);
            if (!mutedRef.current) playAlert('idle');
            break;
          case 'epic-run':
          case 'command-run':
            setRunEvents(true);
            for (const listener of runListeners) listener(msg);
            break;
        }
      },
      onClose: () => {
        setRunEvents(null);
        setConnected(false);
      },
    });
    return () => {
      socket.close();
    };
  }, [markSeen, mutedRef]);

  const createProject = useCallback(async (name: string, path: string): Promise<Project> => {
    const project = await apiParsed('/api/projects', parseProject, {
      method: 'POST',
      body: JSON.stringify({ name, path }),
    });
    setProjects((list) => (list.some((p) => p.id === project.id) ? list : [...list, project]));
    return project;
  }, []);

  const deleteProject = useCallback(async (id: string): Promise<void> => {
    await api(apiPath`/api/projects/${id}`, { method: 'DELETE' });
    setProjects((list) => list.filter((p) => p.id !== id));
  }, []);

  const reorderProjects = useCallback(async (ids: string[]): Promise<void> => {
    const raw = await api('/api/projects/order', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    });
    setProjects(parseProjectList(raw));
  }, []);

  const [agentsRefreshing, setAgentsRefreshing] = useState(false);
  const [agentsRefreshError, setAgentsRefreshError] = useState<string | null>(null);
  // Rafraîchissement en cours : les appels concurrents le partagent au lieu d'en lancer un autre.
  const agentsRefreshRef = useRef<Promise<void> | null>(null);
  const refreshAgents = useCallback((): Promise<void> => {
    if (agentsRefreshRef.current) return agentsRefreshRef.current;
    setAgentsRefreshing(true);
    setAgentsRefreshError(null);
    const run = (async () => {
      try {
        setAgents(parseAgentInfoList(await api('/api/agents?refresh=1')));
      } catch (error) {
        setAgentsRefreshError(errorMessage(error));
        throw error;
      } finally {
        agentsRefreshRef.current = null;
        setAgentsRefreshing(false);
      }
    })();
    agentsRefreshRef.current = run;
    return run;
  }, []);

  const [agentWatchers, setAgentWatchers] = useState(0);
  const watchAgents = useCallback(() => {
    setAgentWatchers((n) => n + 1);
    return () => setAgentWatchers((n) => n - 1);
  }, []);
  const watchingAgents = agentWatchers > 0;
  const agentsAvailable = agents.some((a) => a.available);
  useEffect(() => {
    if (!watchingAgents || agentsAvailable || agentsRefreshing) return;
    const timer = window.setTimeout(() => void refreshAgents().catch(() => {}), 5000);
    return () => window.clearTimeout(timer);
  }, [watchingAgents, agentsAvailable, agentsRefreshing, refreshAgents]);

  const createSession = useCallback(async (projectId: string, spec: SessionDefaults): Promise<Session> => {
    const session = await apiParsed(apiPath`/api/projects/${projectId}/sessions`, parseSession, {
      method: 'POST',
      body: JSON.stringify(spec),
    });
    setSessions((list) => upsertSession(list, session));
    return session;
  }, []);

  const killSession = useCallback(async (id: string): Promise<void> => {
    await api(apiPath`/api/sessions/${id}/kill`, { method: 'POST' });
  }, []);

  const resumeSession = useCallback(async (id: string): Promise<Session> => {
    const session = await apiParsed(apiPath`/api/sessions/${id}/resume`, parseSession, { method: 'POST' });
    setSessions((list) => upsertSession(list, session));
    return session;
  }, []);

  const deleteSession = useCallback(async (id: string): Promise<void> => {
    await api(apiPath`/api/sessions/${id}`, { method: 'DELETE' });
    setSessions((list) => list.filter((s) => s.id !== id));
  }, []);

  const purgeProjectSessions = useCallback(async (projectId: string): Promise<void> => {
    await api(apiPath`/api/projects/${projectId}/purge`, { method: 'POST' });
    const raw = await api('/api/sessions');
    setSessions(sortSessions(parseSessionList(raw)));
  }, []);

  const deleteEpicSessions = useCallback(async (epicId: string): Promise<void> => {
    try {
      await api(apiPath`/api/epics/${epicId}/sessions`, { method: 'DELETE' });
    } finally {
      // Même après un échec partiel : les sessions déjà supprimées disparaissent de la liste.
      const raw = await api('/api/sessions');
      setSessions(sortSessions(parseSessionList(raw)));
    }
  }, []);

  const setSessionProtected = useCallback(async (id: string, value: boolean): Promise<void> => {
    const session = await apiParsed(apiPath`/api/sessions/${id}/protection`, parseSession, {
      method: 'PATCH',
      body: JSON.stringify({ protected: value }),
    });
    setSessions((list) => upsertSession(list, session));
  }, []);

  const renameSession = useCallback(async (id: string, title: string): Promise<Session> => {
    const session = await apiParsed(apiPath`/api/sessions/${id}`, parseSession, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
    setSessions((list) => upsertSession(list, session));
    return session;
  }, []);

  const updateProject = useCallback(async (id: string, patch: ProjectPatch): Promise<Project> => {
    const project = await apiParsed(apiPath`/api/projects/${id}`, parseProject, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    setProjects((list) => list.map((item) => (item.id === project.id ? project : item)));
    return project;
  }, []);

  const sendSessionInput = useCallback(async (id: string, data: string): Promise<void> => {
    await api(apiPath`/api/sessions/${id}/input`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  }, []);

  const createTask = useCallback(
    async (
      projectId: string,
      text: string,
      { sourceSessionId, epicId, execution }: NewTaskOptions = {},
    ): Promise<Task> => {
      const task = await apiParsed(apiPath`/api/projects/${projectId}/tasks`, parseTask, {
        method: 'POST',
        body: JSON.stringify({ text, sourceSessionId, epicId: epicId ?? null, execution }),
      });
      setTasks((list) => upsertById(list, task));
      return task;
    },
    [],
  );

  const updateTask = useCallback(async (id: string, patch: TaskPatch): Promise<Task> => {
    const task = await apiParsed(apiPath`/api/tasks/${id}`, parseTask, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    setTasks((list) => upsertById(list, task));
    return task;
  }, []);

  const deleteTask = useCallback(async (id: string): Promise<void> => {
    await api(apiPath`/api/tasks/${id}`, { method: 'DELETE' });
    setTasks((list) => list.filter((t) => t.id !== id));
  }, []);

  const deleteCompletedBacklog = useCallback(async (projectId: string): Promise<void> => {
    const { taskIds, epicIds } = await apiParsed(
      apiPath`/api/projects/${projectId}/backlog/completed`,
      parseCompletedBacklogDeletion,
      { method: 'DELETE' },
    );
    const deletedTasks = new Set(taskIds);
    const deletedEpics = new Set(epicIds);
    setTasks((list) => list.filter((task) => !deletedTasks.has(task.id)));
    setEpics((list) => list.filter((epic) => !deletedEpics.has(epic.id)));
  }, []);

  const startTask = useCallback(async (id: string, spec: SessionDefaults): Promise<Session> => {
    const raw = await api(apiPath`/api/tasks/${id}/start`, {
      method: 'POST',
      body: JSON.stringify(spec),
    });
    const session = parseSession(isRecord(raw) ? raw.session : null);
    if (!session) throw new Error('Réponse session invalide');
    const task = parseTask(isRecord(raw) ? raw.task : null);
    setSessions((list) => upsertSession(list, session));
    if (task) setTasks((list) => upsertById(list, task));
    return session;
  }, []);

  const startCommandTask = useCallback(async (id: string): Promise<void> => {
    const raw = await api(apiPath`/api/tasks/${id}/start`, { method: 'POST' });
    const task = parseTask(isRecord(raw) ? raw.task : null);
    if (task) setTasks((list) => upsertById(list, task));
  }, []);

  const createEpic = useCallback(async (projectId: string, title: string, description?: string): Promise<Epic> => {
    const epic = await apiParsed(apiPath`/api/projects/${projectId}/epics`, parseEpic, {
      method: 'POST',
      body: JSON.stringify({ title, description }),
    });
    setEpics((list) => upsertById(list, epic));
    return epic;
  }, []);

  const updateEpic = useCallback(async (id: string, patch: { title?: string; description?: string }): Promise<Epic> => {
    const epic = await apiParsed(apiPath`/api/epics/${id}`, parseEpic, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    setEpics((list) => upsertById(list, epic));
    return epic;
  }, []);

  const deleteEpic = useCallback(async (id: string): Promise<void> => {
    await api(apiPath`/api/epics/${id}`, { method: 'DELETE' });
    setEpics((list) => list.filter((e) => e.id !== id));
  }, []);

  const startEpic = useCallback(async (id: string, spec?: SessionDefaults): Promise<EpicRun> => {
    return apiParsed(apiPath`/api/epics/${id}/start`, parseEpicRun, {
      method: 'POST',
      body: JSON.stringify(spec ?? {}),
    });
  }, []);

  const addEpicReviewTask = useCallback(async (epicId: string): Promise<Task> => {
    const task = await apiParsed(apiPath`/api/epics/${epicId}/review-task`, parseTask, { method: 'POST' });
    setTasks((list) => upsertById(list, task));
    return task;
  }, []);

  const startEpicReview = useCallback(async (epicId: string, spec: SessionDefaults): Promise<Session> => {
    const session = await apiParsed(apiPath`/api/epics/${epicId}/review`, parseSession, {
      method: 'POST',
      body: JSON.stringify(spec),
    });
    setSessions((list) => upsertSession(list, session));
    return session;
  }, []);

  // Le serveur range les findings retenus dans un epic, existant ou nouveau, et rend l'epic et ses tâches créées.
  const importFindings = useCallback(
    async (sessionId: string, reportId: string, selected: string[], epicId: string | null): Promise<void> => {
      const raw = await api(apiPath`/api/sessions/${sessionId}/findings/${reportId}/import`, {
        method: 'POST',
        body: JSON.stringify({ selected, epicId }),
      });
      const epic = parseEpic(isRecord(raw) ? raw.epic : null);
      if (epic) setEpics((list) => upsertById(list, epic));
      const created = parseTaskList(isRecord(raw) ? raw.tasks : null);
      setTasks((list) => created.reduce((next, task) => upsertById(next, task), list));
    },
    [],
  );

  const runPollMs = runEvents === false ? RUN_FALLBACK_POLL_MS : null;

  const value = useMemo<Store>(
    () => ({
      projects,
      sessions,
      tasks,
      epics,
      agents,
      refreshAgents,
      agentsRefreshing,
      agentsRefreshError,
      watchAgents,
      connected,
      runPollMs,
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
      deleteEpicSessions,
      markSeen,
      renameSession,
      updateProject,
      sendSessionInput,
      createTask,
      updateTask,
      deleteTask,
      deleteCompletedBacklog,
      startTask,
      startCommandTask,
      createEpic,
      updateEpic,
      deleteEpic,
      startEpic,
      addEpicReviewTask,
      startEpicReview,
      importFindings,
    }),
    [
      projects,
      sessions,
      tasks,
      epics,
      agents,
      refreshAgents,
      agentsRefreshing,
      agentsRefreshError,
      watchAgents,
      connected,
      runPollMs,
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
      deleteEpicSessions,
      markSeen,
      renameSession,
      updateProject,
      sendSessionInput,
      createTask,
      updateTask,
      deleteTask,
      deleteCompletedBacklog,
      startTask,
      startCommandTask,
      createEpic,
      updateEpic,
      deleteEpic,
      startEpic,
      addEpicReviewTask,
      startEpicReview,
      importFindings,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('Store manquant');
  return ctx;
}
