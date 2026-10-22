import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.ts';

export type Agent = 'claude' | 'codex' | 'grok';
export type Mode = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypass';
export type Status = 'starting' | 'running' | 'waiting' | 'idle' | 'exited';
export type TaskStatus = 'todo' | 'started' | 'done';
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type WorkspaceMode = 'isolated' | 'shared';

export class SessionProtectionError extends Error {}

export interface SessionDefaults {
  agent: Agent;
  mode: Mode;
  model: string | null;
  effort: Effort | null;
  prompt: string;
}

export interface CommitSettings {
  agent: Agent;
  model: string | null;
  effort: Effort | null;
  strategy: 'single' | 'atomic';
}
export const DEFAULT_COMMIT_SETTINGS: Readonly<CommitSettings> = { agent: 'claude', model: null, effort: null, strategy: 'single' };

export const DEFAULT_SESSION_DEFAULTS: Readonly<SessionDefaults> = {
  agent: 'claude', mode: 'auto', model: null, effort: null, prompt: '',
};

// Un autre agent ne doit pas recevoir le modèle ou l'effort mémorisé pour le précédent.
// undefined hérite du choix enregistré ; null rétablit explicitement le défaut de la CLI.
export function resolveSessionDefaults(defaults: SessionDefaults, overrides: Partial<SessionDefaults>): SessionDefaults {
  const agent = overrides.agent ?? defaults.agent;
  return {
    agent,
    mode: overrides.mode ?? defaults.mode,
    model: overrides.model !== undefined ? overrides.model : agent === defaults.agent ? defaults.model : null,
    effort: overrides.effort !== undefined ? overrides.effort : agent === defaults.agent ? defaults.effort : null,
    prompt: overrides.prompt ?? defaults.prompt,
  };
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string | null;
  sessionDefaults: SessionDefaults;
  commitSettings: CommitSettings;
  workspaceMode: WorkspaceMode;
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
  protected: boolean;
  attentionReason: string | null;
  agentSessionId: string | null;
  exitCode: number | null;
  createdAt: number;
  updatedAt: number;
  // Copie de travail isolée de la conversation ; null quand elle travaille dans le dossier du projet.
  worktree: SessionWorktree | null;
  // Origine conservée même après nettoyage du backlog.
  epic: { id: string; title: string } | null;
  // Findings publiés qui n’ont pas encore été importés dans le backlog.
  pendingFindings: number;
}

export interface SessionWorktree {
  name: string;
  path: string;
  branch: string | null;
  removed: boolean;
  removedAt: number | null;
  /** Removed by the automatic cleanup once the conversation was over. */
  removedAutomatically: boolean;
}

export type TaskExecution = {type:'llm'} | {type:'command';commandId:string;completion:'manual'|'exit-zero'};
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
  execution: TaskExecution;
  // Epic du même projet qui regroupe la tâche, ou null.
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

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  color: string | null;
  session_defaults: string | null;
  commit_settings: string | null;
  workspace_mode: WorkspaceMode;
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
  protected: number;
  attention_reason: string | null;
  agent_session_id: string | null;
  exit_code: number | null;
  hook_token: string | null;
  created_at: number;
  updated_at: number;
  workspace: string | null;
  epic_id: string | null;
  resolved_epic_title: string | null;
  pending_findings: number;
}

interface TaskRow {
  execution: string;
  id: string;
  project_id: string;
  text: string;
  status: TaskStatus;
  session_id: string | null;
  source_session_id: string | null;
  epic_id: string | null;
  created_at: number;
  updated_at: number;
}

interface EpicRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  source_session_id: string | null;
  created_at: number;
  updated_at: number;
}

function epicFromRow(row: EpicRow): Epic {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    execution: row.execution ? JSON.parse(row.execution) : {type:'llm'},
    epicId: row.epic_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id, name: row.name, path: row.path, color: row.color ?? null, createdAt: row.created_at,
    sessionDefaults: row.session_defaults === null ? { ...DEFAULT_SESSION_DEFAULTS } : JSON.parse(row.session_defaults),
    commitSettings: row.commit_settings ? JSON.parse(row.commit_settings) : { ...DEFAULT_COMMIT_SETTINGS },
    workspaceMode: row.workspace_mode ?? 'isolated',
  };
}

function worktreeFromWorkspace(data: string | null): SessionWorktree | null {
  if (data === null) return null;
  const workspace = JSON.parse(data) as { mode: string; path: string; branch: string | null; removedAt?: number; removedAutomatically?: boolean };
  if (workspace.mode !== 'isolated') return null;
  return {
    name: basename(workspace.path), path: workspace.path, branch: workspace.branch, removed: workspace.removedAt !== undefined,
    removedAt: workspace.removedAt ?? null, removedAutomatically: workspace.removedAutomatically === true,
  };
}

const SESSION_SELECT = `SELECT s.*, w.data AS workspace, COALESCE(e.title, s.epic_title) AS resolved_epic_title,
  (SELECT COUNT(*) FROM review_reports r, json_each(r.data, '$.findings') f
    WHERE r.session_id = s.id AND NOT EXISTS (
      SELECT 1 FROM finding_imports i WHERE i.report_id = r.id AND i.finding_id = json_extract(f.value, '$.id')
    )) AS pending_findings
  FROM sessions s LEFT JOIN session_workspaces w ON w.session_id = s.id
  LEFT JOIN epics e ON e.id = s.epic_id AND e.project_id = s.project_id`;

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
    protected: row.protected !== 0,
    attentionReason: row.attention_reason,
    agentSessionId: row.agent_session_id,
    exitCode: row.exit_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    worktree: worktreeFromWorkspace(row.workspace),
    epic: row.epic_id && row.resolved_epic_title !== null ? { id: row.epic_id, title: row.resolved_epic_title } : null,
    pendingFindings: row.pending_findings,
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
      CREATE TABLE IF NOT EXISTS session_tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_tasks_session_id ON session_tasks(session_id);
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
      CREATE TABLE IF NOT EXISTS epics (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        source_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS epics_project_id ON epics(project_id);
    `);
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS review_reports (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, epic_id TEXT, UNIQUE(session_id,digest));
      CREATE TABLE IF NOT EXISTS finding_imports (report_id TEXT NOT NULL, finding_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(report_id,finding_id));
    `);
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS worktree_inventory (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worktree_operations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    // Workspace records survive session deletion so unmerged work is never silently removed.
    this.connection.exec('CREATE TABLE IF NOT EXISTS session_workspaces (session_id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    const taskColumns = this.connection.prepare('PRAGMA table_info(tasks)').all() as unknown as { name: string }[];
    if (!taskColumns.some((column) => column.name === 'epic_id')) {
      this.connection.exec('ALTER TABLE tasks ADD COLUMN epic_id TEXT REFERENCES epics(id) ON DELETE SET NULL');
    }
    if (!taskColumns.some(column=>column.name==='execution')) this.connection.exec(`ALTER TABLE tasks ADD COLUMN execution TEXT NOT NULL DEFAULT '{"type":"llm"}'`);
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS project_commands (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_results (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_turns (session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, custom_at INTEGER, relayed_at INTEGER, automatic_at INTEGER);
      CREATE TABLE IF NOT EXISTS epic_runs (id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS epic_workspaces (epic_id TEXT PRIMARY KEY REFERENCES epics(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
    `);
    // Contextes mémorisés avant la vérification complète des historiques : ils seront recontrôlés.
    const epicWorkspaceColumns = this.connection.prepare('PRAGMA table_info(epic_workspaces)').all() as unknown as { name: string }[];
    if (!epicWorkspaceColumns.some((column) => column.name === 'verified')) this.connection.exec('ALTER TABLE epic_workspaces ADD COLUMN verified INTEGER NOT NULL DEFAULT 0');
    this.connection.exec('CREATE INDEX IF NOT EXISTS tasks_epic_id ON tasks(epic_id)');
    const columns = this.connection.prepare('PRAGMA table_info(sessions)').all() as unknown as { name: string }[];
    if (!columns.some((column) => column.name === 'protected')) {
      this.connection.exec('ALTER TABLE sessions ADD COLUMN protected INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some((column) => column.name === 'hook_token')) {
      this.connection.exec('ALTER TABLE sessions ADD COLUMN hook_token TEXT');
    }
    for (const column of ['model', 'effort']) {
      if (!columns.some((c) => c.name === column)) this.connection.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
    }
    const epicColumns = ['epic_id', 'epic_title'];
    if (epicColumns.some((name) => !columns.some((column) => column.name === name))) {
      // Le schéma et la reprise de l'historique doivent être validés ensemble.
      this.connection.exec('BEGIN');
      try {
        for (const name of epicColumns) {
          if (!columns.some((column) => column.name === name)) this.connection.exec(`ALTER TABLE sessions ADD COLUMN ${name} TEXT`);
        }
        this.backfillSessionEpics();
        this.connection.exec('COMMIT');
      } catch (error) {
        this.connection.exec('ROLLBACK');
        throw error;
      }
    }
    const projectColumns = this.connection.prepare('PRAGMA table_info(projects)').all() as unknown as { name: string }[];
    if (!projectColumns.some((column) => column.name === 'sort_order')) {
      this.connection.exec('ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    }
    if (!projectColumns.some(column => column.name === 'workspace_mode')) {
      this.connection.exec("ALTER TABLE projects ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'isolated' CHECK (workspace_mode IN ('isolated','shared'))");
    }
    if (!projectColumns.some((column) => column.name === 'color')) {
      this.connection.exec('ALTER TABLE projects ADD COLUMN color TEXT');
    }
    if (!projectColumns.some((column) => column.name === 'session_defaults')) {
      this.connection.exec('ALTER TABLE projects ADD COLUMN session_defaults TEXT');
      // Reprendre les derniers choix à l'installation, sans confondre activité récente et création.
      this.connection.exec(`
        UPDATE projects SET session_defaults = (
          SELECT json_object('agent', agent, 'mode', mode, 'model', model, 'effort', effort, 'prompt', prompt)
          FROM sessions WHERE project_id = projects.id ORDER BY created_at DESC, rowid DESC LIMIT 1
        )
      `);
    }
    const commitColumns = this.connection.prepare('PRAGMA table_info(projects)').all() as {name:string}[];
    if (!commitColumns.some(column => column.name === 'commit_settings')) {
      this.connection.exec(`ALTER TABLE projects ADD COLUMN commit_settings TEXT;
        UPDATE projects SET commit_settings = json_object(
          'agent', COALESCE(json_extract(session_defaults, '$.agent'), 'claude'),
          'model', json_extract(session_defaults, '$.model'),
          'effort', json_extract(session_defaults, '$.effort'), 'strategy', 'single');`);
    }
    this.connection.exec('CREATE TABLE IF NOT EXISTS automatic_commits (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    this.connection.exec('CREATE TABLE IF NOT EXISTS automatic_commit_requests (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, scope TEXT NOT NULL, push INTEGER NOT NULL)');
    this.allowAutoMode();
  }

  private backfillSessionEpics(): void {
    const sessions = this.connection.prepare('SELECT id, project_id, prompt FROM sessions').all() as { id: string; project_id: string; prompt: string }[];
    const fromRun = this.connection.prepare(`SELECT e.id, e.title FROM epic_runs r
      JOIN epics e ON e.id = r.epic_id WHERE r.id = ? AND e.project_id = ?`);
    const fromTasks = this.connection.prepare(`SELECT DISTINCT e.id, e.title FROM tasks t
      JOIN epics e ON e.id = t.epic_id WHERE t.session_id = ? AND t.project_id = ? AND e.project_id = t.project_id`);
    const save = this.connection.prepare('UPDATE sessions SET epic_id = ?, epic_title = ? WHERE id = ?');
    for (const session of sessions) {
      // Les marqueurs identifient aussi les anciennes tentatives remplacées sur la tâche.
      const marker = /^\[CEREBRO_EPIC_STEP ([^\s\]]+) [^\s\]]+\](?:\r?\n|$)/.exec(session.prompt);
      const origin = marker ? fromRun.get(marker[1], session.project_id) as { id: string; title: string } | undefined : undefined;
      const candidates = origin ? [origin] : fromTasks.all(session.id, session.project_id) as { id: string; title: string }[];
      // Aucun rapprochement sur le titre : deux epics peuvent porter le même nom.
      if (candidates.length === 1) save.run(candidates[0].id, candidates[0].title, session.id);
    }
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
    return (this.connection.prepare('SELECT * FROM projects ORDER BY sort_order ASC, created_at ASC, rowid ASC').all() as unknown as ProjectRow[])
      .map(projectFromRow);
  }

  reorderProjects(ids: string[]): Project[] | null {
    const projects = this.listProjects();
    const knownIds = new Set(projects.map((project) => project.id));
    if (ids.length !== projects.length || new Set(ids).size !== ids.length || ids.some((id) => !knownIds.has(id))) return null;

    this.connection.exec('BEGIN');
    try {
      const update = this.connection.prepare('UPDATE projects SET sort_order = ? WHERE id = ?');
      ids.forEach((id, index) => update.run(index, id));
      this.connection.exec('COMMIT');
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
    return this.listProjects();
  }

  getProject(id: string): Project | null {
    const row = this.connection.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined;
    return row === undefined ? null : projectFromRow(row);
  }

  createProject(name: string, path: string, workspaceMode: WorkspaceMode = 'isolated'): Project {
    const project: Project = {
      id: randomUUID(), name, path, color: null, sessionDefaults: { ...DEFAULT_SESSION_DEFAULTS }, commitSettings: { ...DEFAULT_COMMIT_SETTINGS }, workspaceMode, createdAt: Date.now(),
    };
    this.connection.prepare(`INSERT INTO projects (id, name, path, created_at, workspace_mode, sort_order)
      VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects))`)
      .run(project.id, project.name, project.path, project.createdAt, project.workspaceMode);
    return project;
  }

  updateProject(id: string, changes: Partial<Pick<Project, 'name' | 'path' | 'color' | 'sessionDefaults' | 'commitSettings' | 'workspaceMode'>>): Project | null {
    const current = this.getProject(id);
    if (current === null) return null;
    const next = { ...current, ...changes };
    this.connection.prepare('UPDATE projects SET name = ?, path = ?, color = ?, session_defaults = ?, commit_settings = ?, workspace_mode = ? WHERE id = ?')
      .run(next.name, next.path, next.color, JSON.stringify(next.sessionDefaults), JSON.stringify(next.commitSettings), next.workspaceMode, id);
    return next;
  }

  setSessionDefaults(projectId: string, defaults: SessionDefaults): void {
    this.connection.prepare('UPDATE projects SET session_defaults = ? WHERE id = ?')
      .run(JSON.stringify(defaults), projectId);
  }

  deleteProject(id: string): boolean {
    if (this.listProjectSessions(id).some((session) => session.protected)) {
      throw new SessionProtectionError('Ce projet contient des sessions protégées. Décochez leur protection avant de le supprimer.');
    }
    return Number(this.connection.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) > 0;
  }

  listSessions(): Session[] {
    return (this.connection.prepare(`${SESSION_SELECT} ORDER BY s.created_at DESC, s.rowid DESC`).all() as unknown as SessionRow[])
      .map(sessionFromRow);
  }

  listProjectSessions(projectId: string): Session[] {
    return (this.connection.prepare(`${SESSION_SELECT} WHERE s.project_id = ? ORDER BY s.created_at DESC, s.rowid DESC`)
      .all(projectId) as unknown as SessionRow[]).map(sessionFromRow);
  }

  getSession(id: string): Session | null {
    const row = this.connection.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as unknown as SessionRow | undefined;
    return row === undefined ? null : sessionFromRow(row);
  }

  createSession(
    input: Pick<Session, 'id' | 'projectId' | 'agent' | 'mode' | 'model' | 'effort' | 'prompt' | 'title' | 'status' | 'agentSessionId'>,
    hookToken: string,
    epicId: string | null = null,
  ): Session {
    const epic = epicId === null ? null : this.getEpic(epicId);
    if (epicId !== null && (!epic || epic.projectId !== input.projectId)) throw new Error('Epic introuvable dans ce projet');
    const now = Date.now();
    const session: Session = {
      ...input,
      attention: false,
      protected: false,
      attentionReason: null,
      exitCode: null,
      createdAt: now,
      updatedAt: now,
      worktree: null,
      epic: epic ? { id: epic.id, title: epic.title } : null,
      pendingFindings: 0,
    };
    this.connection.prepare(`
      INSERT INTO sessions (
        id, project_id, agent, mode, prompt, title, status, attention,
        attention_reason, agent_session_id, exit_code, hook_token, created_at, updated_at, model, effort, epic_id, epic_title
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.projectId, session.agent, session.mode, session.prompt,
      session.title, session.status, 0, null, session.agentSessionId, null, hookToken,
      session.createdAt, session.updatedAt, session.model, session.effort,
      session.epic?.id ?? null, session.epic?.title ?? null,
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

  setSessionProtected(id: string, value: boolean): Session | null {
    // Changing protection is not activity: keep the session's age and dormant status.
    this.connection.prepare('UPDATE sessions SET protected = ? WHERE id = ?').run(value ? 1 : 0, id);
    return this.getSession(id);
  }

  deleteSession(id: string): boolean {
    if (this.getSession(id)?.protected) {
      throw new SessionProtectionError('Session protégée. Décochez sa protection avant de la supprimer.');
    }
    return Number(this.connection.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes) > 0;
  }

  listTasks(): Task[] {
    const edges = this.connection.prepare('SELECT task_id, depends_on_id FROM task_dependencies').all() as unknown as
      { task_id: string; depends_on_id: string }[];
    const deps = new Map<string, string[]>();
    for (const edge of edges) deps.set(edge.task_id, [...(deps.get(edge.task_id) ?? []), edge.depends_on_id]);
    return (this.connection.prepare('SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC').all() as unknown as TaskRow[])
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

  createTask(projectId: string, text: string, sourceSessionId: string | null, epicId: string | null = null, execution: TaskExecution = {type:'llm'}): Task {
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      projectId,
      text,
      status: 'todo',
      sessionId: null,
      sourceSessionId,
      dependsOn: [],
      execution,
      epicId,
      createdAt: now,
      updatedAt: now,
    };
    this.connection.prepare(`
      INSERT INTO tasks (id, project_id, text, status, session_id, source_session_id, epic_id, created_at, updated_at, execution)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.projectId, task.text, task.status, null, sourceSessionId, epicId, now, now, JSON.stringify(execution));
    return task;
  }

  updateTask(id: string, changes: Partial<Pick<Task, 'text' | 'status' | 'sessionId' | 'dependsOn' | 'epicId' | 'execution'>>): Task | null {
    const current = this.getTask(id);
    if (current === null) return null;
    const next = { ...current, ...changes, updatedAt: Date.now() };
    this.connection.prepare('UPDATE tasks SET text = ?, status = ?, session_id = ?, epic_id = ?, updated_at = ?, execution = ? WHERE id = ?')
      .run(next.text, next.status, next.sessionId, next.epicId, next.updatedAt, JSON.stringify(next.execution), id);
    if (changes.dependsOn !== undefined) {
      this.setTaskDependencies(id, changes.dependsOn);
      next.dependsOn = this.taskDependencies(id);
    }
    return next;
  }

  deleteTask(id: string): boolean {
    return Number(this.connection.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes) > 0;
  }

  deleteCompletedBacklog(projectId: string): { taskIds: string[]; epicIds: string[]; dependentIds: string[] } {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const tasks = this.listTasks().filter((task) => task.projectId === projectId);
      const taskIds = tasks.filter((task) => task.status === 'done').map((task) => task.id);
      // Identifier les epics terminés avant de retirer leurs tâches. Un epic vide reste à faire.
      const epicIds = this.listEpics().filter((epic) => {
        if (epic.projectId !== projectId) return false;
        const members = tasks.filter((task) => task.epicId === epic.id);
        return members.length > 0 && members.every((task) => task.status === 'done');
      }).map((epic) => epic.id);
      const dependentIds = [...new Set(taskIds.flatMap((id) => this.listDependents(id)))];
      for (const id of taskIds) this.deleteTask(id);
      for (const id of epicIds) this.deleteEpic(id);
      this.connection.exec('COMMIT');
      return { taskIds, epicIds, dependentIds };
    } catch (cause) {
      this.connection.exec('ROLLBACK');
      throw cause;
    }
  }

  listEpics(): Epic[] {
    return (this.connection.prepare('SELECT * FROM epics ORDER BY created_at ASC, rowid ASC').all() as unknown as EpicRow[])
      .map(epicFromRow);
  }

  getEpic(id: string): Epic | null {
    const row = this.connection.prepare('SELECT * FROM epics WHERE id = ?').get(id) as unknown as EpicRow | undefined;
    return row === undefined ? null : epicFromRow(row);
  }

  createEpic(projectId: string, title: string, description: string, sourceSessionId: string | null): Epic {
    const now = Date.now();
    const epic: Epic = { id: randomUUID(), projectId, title, description, sourceSessionId, createdAt: now, updatedAt: now };
    this.connection.prepare(`
      INSERT INTO epics (id, project_id, title, description, source_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(epic.id, projectId, title, description, sourceSessionId, now, now);
    return epic;
  }

  updateEpic(id: string, changes: Partial<Pick<Epic, 'title' | 'description'>>): Epic | null {
    const current = this.getEpic(id);
    if (current === null) return null;
    const next = { ...current, ...changes, updatedAt: Date.now() };
    this.connection.prepare('UPDATE epics SET title = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.description, next.updatedAt, id);
    this.connection.prepare('UPDATE sessions SET epic_title = ? WHERE epic_id = ?').run(next.title, id);
    return next;
  }

  // Les tâches de l'epic restent dans le backlog, sans epic (ON DELETE SET NULL).
  deleteEpic(id: string): boolean {
    return Number(this.connection.prepare('DELETE FROM epics WHERE id = ?').run(id).changes) > 0;
  }

  close(): void {
    this.connection.close();
  }
}
