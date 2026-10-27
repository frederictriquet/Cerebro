import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.ts';
import { convertLegacyCouncilSettings, DEFAULT_PERSONAS, isLegacyCouncilSettings, withoutPersona } from './council.ts';
import {
  DEFAULT_COMMIT_SETTINGS,
  DEFAULT_RESOLUTION_SETTINGS,
  DEFAULT_SESSION_DEFAULTS,
  normalizeMode,
  type Agent,
  type CouncilRun,
  type CouncilSettings,
  type Effort,
  type Epic,
  type Mode,
  type Persona,
  type PersonaInput,
  type Project,
  type Session,
  type SessionDefaults,
  type SessionWorktree,
  type Status,
  type Task,
  type TaskExecution,
  type TaskStatus,
  type WorkspaceMode,
} from '../shared/types.ts';

export class SessionProtectionError extends Error {}

// Un autre agent ne doit pas recevoir le modèle ou l'effort mémorisé pour le précédent.
// undefined inherits the saved choice; null explicitly resets to the Cerebro default (see parseTuning).
export function resolveSessionDefaults(defaults: SessionDefaults, overrides: Partial<SessionDefaults>): SessionDefaults {
  const agent = overrides.agent ?? defaults.agent;
  return {
    agent,
    mode: normalizeMode(overrides.mode ?? defaults.mode),
    model: overrides.model !== undefined ? overrides.model : agent === defaults.agent ? defaults.model : null,
    effort: overrides.effort !== undefined ? overrides.effort : agent === defaults.agent ? defaults.effort : null,
    prompt: overrides.prompt ?? defaults.prompt,
  };
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  color: string | null;
  session_defaults: string | null;
  commit_settings: string | null;
  council_settings: string | null;
  resolution_settings: string | null;
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

interface PersonaRow {
  id: string;
  name: string;
  description: string;
  prompt: string;
  builtin: number;
  created_at: number | null;
  updated_at: number | null;
}

function personaFromRow(row: PersonaRow): Persona {
  return {
    id: row.id, name: row.name, description: row.description, prompt: row.prompt, builtin: row.builtin === 1,
    createdAt: row.created_at ?? 0, updatedAt: row.updated_at ?? row.created_at ?? 0,
  };
}

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id, name: row.name, path: row.path, color: row.color ?? null, createdAt: row.created_at,
    sessionDefaults: row.session_defaults === null ? { ...DEFAULT_SESSION_DEFAULTS } : JSON.parse(row.session_defaults),
    commitSettings: row.commit_settings ? JSON.parse(row.commit_settings) : { ...DEFAULT_COMMIT_SETTINGS },
    councilSettings: row.council_settings ? JSON.parse(row.council_settings) : null,
    resolutionSettings: row.resolution_settings ? JSON.parse(row.resolution_settings) : { ...DEFAULT_RESOLUTION_SETTINGS },
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
  (SELECT COALESCE(SUM(r.finding_count - (SELECT COUNT(*) FROM finding_imports i WHERE i.report_id = r.id)), 0)
    FROM review_reports r WHERE r.session_id = s.id) AS pending_findings
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
  private savepoints = 0;

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
    // Reports are immutable: their size is stored once so session reads never parse the JSON.
    const reportColumns = this.connection.prepare('PRAGMA table_info(review_reports)').all() as unknown as { name: string }[];
    if (!reportColumns.some((column) => column.name === 'finding_count')) {
      this.connection.exec(`ALTER TABLE review_reports ADD COLUMN finding_count INTEGER NOT NULL DEFAULT 0;
        UPDATE review_reports SET finding_count = json_array_length(data, '$.findings');`);
    }
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS worktree_inventory (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worktree_operations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    // Workspace records survive session deletion so unmerged work is never silently removed.
    this.connection.exec('CREATE TABLE IF NOT EXISTS session_workspaces (session_id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    this.addColumnIfMissing('tasks', 'epic_id', 'TEXT REFERENCES epics(id) ON DELETE SET NULL');
    this.addColumnIfMissing('tasks', 'execution', `TEXT NOT NULL DEFAULT '{"type":"llm"}'`);
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS project_commands (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_results (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_turns (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, started_at INTEGER NOT NULL, ended_at INTEGER, custom_at INTEGER, relayed_at INTEGER, automatic_at INTEGER, automatic_status TEXT);
      CREATE TABLE IF NOT EXISTS epic_runs (id TEXT PRIMARY KEY, epic_id TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS epic_workspaces (epic_id TEXT PRIMARY KEY REFERENCES epics(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
    `);
    const notificationTurnColumns = this.connection.prepare('PRAGMA table_info(notification_turns)').all() as unknown as { name: string }[];
    if (!notificationTurnColumns.some((column) => column.name === 'automatic_status')) this.connection.exec('ALTER TABLE notification_turns ADD COLUMN automatic_status TEXT');
    this.cascadeNotificationTurns();
    this.cascadeEpicRuns();
    // Colonnes générées depuis le JSON : requêtes ciblées et purge sans parser toute la table.
    const generated = (table: string, column: string, path: string): void => {
      const existing = this.connection.prepare(`PRAGMA table_xinfo(${table})`).all() as unknown as { name: string }[];
      if (!existing.some((c) => c.name === column)) this.connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} GENERATED ALWAYS AS (json_extract(data,'${path}')) VIRTUAL`);
    };
    generated('command_runs', 'status', '$.status');
    generated('command_runs', 'finished_at', '$.finishedAt');
    generated('operation_results', 'finished_at', '$.finishedAt');
    generated('operation_results', 'project_id', '$.projectId');
    this.connection.exec(`
      CREATE INDEX IF NOT EXISTS command_runs_task_id ON command_runs(task_id);
      CREATE INDEX IF NOT EXISTS command_runs_status ON command_runs(status);
      CREATE INDEX IF NOT EXISTS command_runs_finished_at ON command_runs(finished_at);
      CREATE INDEX IF NOT EXISTS operation_results_finished_at ON operation_results(finished_at);
      CREATE INDEX IF NOT EXISTS operation_results_project_id ON operation_results(project_id);
    `);
    // Contextes mémorisés avant la vérification complète des historiques : ils seront recontrôlés.
    this.addColumnIfMissing('epic_workspaces', 'verified', 'INTEGER NOT NULL DEFAULT 0');
    this.connection.exec('CREATE INDEX IF NOT EXISTS tasks_epic_id ON tasks(epic_id)');
    this.addColumnIfMissing('sessions', 'protected', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('sessions', 'hook_token', 'TEXT');
    for (const column of ['model', 'effort']) this.addColumnIfMissing('sessions', column, 'TEXT');
    const epicColumns = ['epic_id', 'epic_title'];
    if (epicColumns.some((name) => !this.hasColumn('sessions', name))) {
      // Le schéma et la reprise de l'historique doivent être validés ensemble.
      this.transaction(() => {
        for (const name of epicColumns) this.addColumnIfMissing('sessions', name, 'TEXT');
        this.backfillSessionEpics();
      });
    }
    this.addColumnIfMissing('projects', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('projects', 'workspace_mode', "TEXT NOT NULL DEFAULT 'isolated' CHECK (workspace_mode IN ('isolated','shared'))");
    this.addColumnIfMissing('projects', 'color', 'TEXT');
    if (this.addColumnIfMissing('projects', 'session_defaults', 'TEXT')) {
      // Reprendre les derniers choix à l'installation, sans confondre activité récente et création.
      this.connection.exec(`
        UPDATE projects SET session_defaults = (
          SELECT json_object('agent', agent, 'mode', mode, 'model', model, 'effort', effort, 'prompt', prompt)
          FROM sessions WHERE project_id = projects.id ORDER BY created_at DESC, rowid DESC LIMIT 1
        )
      `);
    }
    if (this.addColumnIfMissing('projects', 'commit_settings', 'TEXT')) {
      this.connection.exec(`UPDATE projects SET commit_settings = json_object(
          'agent', COALESCE(json_extract(session_defaults, '$.agent'), 'claude'),
          'model', json_extract(session_defaults, '$.model'),
          'effort', json_extract(session_defaults, '$.effort'), 'strategy', 'single');`);
    }
    this.addColumnIfMissing('projects', 'resolution_settings', 'TEXT');
    this.connection.exec('CREATE TABLE IF NOT EXISTS automatic_commits (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    this.connection.exec('CREATE TABLE IF NOT EXISTS automatic_commit_requests (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, scope TEXT NOT NULL, push INTEGER NOT NULL)');
    this.connection.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS council_runs (id TEXT PRIMARY KEY, project_id TEXT, data TEXT NOT NULL);`);
    this.addColumnIfMissing('projects', 'council_settings', 'TEXT');
    this.connection.exec(`CREATE TABLE IF NOT EXISTS personas (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER)`);
    this.seedPersonas();
    this.convertLegacyCouncilSettings();
    this.allowAutoMode();
  }

  private hasColumn(table: string, column: string): boolean {
    return (this.connection.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  }

  // Indique si la colonne vient d'être ajoutée, pour reprendre l'historique une seule fois.
  private addColumnIfMissing(table: string, column: string, definition: string): boolean {
    if (this.hasColumn(table, column)) return false;
    this.connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }

  // Une seule fois par base : une persona par défaut supprimée n'est jamais réinsérée.
  private seedPersonas(): void {
    if (this.getSetting('personas_seeded') !== null) return;
    const now = Date.now();
    const insert = this.connection.prepare('INSERT OR IGNORE INTO personas (id, name, description, prompt, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)');
    for (const persona of DEFAULT_PERSONAS) insert.run(persona.id, persona.name, persona.description, persona.prompt, now, now);
    this.putSetting('personas_seeded', true);
  }

  // Réglages enregistrés au format `advisors[]` (conseillers embarqués) : passage au catalogue de personas.
  private convertLegacyCouncilSettings(): void {
    const convert = (raw: unknown): CouncilSettings | null => {
      if (!isLegacyCouncilSettings(raw)) return null;
      const { settings, created } = convertLegacyCouncilSettings(raw, this.listPersonas());
      const insert = this.connection.prepare('INSERT INTO personas (id, name, description, prompt, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)');
      for (const persona of created) insert.run(persona.id, persona.name, persona.description, persona.prompt, persona.createdAt, persona.updatedAt);
      return settings;
    };
    const global = convert(this.getSetting('council'));
    if (global !== null) this.putSetting('council', global);
    const rows = this.connection.prepare('SELECT id, council_settings FROM projects WHERE council_settings IS NOT NULL').all() as { id: string; council_settings: string }[];
    for (const row of rows) {
      const settings = convert(JSON.parse(row.council_settings));
      if (settings !== null) this.connection.prepare('UPDATE projects SET council_settings = ? WHERE id = ?').run(JSON.stringify(settings), row.id);
    }
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

  // Les exécutions d'un epic supprimé disparaissent avec lui ; les anciennes bases sans clé étrangère sont reconstruites et purgées.
  private cascadeEpicRuns(): void {
    const row = this.connection.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'epic_runs'").get() as { sql: string };
    if (!/REFERENCES\s+epics/i.test(row.sql)) this.transaction(() => this.connection.exec(`
      CREATE TABLE epic_runs_new (id TEXT PRIMARY KEY, epic_id TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE, data TEXT NOT NULL);
      INSERT INTO epic_runs_new (rowid, id, epic_id, data) SELECT rowid, id, epic_id, data FROM epic_runs WHERE epic_id IN (SELECT id FROM epics);
      DROP TABLE epic_runs;
      ALTER TABLE epic_runs_new RENAME TO epic_runs;
    `));
    this.connection.exec('CREATE INDEX IF NOT EXISTS epic_runs_epic_id ON epic_runs(epic_id)');
  }

  // Anciennes bases : table sans clé étrangère, une ligne survivait à chaque session supprimée.
  // SQLite ne permet pas d'ajouter une contrainte : on reconstruit la table sans les orphelins.
  private cascadeNotificationTurns(): void {
    if ((this.connection.prepare('PRAGMA foreign_key_list(notification_turns)').all() as unknown[]).length > 0) return;
    this.connection.exec('PRAGMA foreign_keys = OFF');
    try {
      this.connection.exec(`
        BEGIN;
        CREATE TABLE notification_turns_new (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, started_at INTEGER NOT NULL, ended_at INTEGER, custom_at INTEGER, relayed_at INTEGER, automatic_at INTEGER, automatic_status TEXT);
        INSERT INTO notification_turns_new (session_id, started_at, ended_at, custom_at, relayed_at, automatic_at, automatic_status)
          SELECT session_id, started_at, ended_at, custom_at, relayed_at, automatic_at, automatic_status FROM notification_turns
          WHERE session_id IN (SELECT id FROM sessions);
        DROP TABLE notification_turns;
        ALTER TABLE notification_turns_new RENAME TO notification_turns;
        COMMIT;
      `);
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    } finally {
      this.connection.exec('PRAGMA foreign_keys = ON');
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
      this.transaction(() => this.connection.exec(`
        ${sql};
        INSERT INTO sessions_new SELECT * FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS sessions_project_id ON sessions(project_id);
        CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at DESC);
      `));
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

    this.transaction(() => {
      const update = this.connection.prepare('UPDATE projects SET sort_order = ? WHERE id = ?');
      ids.forEach((id, index) => update.run(index, id));
    });
    return this.listProjects();
  }

  getProject(id: string): Project | null {
    const row = this.connection.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined;
    return row === undefined ? null : projectFromRow(row);
  }

  createProject(name: string, path: string, workspaceMode: WorkspaceMode = 'isolated'): Project {
    const project: Project = {
      id: randomUUID(), name, path, color: null, sessionDefaults: { ...DEFAULT_SESSION_DEFAULTS }, commitSettings: { ...DEFAULT_COMMIT_SETTINGS }, councilSettings: null, resolutionSettings: { ...DEFAULT_RESOLUTION_SETTINGS }, workspaceMode, createdAt: Date.now(),
    };
    this.connection.prepare(`INSERT INTO projects (id, name, path, created_at, workspace_mode, sort_order)
      VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects))`)
      .run(project.id, project.name, project.path, project.createdAt, project.workspaceMode);
    return project;
  }

  updateProject(id: string, changes: Partial<Pick<Project, 'name' | 'path' | 'color' | 'sessionDefaults' | 'commitSettings' | 'resolutionSettings' | 'councilSettings' | 'workspaceMode'>>): Project | null {
    const current = this.getProject(id);
    if (current === null) return null;
    const next = { ...current, ...changes };
    this.connection.prepare('UPDATE projects SET name = ?, path = ?, color = ?, session_defaults = ?, commit_settings = ?, resolution_settings = ?, council_settings = ?, workspace_mode = ? WHERE id = ?')
      .run(next.name, next.path, next.color, JSON.stringify(next.sessionDefaults), JSON.stringify(next.commitSettings), JSON.stringify(next.resolutionSettings),
        next.councilSettings === null ? null : JSON.stringify(next.councilSettings), next.workspaceMode, id);
    return next;
  }

  // Réglages globaux de la machine, stockés en JSON par clé.
  getSetting<T>(key: string): T | null {
    const row = this.connection.prepare('SELECT data FROM settings WHERE key = ?').get(key) as { data: string } | undefined;
    return row === undefined ? null : JSON.parse(row.data) as T;
  }

  putSetting(key: string, value: unknown): void {
    this.connection.prepare('INSERT INTO settings (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
      .run(key, JSON.stringify(value));
  }

  listPersonas(): Persona[] {
    return (this.connection.prepare('SELECT * FROM personas ORDER BY created_at, rowid').all() as unknown as PersonaRow[]).map(personaFromRow);
  }

  getPersona(id: string): Persona | null {
    const row = this.connection.prepare('SELECT * FROM personas WHERE id = ?').get(id) as PersonaRow | undefined;
    return row === undefined ? null : personaFromRow(row);
  }

  createPersona(input: PersonaInput): Persona {
    const now = Date.now();
    const persona: Persona = { id: randomUUID(), ...input, builtin: false, createdAt: now, updatedAt: now };
    this.connection.prepare('INSERT INTO personas (id, name, description, prompt, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run(persona.id, persona.name, persona.description, persona.prompt, now, now);
    return persona;
  }

  updatePersona(id: string, changes: Partial<PersonaInput>): Persona | null {
    const current = this.getPersona(id);
    if (current === null) return null;
    const next = { ...current, ...changes, updatedAt: Date.now() };
    this.connection.prepare('UPDATE personas SET name = ?, description = ?, prompt = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.description, next.prompt, next.updatedAt, id);
    return next;
  }

  // Retire aussi la persona des réglages globaux et des surcharges projet ; les runs gardent leur copie.
  deletePersona(id: string): boolean {
    return this.transaction(() => {
      const deleted = Number(this.connection.prepare('DELETE FROM personas WHERE id = ?').run(id).changes) > 0;
      if (deleted) {
        const remaining = this.listPersonas();
        const global = this.getSetting<CouncilSettings>('council');
        if (global !== null) this.putSetting('council', withoutPersona(global, id, remaining));
        const rows = this.connection.prepare('SELECT id, council_settings FROM projects WHERE council_settings IS NOT NULL').all() as { id: string; council_settings: string }[];
        const update = this.connection.prepare('UPDATE projects SET council_settings = ? WHERE id = ?');
        for (const row of rows) update.run(JSON.stringify(withoutPersona(JSON.parse(row.council_settings), id, remaining)), row.id);
      }
      return deleted;
    });
  }

  saveCouncilRun(run: CouncilRun): boolean {
    // Une fin d'appel tardive ne doit jamais recréer un rapport après suppression du projet.
    return Number(this.connection.prepare(`INSERT INTO council_runs (id, project_id, data)
      SELECT ?, ?, ? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = ?)
      ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, data = excluded.data`)
      .run(run.id, run.projectId, JSON.stringify(run), run.projectId, run.projectId).changes) > 0;
  }

  // Les runs enregistrés avant les images jointes n'en ont pas.
  private readCouncilRun(data: string): CouncilRun {
    const run = JSON.parse(data) as CouncilRun;
    run.images ??= [];
    return run;
  }

  getCouncilRun(id: string): CouncilRun | null {
    const row = this.connection.prepare('SELECT data FROM council_runs WHERE id = ?').get(id) as { data: string } | undefined;
    return row === undefined ? null : this.readCouncilRun(row.data);
  }

  // undefined : tous les runs ; null : ceux lancés hors projet. Les plus récents d'abord.
  listCouncilRuns(projectId?: string | null): CouncilRun[] {
    const order = "ORDER BY json_extract(data, '$.startedAt') DESC, rowid DESC";
    const rows = projectId === undefined
      ? this.connection.prepare(`SELECT data FROM council_runs ${order}`).all()
      : projectId === null
        ? this.connection.prepare(`SELECT data FROM council_runs WHERE project_id IS NULL ${order}`).all()
        : this.connection.prepare(`SELECT data FROM council_runs WHERE project_id = ? ${order}`).all(projectId);
    return (rows as { data: string }[]).map((row) => this.readCouncilRun(row.data));
  }

  deleteCouncilRun(id: string): boolean {
    return Number(this.connection.prepare('DELETE FROM council_runs WHERE id = ?').run(id).changes) > 0;
  }

  setSessionDefaults(projectId: string, defaults: SessionDefaults): void {
    this.connection.prepare('UPDATE projects SET session_defaults = ? WHERE id = ?')
      .run(JSON.stringify(defaults), projectId);
  }

  deleteProject(id: string): boolean {
    if (this.listProjectSessions(id).some((session) => session.protected)) {
      throw new SessionProtectionError('Ce projet contient des sessions protégées. Décochez leur protection avant de le supprimer.');
    }
    return this.transaction(() => {
      this.connection.prepare('DELETE FROM council_runs WHERE project_id = ?').run(id);
      this.connection.prepare('DELETE FROM operation_results WHERE project_id = ?').run(id);
      return Number(this.connection.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) > 0;
    });
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
    this.transaction(() => {
      this.connection.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(id);
      const insert = this.connection.prepare('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)');
      for (const dep of new Set(dependsOn)) insert.run(id, dep);
    });
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
    // La tâche et ses dépendances changent ensemble.
    return this.transaction(() => {
      this.connection.prepare('UPDATE tasks SET text = ?, status = ?, session_id = ?, epic_id = ?, updated_at = ?, execution = ? WHERE id = ?')
        .run(next.text, next.status, next.sessionId, next.epicId, next.updatedAt, JSON.stringify(next.execution), id);
      if (changes.dependsOn !== undefined) {
        this.setTaskDependencies(id, changes.dependsOn);
        next.dependsOn = this.taskDependencies(id);
      }
      return next;
    });
  }

  deleteTask(id: string): boolean {
    return Number(this.connection.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes) > 0;
  }

  deleteCompletedBacklog(projectId: string): { taskIds: string[]; epicIds: string[]; dependentIds: string[] } {
    return this.transaction(() => {
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
      return { taskIds, epicIds, dependentIds };
    }, 'IMMEDIATE');
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

  // Valide `fn` d'un bloc, ou rien. Appelé dans une transaction déjà ouverte, il pose un SAVEPOINT :
  // l'échec n'annule que son propre travail et l'appelant décide du sort de l'ensemble.
  // `fn` doit être synchrone, sinon la validation précéderait ses écritures.
  transaction<T>(fn: () => T, mode: 'DEFERRED' | 'IMMEDIATE' = 'DEFERRED'): T {
    const nested = this.connection.isTransaction;
    const savepoint = `cerebro_${++this.savepoints}`;
    this.connection.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`);
    try {
      const result = fn();
      if (result instanceof Promise) throw new TypeError('db.transaction attend une fonction synchrone');
      this.connection.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      // SQLite a pu annuler la transaction de lui-même (disque plein…) : ne pas masquer l'erreur d'origine.
      if (this.connection.isTransaction) this.connection.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }
}
