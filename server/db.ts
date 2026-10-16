import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.ts';

export type Agent = 'claude' | 'codex' | 'grok';
export type Mode = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypass';
export type Status = 'starting' | 'running' | 'waiting' | 'idle' | 'exited';
export type TaskStatus = 'todo' | 'started' | 'done';
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

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
  // null : modèle / effort par défaut de la configuration de l'agent.
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
}

// Élément du backlog d'un projet : un texte à confier plus tard à une session.
export interface Task {
  id: string;
  projectId: string;
  text: string;
  status: TaskStatus;
  sessionId: string | null;
  sourceSessionId: string | null;
  // Tâches du même projet à terminer avant de pouvoir lancer celle-ci.
  dependsOn: string[];
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
  model: string | null;
  effort: Effort | null;
  prompt: string;
  title: string;
  status: Status;
  attention: number;
  attention_reason: string | null;
  agent_session_id: string | null;
  exit_code: number | null;
  hook_token: string | null;
  created_at: number;
  updated_at: number;
}

interface TaskRow {
  id: string;
  project_id: string;
  text: string;
  status: TaskStatus;
  session_id: string | null;
  source_session_id: string | null;
  created_at: number;
  updated_at: number;
}

function taskFromRow(row: TaskRow, dependsOn: string[]): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    text: row.text,
    status: row.status,
    sessionId: row.session_id,
    sourceSessionId: row.source_session_id,
    dependsOn,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    model: row.model,
    effort: row.effort,
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
        mode TEXT NOT NULL CHECK (mode IN ('default', 'auto', 'acceptEdits', 'plan', 'bypass')),
        prompt TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'waiting', 'idle', 'exited')),
        attention INTEGER NOT NULL DEFAULT 0,
        attention_reason TEXT,
        agent_session_id TEXT,
        exit_code INTEGER,
        hook_token TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        model TEXT,
        effort TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_project_id ON sessions(project_id);
      CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('todo', 'started', 'done')),
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        source_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_project_id ON tasks(project_id);
      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, depends_on_id)
      );
      CREATE INDEX IF NOT EXISTS task_dependencies_depends_on_id ON task_dependencies(depends_on_id);
    `);
    const columns = this.connection.prepare('PRAGMA table_info(sessions)').all() as unknown as { name: string }[];
    if (!columns.some((column) => column.name === 'hook_token')) {
      this.connection.exec('ALTER TABLE sessions ADD COLUMN hook_token TEXT');
    }
    for (const column of ['model', 'effort']) {
      if (!columns.some((c) => c.name === column)) this.connection.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
    }
    this.allowAutoMode();
  }

  // SQLite ne permet pas de modifier une contrainte CHECK : on reconstruit la table.
  private allowAutoMode(): void {
    const row = this.connection.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
      .get() as { sql: string } | undefined;
    if (row === undefined || row.sql.includes("'auto'")) return;
    const sql = row.sql.replace("('default', 'acceptEdits'", "('default', 'auto', 'acceptEdits'")
      .replace(/^CREATE TABLE "?sessions"?/, 'CREATE TABLE sessions_new');
    this.connection.exec('PRAGMA foreign_keys = OFF');
    try {
      this.connection.exec(`
        BEGIN;
        ${sql};
        INSERT INTO sessions_new SELECT * FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS sessions_project_id ON sessions(project_id);
        CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at DESC);
        COMMIT;
      `);
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    } finally {
      this.connection.exec('PRAGMA foreign_keys = ON');
    }
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

  updateProject(id: string, changes: Partial<Pick<Project, 'name' | 'path'>>): Project | null {
    const current = this.getProject(id);
    if (current === null) return null;
    const next = { ...current, ...changes };
    this.connection.prepare('UPDATE projects SET name = ?, path = ? WHERE id = ?')
      .run(next.name, next.path, id);
    return next;
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

  createSession(
    input: Pick<Session, 'id' | 'projectId' | 'agent' | 'mode' | 'model' | 'effort' | 'prompt' | 'title' | 'status' | 'agentSessionId'>,
    hookToken: string,
  ): Session {
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
        attention_reason, agent_session_id, exit_code, hook_token, created_at, updated_at, model, effort
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.projectId, session.agent, session.mode, session.prompt,
      session.title, session.status, 0, null, session.agentSessionId, null, hookToken,
      session.createdAt, session.updatedAt, session.model, session.effort,
    );
    return session;
  }

  getHookToken(id: string): string | null {
    const row = this.connection.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(id) as unknown as
      { hook_token: string | null } | undefined;
    return row?.hook_token ?? null;
  }

  setHookToken(id: string, hookToken: string): boolean {
    return Number(this.connection.prepare('UPDATE sessions SET hook_token = ? WHERE id = ?').run(hookToken, id).changes) > 0;
  }

  updateSession(id: string, changes: Partial<Pick<Session, 'title' | 'status' | 'attention' | 'attentionReason' | 'agentSessionId' | 'exitCode'>>): Session | null {
    const current = this.getSession(id);
    if (current === null) return null;
    const next = { ...current, ...changes, updatedAt: Date.now() };
    this.connection.prepare(`
      UPDATE sessions SET title = ?, status = ?, attention = ?, attention_reason = ?,
        agent_session_id = ?, exit_code = ?, updated_at = ? WHERE id = ?
    `).run(
      next.title, next.status, next.attention ? 1 : 0, next.attentionReason,
      next.agentSessionId, next.exitCode, next.updatedAt, id,
    );
    return next;
  }

  deleteSession(id: string): boolean {
    return Number(this.connection.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes) > 0;
  }

  listTasks(): Task[] {
    const edges = this.connection.prepare('SELECT task_id, depends_on_id FROM task_dependencies').all() as unknown as
      { task_id: string; depends_on_id: string }[];
    const deps = new Map<string, string[]>();
    for (const edge of edges) deps.set(edge.task_id, [...(deps.get(edge.task_id) ?? []), edge.depends_on_id]);
    return (this.connection.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all() as unknown as TaskRow[])
      .map((row) => taskFromRow(row, deps.get(row.id) ?? []));
  }

  getTask(id: string): Task | null {
    const row = this.connection.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
    return row === undefined ? null : taskFromRow(row, this.taskDependencies(id));
  }

  private taskDependencies(id: string): string[] {
    return (this.connection.prepare('SELECT depends_on_id FROM task_dependencies WHERE task_id = ?').all(id) as unknown as
      { depends_on_id: string }[]).map((row) => row.depends_on_id);
  }

  // Tâches qui dépendent de `id` (à rediffuser quand elle disparaît).
  listDependents(id: string): string[] {
    return (this.connection.prepare('SELECT task_id FROM task_dependencies WHERE depends_on_id = ?').all(id) as unknown as
      { task_id: string }[]).map((row) => row.task_id);
  }

  setTaskDependencies(id: string, dependsOn: string[]): void {
    this.connection.exec('BEGIN');
    try {
      this.connection.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(id);
      const insert = this.connection.prepare('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)');
      for (const dep of new Set(dependsOn)) insert.run(id, dep);
      this.connection.exec('COMMIT');
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  createTask(projectId: string, text: string, sourceSessionId: string | null): Task {
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      projectId,
      text,
      status: 'todo',
      sessionId: null,
      sourceSessionId,
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    };
    this.connection.prepare(`
      INSERT INTO tasks (id, project_id, text, status, session_id, source_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.projectId, task.text, task.status, null, sourceSessionId, now, now);
    return task;
  }

  updateTask(id: string, changes: Partial<Pick<Task, 'text' | 'status' | 'sessionId' | 'dependsOn'>>): Task | null {
    const current = this.getTask(id);
    if (current === null) return null;
    const next = { ...current, ...changes, updatedAt: Date.now() };
    this.connection.prepare('UPDATE tasks SET text = ?, status = ?, session_id = ?, updated_at = ? WHERE id = ?')
      .run(next.text, next.status, next.sessionId, next.updatedAt, id);
    if (changes.dependsOn !== undefined) {
      this.setTaskDependencies(id, changes.dependsOn);
      next.dependsOn = this.taskDependencies(id);
    }
    return next;
  }

  deleteTask(id: string): boolean {
    return Number(this.connection.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes) > 0;
  }

  close(): void {
    this.connection.close();
  }
}
