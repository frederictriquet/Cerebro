export type Agent = 'claude' | 'codex' | 'grok';
export type Mode = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypass';
export type Status = 'starting' | 'running' | 'waiting' | 'idle' | 'exited';
export type TaskExecution = {type:'llm'} | {type:'command';commandId:string;completion:'manual'|'exit-zero'};
export type TaskStatus = 'todo' | 'started' | 'done';
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type WorkspaceMode = 'isolated' | 'shared';

export const AGENTS: readonly Agent[] = ['claude', 'codex', 'grok'];
export const MODES: readonly Mode[] = ['auto', 'default', 'acceptEdits', 'plan', 'bypass'];
const EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// Ce que le formulaire de nouvelle session envoie au serveur.
export interface LaunchSpec {
  agent: Agent;
  mode: Mode;
  model: string | null;
  effort: Effort | null;
  prompt: string;
}

export const DEFAULT_SESSION_DEFAULTS: Readonly<LaunchSpec> = {
  agent: 'claude', mode: 'auto', model: null, effort: null, prompt: '',
};
export interface CommitSettings {
  agent: Agent;
  model: string | null;
  effort: Effort | null;
  strategy: 'single' | 'atomic';
}

export const STATUSES: readonly Status[] = ['starting', 'running', 'waiting', 'idle', 'exited'];

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string | null;
  sessionDefaults: LaunchSpec;
  commitSettings: CommitSettings;
  workspaceMode: WorkspaceMode;
  createdAt: number;
}

export interface Session {
  id: string;
  projectId: string;
  agent: Agent;
  mode: Mode;
  model: string | null;
  effort: Effort | null;
  prompt: string;
  title: string;
  status: Status;
  attention: boolean;
  attentionReason: string | null;
  agentSessionId: string | null;
  exitCode: number | null;
  createdAt: number;
  updatedAt: number;
  worktree: SessionWorktree | null;
}

export interface SessionWorktree {
  name: string;
  path: string;
  branch: string | null;
  removed: boolean;
  removedAt: number | null;
  /** Retirée par le nettoyage automatique à la fin de la conversation. */
  removedAutomatically: boolean;
}

export interface Task {
  id: string;
  projectId: string;
  text: string;
  status: TaskStatus;
  sessionId: string | null;
  sourceSessionId: string | null;
  dependsOn: string[];
  execution: TaskExecution;
  epicId: string | null;
  createdAt: number;
  updatedAt: number;
}

// Regroupement de tâches liées à un même sujet, traitable d'un bloc par une seule session.
export interface Epic {
  id: string;
  projectId: string;
  title: string;
  description: string;
  sourceSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ModelChoice {
  value: string;
  label: string;
  description: string;
  efforts: Effort[];
}

// Catalogue découvert par le serveur ; `efforts` : ceux du modèle par défaut de l'agent.
export interface AgentInfo {
  agent: Agent;
  available: boolean;
  models: ModelChoice[];
  efforts: Effort[];
}

export interface GitInfo {
  branch: string | null;
  dirty: number;
  ahead: number | null;
  hasCommits: boolean;
  hasUpstream: boolean;
  pendingCommits?: {
    upstream: string;
    commits: { hash: string; subject: string; author: string }[];
    truncated: boolean;
  };
  pendingCommitsError?: string;
}

export type EventsMessage =
  | { type: 'snapshot'; projects: Project[]; sessions: Session[]; tasks: Task[]; epics: Epic[] }
  | { type: 'session'; session: Session }
  | { type: 'session-deleted'; id: string }
  | { type: 'task'; task: Task }
  | { type: 'task-deleted'; id: string }
  | { type: 'epic'; epic: Epic }
  | { type: 'epic-deleted'; id: string }
  | { type: 'projects'; projects: Project[] }
  | { type: 'alert'; session: Session }
  | { type: 'peers' };

export type TermClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type TermServerMessage =
  | { type: 'snapshot'; data: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number | null };

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function isAgent(v: unknown): v is Agent {
  return v === 'claude' || v === 'codex' || v === 'grok';
}

export function isMode(v: unknown): v is Mode {
  return (MODES as readonly unknown[]).includes(v);
}

function isEffort(v: unknown): v is Effort {
  return (EFFORTS as readonly unknown[]).includes(v);
}

export function isStatus(v: unknown): v is Status {
  return (
    v === 'starting' || v === 'running' || v === 'waiting' || v === 'idle' || v === 'exited'
  );
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asNullableString(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return undefined;
}

function asNullableNumber(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

export function parseProject(v: unknown): Project | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const name = asString(v.name);
  const path = asString(v.path);
  const createdAt = asNumber(v.createdAt);
  if (id === null || name === null || path === null || createdAt === null) return null;
  const color = typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color) ? v.color : null;
  // Compatibilité avec les machines qui ne mémorisent pas encore les réglages de lancement.
  const saved = isRecord(v.sessionDefaults) ? v.sessionDefaults : {};
  const sessionDefaults: LaunchSpec = {
    agent: isAgent(saved.agent) ? saved.agent : DEFAULT_SESSION_DEFAULTS.agent,
    mode: isMode(saved.mode) ? saved.mode : DEFAULT_SESSION_DEFAULTS.mode,
    model: typeof saved.model === 'string' ? saved.model : null,
    effort: isEffort(saved.effort) ? saved.effort : null,
    prompt: typeof saved.prompt === 'string' ? saved.prompt : '',
  };
  const commit = isRecord(v.commitSettings) ? v.commitSettings : {};
  const commitSettings: CommitSettings = {
    agent: isAgent(commit.agent) ? commit.agent : sessionDefaults.agent,
    model: typeof commit.model === 'string' ? commit.model : null,
    effort: isEffort(commit.effort) ? commit.effort : null,
    strategy: commit.strategy === 'atomic' ? 'atomic' : 'single',
  };
  const workspaceMode:WorkspaceMode=v.workspaceMode==='shared'?'shared':'isolated';
  return { id, name, path, color, sessionDefaults, commitSettings, workspaceMode, createdAt };
}

export function parseSession(v: unknown): Session | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const projectId = asString(v.projectId);
  const title = asString(v.title);
  const prompt = asString(v.prompt);
  const createdAt = asNumber(v.createdAt);
  const updatedAt = asNumber(v.updatedAt);
  if (
    id === null ||
    projectId === null ||
    title === null ||
    prompt === null ||
    createdAt === null ||
    updatedAt === null ||
    !isAgent(v.agent) ||
    !isMode(v.mode) ||
    !isStatus(v.status) ||
    typeof v.attention !== 'boolean'
  ) {
    return null;
  }
  const attentionReason = asNullableString(v.attentionReason);
  const agentSessionId = asNullableString(v.agentSessionId);
  const exitCode = asNullableNumber(v.exitCode);
  if (attentionReason === undefined || agentSessionId === undefined || exitCode === undefined) {
    return null;
  }
  // Absents des serveurs antérieurs (machines distantes) : défaut de l'agent.
  const model = typeof v.model === 'string' ? v.model : null;
  const effort = isEffort(v.effort) ? v.effort : null;
  const worktree = parseSessionWorktree(v.worktree);
  return {
    id,
    projectId,
    agent: v.agent,
    mode: v.mode,
    model,
    effort,
    prompt,
    title,
    status: v.status,
    attention: v.attention,
    attentionReason,
    agentSessionId,
    exitCode,
    createdAt,
    updatedAt,
    worktree,
  };
}

// Absent des serveurs antérieurs : la session s'affiche sans worktree.
function parseSessionWorktree(v: unknown): SessionWorktree | null {
  if (!isRecord(v)) return null;
  const name = asString(v.name);
  const path = asString(v.path);
  if (name === null || path === null) return null;
  return {
    name, path, branch: typeof v.branch === 'string' ? v.branch : null, removed: v.removed === true,
    removedAt: typeof v.removedAt === 'number' ? v.removedAt : null, removedAutomatically: v.removedAutomatically === true,
  };
}

export function parseTask(v: unknown): Task | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const projectId = asString(v.projectId);
  const text = asString(v.text);
  const createdAt = asNumber(v.createdAt);
  const updatedAt = asNumber(v.updatedAt);
  const sessionId = asNullableString(v.sessionId);
  const sourceSessionId = asNullableString(v.sourceSessionId);
  const dependsOn = Array.isArray(v.dependsOn) ? v.dependsOn.filter((d): d is string => typeof d === 'string') : [];
  // Serveur antérieur aux epics (machine distante) : aucune.
  const epicId = typeof v.epicId === 'string' ? v.epicId : null;
  if (
    id === null ||
    projectId === null ||
    text === null ||
    createdAt === null ||
    updatedAt === null ||
    sessionId === undefined ||
    sourceSessionId === undefined ||
    (v.status !== 'todo' && v.status !== 'started' && v.status !== 'done')
  ) {
    return null;
  }
  const execution:TaskExecution = isRecord(v.execution) && v.execution.type==='command' && typeof v.execution.commandId==='string' ? {type:'command',commandId:v.execution.commandId,completion:v.execution.completion==='exit-zero'?'exit-zero':'manual'} : {type:'llm'};
  return { id, projectId, text, execution, status: v.status, sessionId, sourceSessionId, dependsOn, epicId, createdAt, updatedAt };
}

export function parseEpic(v: unknown): Epic | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const projectId = asString(v.projectId);
  const title = asString(v.title);
  const description = typeof v.description === 'string' ? v.description : '';
  const sourceSessionId = asNullableString(v.sourceSessionId);
  const createdAt = asNumber(v.createdAt);
  const updatedAt = asNumber(v.updatedAt);
  if (id === null || projectId === null || title === null || sourceSessionId === undefined || createdAt === null || updatedAt === null) {
    return null;
  }
  return { id, projectId, title, description, sourceSessionId, createdAt, updatedAt };
}

export function parseEpicList(v: unknown): Epic[] {
  if (!Array.isArray(v)) return [];
  return v.map(parseEpic).filter((e): e is Epic => e !== null);
}

export function parseTaskList(v: unknown): Task[] {
  if (!Array.isArray(v)) return [];
  const out: Task[] = [];
  for (const item of v) {
    const t = parseTask(item);
    if (t) out.push(t);
  }
  return out;
}

export function parseProjectList(v: unknown): Project[] {
  if (!Array.isArray(v)) return [];
  const out: Project[] = [];
  for (const item of v) {
    const p = parseProject(item);
    if (p) out.push(p);
  }
  return out;
}

export function parseSessionList(v: unknown): Session[] {
  if (!Array.isArray(v)) return [];
  const out: Session[] = [];
  for (const item of v) {
    const s = parseSession(item);
    if (s) out.push(s);
  }
  return out;
}

export function parseGitInfo(v: unknown): GitInfo | null {
  if (!isRecord(v)) return null;
  let branch: string | null;
  if (v.branch === null) branch = null;
  else if (typeof v.branch === 'string') branch = v.branch;
  else return null;
  if (typeof v.dirty !== 'number' || !Number.isFinite(v.dirty)) return null;
  let ahead: number | null;
  if (v.ahead === null) ahead = null;
  else if (typeof v.ahead === 'number' && Number.isFinite(v.ahead)) ahead = v.ahead;
  else return null;
  // Serveurs antérieurs : ne pas déduire de ahead=null qu'il y a des commits à publier.
  if (v.hasCommits !== undefined && typeof v.hasCommits !== 'boolean') return null;
  if (v.hasUpstream !== undefined && typeof v.hasUpstream !== 'boolean') return null;
  const hasCommits = v.hasCommits ?? ahead !== null;
  const hasUpstream = v.hasUpstream ?? ahead !== null;
  let pendingCommits: GitInfo['pendingCommits'];
  const preview = v.pendingCommits;
  if (isRecord(preview) && typeof preview.upstream === 'string' && typeof preview.truncated === 'boolean' && Array.isArray(preview.commits)) {
    const commits: NonNullable<GitInfo['pendingCommits']>['commits'] = [];
    for (const commit of preview.commits) {
      if (!isRecord(commit) || typeof commit.hash !== 'string' || typeof commit.subject !== 'string' || typeof commit.author !== 'string') return null;
      commits.push({ hash: commit.hash, subject: commit.subject, author: commit.author });
    }
    pendingCommits = { upstream: preview.upstream, truncated: preview.truncated, commits };
  }
  const pendingCommitsError = typeof v.pendingCommitsError === 'string' ? v.pendingCommitsError : undefined;
  return { branch, dirty: v.dirty, ahead, hasCommits, hasUpstream, ...(pendingCommits ? { pendingCommits } : {}), ...(pendingCommitsError ? { pendingCommitsError } : {}) };
}

export function parseScreenLines(v: unknown): string[] | null {
  if (!isRecord(v) || !Array.isArray(v.lines)) return null;
  const lines: string[] = [];
  for (const line of v.lines) {
    if (typeof line !== 'string') return null;
    lines.push(line);
  }
  return lines;
}

function parseEfforts(v: unknown): Effort[] {
  return Array.isArray(v) ? v.filter(isEffort) : [];
}

function parseModelChoices(v: unknown): ModelChoice[] {
  if (!Array.isArray(v)) return [];
  const out: ModelChoice[] = [];
  for (const item of v) {
    if (!isRecord(item) || typeof item.value !== 'string' || typeof item.label !== 'string') continue;
    const description = typeof item.description === 'string' ? item.description : '';
    out.push({ value: item.value, label: item.label, description, efforts: parseEfforts(item.efforts) });
  }
  return out;
}

export function parseAgentInfoList(v: unknown): AgentInfo[] {
  if (!Array.isArray(v)) return [];
  const out: AgentInfo[] = [];
  for (const item of v) {
    if (!isRecord(item) || !isAgent(item.agent) || typeof item.available !== 'boolean') continue;
    // Serveur antérieur au catalogue (machine distante) : seulement « défaut ».
    out.push({ agent: item.agent, available: item.available, models: parseModelChoices(item.models), efforts: parseEfforts(item.efforts) });
  }
  return out;
}

export function parseEventsMessage(v: unknown): EventsMessage | null {
  if (!isRecord(v) || typeof v.type !== 'string') return null;
  switch (v.type) {
    case 'snapshot':
      return {
        type: 'snapshot',
        projects: parseProjectList(v.projects),
        sessions: parseSessionList(v.sessions),
        tasks: parseTaskList(v.tasks),
        epics: parseEpicList(v.epics),
      };
    case 'session': {
      const session = parseSession(v.session);
      return session ? { type: 'session', session } : null;
    }
    case 'session-deleted': {
      const id = asString(v.id);
      return id ? { type: 'session-deleted', id } : null;
    }
    case 'task': {
      const task = parseTask(v.task);
      return task ? { type: 'task', task } : null;
    }
    case 'task-deleted': {
      const id = asString(v.id);
      return id ? { type: 'task-deleted', id } : null;
    }
    case 'epic': {
      const epic = parseEpic(v.epic);
      return epic ? { type: 'epic', epic } : null;
    }
    case 'epic-deleted': {
      const id = asString(v.id);
      return id ? { type: 'epic-deleted', id } : null;
    }
    case 'projects':
      return { type: 'projects', projects: parseProjectList(v.projects) };
    case 'alert': {
      const session = parseSession(v.session);
      return session ? { type: 'alert', session } : null;
    }
    case 'peers':
      return { type: 'peers' };
    default:
      return null;
  }
}

export function parseTermServerMessage(v: unknown): TermServerMessage | null {
  if (!isRecord(v) || typeof v.type !== 'string') return null;
  if (v.type === 'snapshot' || v.type === 'output') {
    const data = asString(v.data);
    if (data === null) return null;
    return { type: v.type, data };
  }
  if (v.type === 'exit') {
    if (!('exitCode' in v) || v.exitCode === undefined) return { type: 'exit', exitCode: null };
    const exitCode = asNullableNumber(v.exitCode);
    if (exitCode === undefined) return { type: 'exit', exitCode: null };
    return { type: 'exit', exitCode };
  }
  return null;
}
