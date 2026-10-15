export type Agent = 'claude' | 'codex' | 'grok';
export type Mode = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypass';
export type Status = 'starting' | 'running' | 'waiting' | 'idle' | 'exited';
export type TaskStatus = 'todo' | 'started' | 'done';

export const AGENTS: readonly Agent[] = ['claude', 'codex', 'grok'];
export const MODES: readonly Mode[] = ['auto', 'default', 'acceptEdits', 'plan', 'bypass'];
export const STATUSES: readonly Status[] = ['starting', 'running', 'waiting', 'idle', 'exited'];

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

export interface Session {
  id: string;
  projectId: string;
  agent: Agent;
  mode: Mode;
  prompt: string;
  title: string;
  status: Status;
  attention: boolean;
  attentionReason: string | null;
  agentSessionId: string | null;
  exitCode: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  projectId: string;
  text: string;
  status: TaskStatus;
  sessionId: string | null;
  sourceSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentInfo {
  agent: Agent;
  available: boolean;
}

export interface GitInfo {
  branch: string | null;
  dirty: number;
  ahead: number | null;
}

export type EventsMessage =
  | { type: 'snapshot'; projects: Project[]; sessions: Session[]; tasks: Task[] }
  | { type: 'session'; session: Session }
  | { type: 'session-deleted'; id: string }
  | { type: 'task'; task: Task }
  | { type: 'task-deleted'; id: string }
  | { type: 'projects'; projects: Project[] }
  | { type: 'alert'; session: Session };

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
  return { id, name, path, createdAt };
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
  return {
    id,
    projectId,
    agent: v.agent,
    mode: v.mode,
    prompt,
    title,
    status: v.status,
    attention: v.attention,
    attentionReason,
    agentSessionId,
    exitCode,
    createdAt,
    updatedAt,
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
  return { id, projectId, text, status: v.status, sessionId, sourceSessionId, createdAt, updatedAt };
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
  return { branch, dirty: v.dirty, ahead };
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

export function parseAgentInfoList(v: unknown): AgentInfo[] {
  if (!Array.isArray(v)) return [];
  const out: AgentInfo[] = [];
  for (const item of v) {
    if (!isRecord(item) || !isAgent(item.agent) || typeof item.available !== 'boolean') continue;
    out.push({ agent: item.agent, available: item.available });
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
    case 'projects':
      return { type: 'projects', projects: parseProjectList(v.projects) };
    case 'alert': {
      const session = parseSession(v.session);
      return session ? { type: 'alert', session } : null;
    }
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
