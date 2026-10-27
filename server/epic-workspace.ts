import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CerebroDatabase } from './db.ts';
import { workspaceAt, type WorkspaceContext, type Workspace } from './provenance.ts';
import { canonicalWorktreePath, assertWorktreeAvailable } from './worktree-gate.ts';

const contextOf = (workspace: Pick<Workspace, 'mode' | 'path'>): WorkspaceContext => ({
  mode: workspace.mode,
  path: workspace.path,
});
const sameContext = (left: WorkspaceContext, right: WorkspaceContext): boolean =>
  left.mode === right.mode && canonicalWorktreePath(left.path) === canonicalWorktreePath(right.path);

export function rememberEpicWorkspace(
  db: CerebroDatabase,
  epicId: string,
  context: WorkspaceContext,
): WorkspaceContext {
  db.connection
    .prepare('INSERT OR IGNORE INTO epic_workspaces (epic_id,data,verified) VALUES (?,?,1)')
    .run(epicId, JSON.stringify(context));
  const saved = JSON.parse(
    (db.connection.prepare('SELECT data FROM epic_workspaces WHERE epic_id=?').get(epicId) as { data: string }).data,
  ) as WorkspaceContext;
  if (!sameContext(saved, context))
    throw new Error('Le dossier de cette étape diffère du dossier d’origine de l’epic. Aucun agent lancé.');
  return saved;
}

// Only the context fields are extracted: full provenance records carry large file manifests.
const CONTEXT_COLUMNS = "json_extract(data,'$.mode') AS mode, json_extract(data,'$.path') AS path";
function sessionContext(db: CerebroDatabase, sessionId: string): WorkspaceContext | null {
  return (
    (db.connection.prepare(`SELECT ${CONTEXT_COLUMNS} FROM session_workspaces WHERE session_id=?`).get(sessionId) as
      WorkspaceContext | undefined) ?? null
  );
}

// Provenance records keep their folder once written (later updates only mark removals): scan them again only when rows change.
const inventories = new WeakMap<
  CerebroDatabase,
  { key: string; contexts: (WorkspaceContext & { canonical: string })[] }
>();
function provenanceContexts(db: CerebroDatabase): (WorkspaceContext & { canonical: string })[] {
  const { total, last } = db.connection
    .prepare('SELECT COUNT(*) AS total, MAX(rowid) AS last FROM session_workspaces')
    .get() as { total: number; last: number | null };
  const key = `${total}:${last}`;
  const cached = inventories.get(db);
  if (cached?.key === key) return cached.contexts;
  const contexts = (
    db.connection
      .prepare(`SELECT ${CONTEXT_COLUMNS} FROM session_workspaces ORDER BY rowid`)
      .all() as unknown as WorkspaceContext[]
  ).map((workspace) => ({ ...contextOf(workspace), canonical: canonicalWorktreePath(workspace.path) }));
  inventories.set(db, { key, contexts });
  return contexts;
}

/** Every folder attested by the epic's runs, sessions and commands, whichever source came first. */
function historyContexts(db: CerebroDatabase, epicId: string): WorkspaceContext[] {
  const epic = db.getEpic(epicId);
  if (!epic) return [];
  const project = db.getProject(epic.projectId)!;
  // Only legacy runs and commands without a known folder need the whole provenance inventory.
  const metadata = () => provenanceContexts(db);
  const at = (path: string): WorkspaceContext | undefined =>
    metadata().find((workspace) => workspace.canonical === canonicalWorktreePath(path));
  const runs = (
    db.connection.prepare('SELECT data FROM epic_runs WHERE epic_id=? ORDER BY rowid').all(epicId) as { data: string }[]
  ).map(
    (row) =>
      JSON.parse(row.data) as {
        workspace?: WorkspaceContext | null;
        contextRoot: string;
        sessionId: string | null;
        commandRunId: string | null;
        status: string;
        results: Record<string, string>;
      },
  );
  const contexts: WorkspaceContext[] = [];
  for (const run of runs) {
    const session = run.sessionId ? sessionContext(db, run.sessionId) : null;
    const established = !!run.commandRunId || Object.keys(run.results).length > 0 || run.status === 'succeeded';
    const owner =
      session ??
      (established || canonicalWorktreePath(run.contextRoot) !== canonicalWorktreePath(project.path)
        ? at(run.contextRoot)
        : undefined);
    if (run.workspace || owner) contexts.push(run.workspace ?? contextOf(owner!));
    else if (established)
      contexts.push({
        path: run.contextRoot,
        mode: canonicalWorktreePath(run.contextRoot) === canonicalWorktreePath(project.path) ? 'shared' : 'isolated',
      });
  }
  // A run may only know its latest step: earlier sessions can have worked elsewhere.
  const sessions = db
    .listSessions()
    .filter((session) => session.projectId === epic.projectId && session.epic?.id === epicId)
    .reverse();
  for (const session of sessions) {
    const workspace = sessionContext(db, session.id);
    if (workspace) contexts.push(contextOf(workspace));
  }
  // A command may have established the context before the first LLM session.
  const commands = (
    db.connection
      .prepare('SELECT r.data FROM command_runs r JOIN tasks t ON t.id=r.task_id WHERE t.epic_id=? ORDER BY r.rowid')
      .all(epicId) as { data: string }[]
  ).map((row) => JSON.parse(row.data) as { cwd: string; command: { cwd: string } });
  for (const run of commands) {
    const ranIn = (root: string): boolean =>
      canonicalWorktreePath(resolve(root, run.command.cwd)) === canonicalWorktreePath(run.cwd);
    const attested = contexts.find((context) => ranIn(context.path));
    const owner = attested
      ? undefined
      : metadata().find((workspace) => workspace.mode === 'isolated' && ranIn(workspace.canonical));
    if (attested) contexts.push(attested);
    else if (owner) contexts.push(contextOf(owner));
    else if (ranIn(project.path)) contexts.push({ path: project.path, mode: 'shared' });
    else
      throw new Error(
        'Le dossier d’origine d’une commande de cet epic ne correspond plus au projet. Vérifiez son emplacement avant de poursuivre.',
      );
  }
  return contexts;
}

export class EpicWorkspaceConflict extends Error {
  constructor(folders: string[]) {
    super(
      `Cet epic a utilisé plusieurs dossiers de travail (${folders.join(', ')}). Vérifiez ses copies puis choisissez le dossier où poursuivre.`,
    );
  }
}

function assertSingleFolder(contexts: WorkspaceContext[]): void {
  const folders = [...new Set(contexts.map((context) => canonicalWorktreePath(context.path)))];
  if (folders.length > 1) throw new EpicWorkspaceConflict(folders);
}

function workspaceChoices(db: CerebroDatabase, epicId: string): WorkspaceContext[] {
  const saved = db.connection.prepare('SELECT data FROM epic_workspaces WHERE epic_id=?').get(epicId) as
    { data: string } | undefined;
  const choices = new Map<string, WorkspaceContext>();
  for (const context of [
    ...(saved ? [JSON.parse(saved.data) as WorkspaceContext] : []),
    ...historyContexts(db, epicId),
  ]) {
    const key = canonicalWorktreePath(context.path);
    if (!choices.has(key) || choices.get(key)!.mode === 'unknown') choices.set(key, contextOf(context));
  }
  return [...choices.values()];
}

export interface EpicWorkspaceChoice extends WorkspaceContext {
  branch: string | null;
  head: string | null;
  changes: string[] | null;
  unavailableReason: string | null;
  sessions: { id: string; title: string }[];
}
export interface EpicWorkspaceOptions {
  conflict: boolean;
  selected: WorkspaceContext | null;
  choices: EpicWorkspaceChoice[];
}
const execFileAsync = promisify(execFile);
async function gitInfo(path: string, args: string[]): Promise<string | null> {
  try {
    return (
      await execFileAsync('git', ['--no-optional-locks', '-C', path, ...args], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout.trimEnd();
  } catch {
    return null;
  }
}

/** Inspect every attested copy without resolving an ambiguous history. */
export async function epicWorkspaceOptions(db: CerebroDatabase, epicId: string): Promise<EpicWorkspaceOptions> {
  let selected: WorkspaceContext | null = null;
  let conflict = false;
  try {
    selected = epicWorkspace(db, epicId);
  } catch (cause) {
    if (!(cause instanceof EpicWorkspaceConflict)) throw cause;
    conflict = true;
  }
  const sessions = db
    .listSessions()
    .filter((session) => session.epic?.id === epicId)
    .map((session) => ({ session, context: sessionContext(db, session.id) }));
  const choices = await Promise.all(
    workspaceChoices(db, epicId).map(async (context) => {
      let unavailableReason: string | null = null;
      try {
        assertEpicWorkspace(db, context);
      } catch (cause) {
        unavailableReason = cause instanceof Error ? cause.message : String(cause);
      }
      const [branch, head, status] = unavailableReason
        ? [null, null, null]
        : await Promise.all([
            gitInfo(context.path, ['branch', '--show-current']),
            gitInfo(context.path, ['rev-parse', '--verify', 'HEAD']),
            gitInfo(context.path, ['status', '--porcelain', '--untracked-files=normal']),
          ]);
      return {
        ...context,
        branch: branch || null,
        head,
        changes: status === null ? null : status ? status.split('\n') : [],
        unavailableReason,
        sessions: sessions
          .filter(
            (item) => item.context && canonicalWorktreePath(item.context.path) === canonicalWorktreePath(context.path),
          )
          .map(({ session }) => ({
            id: session.id,
            title: session.title ?? session.prompt.split('\n')[0] ?? 'Session',
          })),
      };
    }),
  );
  return { conflict, selected, choices };
}

/** An explicit choice is authoritative for future steps; it never moves files or rewrites execution history. */
export function selectEpicWorkspace(db: CerebroDatabase, epicId: string, path: string): WorkspaceContext {
  const saved = db.connection.prepare('SELECT data,verified FROM epic_workspaces WHERE epic_id=?').get(epicId) as
    { data: string; verified: number } | undefined;
  if (saved?.verified) {
    const context = JSON.parse(saved.data) as WorkspaceContext;
    if (canonicalWorktreePath(context.path) !== canonicalWorktreePath(path))
      throw new Error('Le dossier de cet epic est déjà fixé.');
    assertEpicWorkspace(db, context);
    return context;
  }
  const context = workspaceChoices(db, epicId).find(
    (choice) => canonicalWorktreePath(choice.path) === canonicalWorktreePath(path),
  );
  if (!context) throw new Error('Choisissez un dossier attesté dans l’historique de cet epic.');
  assertEpicWorkspace(db, context);
  db.connection
    .prepare(
      'INSERT INTO epic_workspaces (epic_id,data,verified) VALUES (?,?,1) ON CONFLICT(epic_id) DO UPDATE SET data=excluded.data,verified=1',
    )
    .run(epicId, JSON.stringify(context));
  return context;
}

/** Recover old epics from persisted execution/provenance, never from the project's current preference. */
export function epicWorkspace(db: CerebroDatabase, epicId: string): WorkspaceContext | null {
  const saved = db.connection.prepare('SELECT data,verified FROM epic_workspaces WHERE epic_id=?').get(epicId) as
    { data: string; verified: number } | undefined;
  if (saved?.verified) return JSON.parse(saved.data) as WorkspaceContext;
  const contexts = historyContexts(db, epicId);
  if (saved) {
    // Remembered by an earlier, incomplete recovery: it only becomes authoritative once the whole history agrees.
    const context = JSON.parse(saved.data) as WorkspaceContext;
    assertSingleFolder([context, ...contexts]);
    db.connection.prepare('UPDATE epic_workspaces SET verified=1 WHERE epic_id=?').run(epicId);
    return context;
  }
  if (!contexts.length) return null;
  assertSingleFolder(contexts);
  return rememberEpicWorkspace(db, epicId, contexts.find((context) => context.mode !== 'unknown') ?? contexts[0]);
}

export function assertEpicWorkspace(db: CerebroDatabase, context: WorkspaceContext): void {
  if (context.mode === 'isolated' && !workspaceAt(db, context.path))
    throw new Error('Le worktree de l’epic est introuvable ou a été retiré : impossible de poursuivre son travail.');
  try {
    if (!statSync(context.path).isDirectory()) throw new Error();
  } catch {
    throw new Error(
      `Le ${context.mode === 'isolated' ? 'worktree' : 'dossier de travail'} de l’epic est introuvable : impossible de poursuivre son travail.`,
    );
  }
  assertWorktreeAvailable(context.path);
}

// Only preparation is serialized; an established workspace is shared by the epic's steps.
const preparations = new WeakMap<CerebroDatabase, Map<string, Promise<unknown>>>();
export async function withEpicWorkspace<T>(db: CerebroDatabase, epicId: string, action: () => Promise<T>): Promise<T> {
  let pending = preparations.get(db);
  if (!pending) {
    pending = new Map();
    preparations.set(db, pending);
  }
  const previous = pending.get(epicId) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(action);
  pending.set(epicId, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(epicId) === operation) pending.delete(epicId);
  }
}
