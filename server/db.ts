import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.ts';

export type Agent = 'claude' | 'codex' | 'grok';
export type Mode = 'default' | 'acceptEdits' | 'plan' | 'bypass';
export type Status = 'starting' | 'running' | 'waiting' | 'idle' | 'exited';

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

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: number;
}

interface SessionRow {
  id: string;
  project_id: string;
  agent: Agent;
  mode: Mode;
  prompt: string;
  title: string;
  status: Status;
  attention: number;
  attention_reason: string | null;
  agent_session_id: string | null;
  exit_code: number | null;
  created_at: number;
  updated_at: number;
}

function projectFromRow(row: ProjectRow): Project {
  return { id: row.id, name: row.name, path: row.path, createdAt: row.created_at };
}

function sessionFromRow(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    agent: row.agent,
    mode: row.mode,
    prompt: row.prompt,
    title: row.title,
    status: row.status,
    attention: row.attention !== 0,
    attentionReason: row.attention_reason,
    agentSessionId: row.agent_session_id,
    exitCode: row.exit_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CerebroDatabase {
  readonly connection: DatabaseSync;

  constructor(path = join(DATA_DIR, 'cerebro.db')) {
    this.connection = new DatabaseSync(path);
    this.connection.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex', 'grok')),
        mode TEXT NOT NULL CHECK (mode IN ('default', 'acceptEdits', 'plan', 'bypass')),
        prompt TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'waiting', 'idle', 'exited')),
        attention INTEGER NOT NULL DEFAULT 0,
        attention_reason TEXT,
        agent_session_id TEXT,
        exit_code INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_project_id ON sessions(project_id);
      CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at DESC);
    `);

    const now = Date.now();
    this.connection.prepare(`
      UPDATE sessions
      SET status = 'exited', attention = 0, attention_reason = NULL, updated_at = ?
      WHERE status != 'exited'
    `).run(now);
  }

  listProjects(): Project[] {
    return (this.connection.prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as unknown as ProjectRow[])
      .map(projectFromRow);
  }

  getProject(id: string): Project | null {
    const row = this.connection.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined;
    return row === undefined ? null : projectFromRow(row);
  }

  createProject(name: string, path: string): Project {
    const project: Project = { id: randomUUID(), name, path, createdAt: Date.now() };
    this.connection.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)')
      .run(project.id, project.name, project.path, project.createdAt);
    return project;
  }

  deleteProject(id: string): boolean {
    return Number(this.connection.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) > 0;
  }

  listSessions(): Session[] {
    return (this.connection.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as unknown as SessionRow[])
      .map(sessionFromRow);
  }

  listProjectSessions(projectId: string): Session[] {
    return (this.connection.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as unknown as SessionRow[]).map(sessionFromRow);
  }

  getSession(id: string): Session | null {
    const row = this.connection.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
    return row === undefined ? null : sessionFromRow(row);
  }

  createSession(input: Pick<Session, 'id' | 'projectId' | 'agent' | 'mode' | 'prompt' | 'title' | 'status' | 'agentSessionId'>): Session {
    const now = Date.now();
    const session: Session = {
      ...input,
      attention: false,
      attentionReason: null,
      exitCode: null,
      createdAt: now,
      updatedAt: now,
    };
    this.connection.prepare(`
      INSERT INTO sessions (
        id, project_id, agent, mode, prompt, title, status, attention,
        attention_reason, agent_session_id, exit_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.projectId, session.agent, session.mode, session.prompt,
      session.title, session.status, 0, null, session.agentSessionId, null,
      session.createdAt, session.updatedAt,
    );
    return session;
  }

  updateSession(id: string, changes: Partial<Pick<Session, 'status' | 'attention' | 'attentionReason' | 'agentSessionId' | 'exitCode'>>): Session | null {
    const current = this.getSession(id);
    if (current === null) return null;
    const next = { ...current, ...changes, updatedAt: Date.now() };
    this.connection.prepare(`
      UPDATE sessions SET status = ?, attention = ?, attention_reason = ?,
        agent_session_id = ?, exit_code = ?, updated_at = ? WHERE id = ?
    `).run(
      next.status, next.attention ? 1 : 0, next.attentionReason,
      next.agentSessionId, next.exitCode, next.updatedAt, id,
    );
    return next;
  }

  deleteSession(id: string): boolean {
    return Number(this.connection.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes) > 0;
  }

  close(): void {
    this.connection.close();
  }
}
