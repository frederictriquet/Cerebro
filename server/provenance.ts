import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DATA_DIR } from './config.ts';
import type { CerebroDatabase } from './db.ts';
import { rememberWorktree } from './worktrees.ts';
import { reflogHistoryKnown } from './git-reflog.ts';
import { canonicalWorktreePath } from './worktree-gate.ts';
import type { GitPlanner } from './git-plan.ts';
import { inScope, workspaceManifest } from './workspace-files.ts';
import { git as runGit, repositoryRoot, splitZ, type GitOptions } from './git.ts';
import type { Project } from '../shared/types.ts';
import type { GitSnapshot, Provenance, Workspace, WorkspaceContext } from '../shared/git.ts';
const git = async (path: string, args: string[], options?: GitOptions): Promise<string> =>
  (await runGit(path, args, options)).trim();
export function workspaceFor(db: CerebroDatabase, id: string): Workspace | null {
  const row = db.connection.prepare('SELECT data FROM session_workspaces WHERE session_id=?').get(id) as
    { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Workspace) : null;
}
/** Every recorded workspace, by session, read in one query. */
export function sessionWorkspaces(db: CerebroDatabase): Map<string, Workspace> {
  const rows = db.connection.prepare('SELECT session_id, data FROM session_workspaces').all() as {
    session_id: string;
    data: string;
  }[];
  return new Map(rows.map((row) => [row.session_id, JSON.parse(row.data) as Workspace]));
}
function save(db: CerebroDatabase, workspace: Workspace): Workspace {
  db.connection
    .prepare('INSERT INTO session_workspaces (session_id, data) VALUES (?,?)')
    .run(workspace.sessionId, JSON.stringify(workspace));
  return workspace;
}
const signature = (m: Record<string, string>): string => JSON.stringify(m);
function firstDifference(a: Record<string, string>, b: Record<string, string>): string {
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[name] !== b[name]) return name;
  return 'inconnue';
}
/** Where the content copied from the project at the creation of `sessionId`'s copy is kept. */
export const startingCopyDirectory = (sessionId: string): string => join(DATA_DIR, 'starting', sessionId);
/**
 * Keeps the content copied from the project, so it can still be separated from the conversation's
 * work once the project has changed. Best effort: a copy without it only loses that separation.
 * Plain files outside the repository, never Git objects: untracked files (.env, keys, dumps) would
 * otherwise stay in the shared object database, reachable by a ref and pushed by a mirror.
 */
async function snapshotStartingContent(
  workspace: string,
  sessionId: string,
  paths: string[],
): Promise<string | undefined> {
  if (!paths.length) return undefined;
  const target = startingCopyDirectory(sessionId);
  try {
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const path of paths) {
      // Deleted files and links have no content to restore: their baseline signature is never looked up.
      if (!(await lstat(join(workspace, path)).catch(() => null))?.isFile()) continue;
      await mkdir(dirname(join(target, path)), { recursive: true });
      await copyFile(join(workspace, path), join(target, path));
    }
    return target;
  } catch {
    await rm(target, { recursive: true, force: true });
    return undefined;
  }
}
/** Uncommitted files of a working tree: changed since HEAD, staged, untracked. */
async function localChanges(root: string): Promise<{ dirty: string[]; staged: string[]; untracked: string[] }> {
  const dirty = splitZ(await git(root, ['diff', '--name-only', '-z', 'HEAD']));
  const staged = splitZ(await git(root, ['diff', '--cached', '--name-only', '-z']));
  const untracked = splitZ(await git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  return { dirty, staged, untracked };
}
const SHARED_DEPENDENCY_DIRS = new Set(['node_modules', '.venv', 'venv', 'vendor']);
// The code knowledge graph at the root is copied, not shared: an agent refreshing its copy's graph
// must not rewrite the source's. The scan-root marker holds the source's absolute path; without it,
// graphify resolves the root from the copy itself. Removing the copy discards it (REGENERABLE_DIRS).
const COPIED_INDEX_DIRS = new Set(['graphify-out']);
const INDEX_ROOT_MARKER = '.graphify_root';

async function copyEntry(sourceRoot: string, targetRoot: string, name: string): Promise<void> {
  const source = join(sourceRoot, name);
  const target = join(targetRoot, name);
  await rm(target, { recursive: true, force: true });
  try {
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, dereference: false, verbatimSymlinks: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
}

/** Brings the project's ignored files into a copy and links its dependency directories: returns the linked ones. */
export async function copyIgnoredContext(sourceRoot: string, targetRoot: string): Promise<string[]> {
  const ignored = splitZ(
    await git(sourceRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']),
  );
  const shared: string[] = [];
  for (const raw of ignored) {
    const name = raw.replace(/\/$/, '');
    if (!name) continue;
    const source = join(sourceRoot, name);
    const target = join(targetRoot, name);
    const stat = await lstat(source).catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw cause;
    });
    if (!stat) continue;
    if (stat.isDirectory()) {
      if (SHARED_DEPENDENCY_DIRS.has(basename(name))) {
        await mkdir(dirname(target), { recursive: true });
        await rm(target, { recursive: true, force: true });
        await symlink(source, target, 'dir');
        shared.push(name);
      } else if (COPIED_INDEX_DIRS.has(name)) {
        await mkdir(dirname(target), { recursive: true });
        await rm(target, { recursive: true, force: true });
        await cp(source, target, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          filter: (path) => basename(path) !== INDEX_ROOT_MARKER,
        });
      }
      // Other ignored directories are normally generated output or caches. Copying an
      // unbounded tree here would recreate the startup problem this path is avoiding.
      continue;
    }
    await copyEntry(sourceRoot, targetRoot, name);
  }
  return shared;
}

/** Isolation is persisted before launching the holder. Historical sessions keep their cwd. */
export async function createWorkspace(db: CerebroDatabase, sessionId: string, project: Project): Promise<Workspace> {
  const registeredProject = db.getProject(project.id) ?? project;
  if (registeredProject.workspaceMode === 'shared')
    return save(db, await sharedWorkspace(sessionId, registeredProject));
  const common: Workspace = {
    sessionId,
    projectId: project.id,
    projectName: project.name,
    mode: 'unknown',
    path: project.path,
    root: project.path,
    source: project.path,
    base: null,
    branch: null,
    initialDirty: [],
    baseline: {},
    reason: 'Projet sans historique Git : sélection explicite nécessaire.',
    createdAt: Date.now(),
  };
  let root: string;
  try {
    root = await repositoryRoot(project.path);
    common.base = await git(root, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    return save(db, common);
  }
  common.projectRoot =
    registeredProject.path === project.path ? root : await repositoryRoot(registeredProject.path).catch(() => root);
  common.targetBranch = await git(common.projectRoot, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => null);
  const physicalRoot = canonicalWorktreePath(root);
  await assertIsolable(root, physicalRoot);
  const state = await projectState(root);
  const branch = `cerebro/session-${sessionId}`;
  const workspace = join(DATA_DIR, 'workspaces', sessionId);
  await mkdir(join(DATA_DIR, 'workspaces'), { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), 'cerebro-isolate-'));
  let added = false;
  try {
    const sourceIndex = join(temporary, 'source-index');
    await writeFile(sourceIndex, state.index);
    const tree = await git(root, ['write-tree'], { index: sourceIndex });
    await git(root, ['worktree', 'add', '-b', branch, '--', workspace, common.base!]);
    added = true;
    const sharedIgnored = await populateCopy(root, workspace, tree, [...state.dirty, ...state.untracked]);
    await assertProjectUnchanged(root, common.base!, state);
    const baseline = await workspaceManifest(workspace, sharedIgnored);
    if (signature(state.manifest) !== signature(baseline))
      throw new Error(
        `Copie initiale non identique (${firstDifference(state.manifest, baseline)}) : aucun agent lancé.`,
      );
    const dependencyNotice = sharedIgnored.length
      ? ` Dépendances partagées avec le projet source : ${sharedIgnored.join(', ')}.`
      : '';
    const initialDirty = [...new Set([...state.dirty, ...state.staged, ...state.untracked])];
    const startingCopy = await snapshotStartingContent(workspace, sessionId, initialDirty);
    const saved = save(db, {
      ...common,
      mode: 'isolated',
      root: workspace,
      path: join(workspace, relative(physicalRoot, canonicalWorktreePath(project.path))),
      source: root,
      branch,
      baseline,
      ...(startingCopy ? { startingCopy } : {}),
      sharedIgnored,
      initialDirty,
      reason: `Périmètre de l’espace isolé ; les auteurs des éditions dans cet espace ne sont pas identifiables.${dependencyNotice}`,
    });
    await rememberWorktree(db, saved);
    return saved;
  } catch (cause) {
    if (added) await discardCopy(root, workspace, branch, sessionId);
    throw cause;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** A project set to work in its own folder: the conversation uses its current branch, without a copy. */
async function sharedWorkspace(sessionId: string, project: Project): Promise<Workspace> {
  const root = await repositoryRoot(project.path).catch(() => project.path);
  return {
    sessionId,
    projectId: project.id,
    projectName: project.name,
    projectRoot: root,
    mode: 'shared',
    path: project.path,
    root,
    source: root,
    base: null,
    branch: null,
    initialDirty: [],
    baseline: {},
    reason:
      'Dossier du projet choisi dans l’en-tête du projet : les conversations utilisent la branche courante, sans création de copie ni attribution individuelle des changements.',
    createdAt: Date.now(),
  };
}

async function assertIsolable(root: string, physicalRoot: string): Promise<void> {
  // Physical paths on both sides: a symlink must neither smuggle the data directory into the
  // repository nor move the session directory outside the copy.
  const dataDir = canonicalWorktreePath(DATA_DIR);
  if (dataDir.startsWith(`${physicalRoot}/`) || dataDir === physicalRoot)
    throw new Error('Le dossier Cerebro doit être situé hors du dépôt pour isoler les sessions.');
  if ((await git(root, ['ls-files', '--stage'])).split('\n').some((line) => line.startsWith('160000 ')))
    throw new Error('Isolation des sous-modules non prise en charge : aucun agent lancé.');
  if (await git(root, ['ls-files', '-u']))
    throw new Error('Résolvez les conflits de l’index avant de lancer une session isolée.');
}

/** The project as the copy reproduces it: its files, its index and its local changes. */
interface ProjectState {
  manifest: Record<string, string>;
  indexPath: string;
  index: Buffer;
  dirty: string[];
  staged: string[];
  untracked: string[];
}
async function projectState(root: string): Promise<ProjectState> {
  const before = await workspaceManifest(root);
  const indexPath = resolve(root, await git(root, ['rev-parse', '--git-path', 'index']));
  const index = await readFile(indexPath);
  return { manifest: before, indexPath, index, ...(await localChanges(root)) };
}

/**
 * Recreates the project's indexed tree in the new worktree, then overlays only Git-visible local changes. Large
 * dependency directories are shared as links instead of physically copying and hashing them: returns them.
 */
async function populateCopy(root: string, workspace: string, tree: string, changed: string[]): Promise<string[]> {
  for (const name of await readdir(workspace))
    if (name !== '.git') await rm(join(workspace, name), { recursive: true, force: true });
  await git(workspace, ['read-tree', tree]);
  await git(workspace, ['checkout-index', '--all', '--force']);
  for (const name of new Set(changed)) await copyEntry(root, workspace, name);
  return copyIgnoredContext(root, workspace);
}

async function assertProjectUnchanged(root: string, base: string, state: ProjectState): Promise<void> {
  if (
    base !== (await git(root, ['rev-parse', 'HEAD'])) ||
    !state.index.equals(await readFile(state.indexPath)) ||
    signature(state.manifest) !== signature(await workspaceManifest(root))
  )
    throw new Error('Le projet a changé pendant son isolation : relancez la session.');
}

/** Removes a copy whose creation failed, with its branch and its starting content. */
async function discardCopy(root: string, workspace: string, branch: string, sessionId: string): Promise<void> {
  await git(root, ['worktree', 'remove', '--force', workspace]).catch(() => {});
  await git(root, ['branch', '-D', branch]).catch(() => {});
  await rm(startingCopyDirectory(sessionId), { recursive: true, force: true });
}

/** The live isolated copy whose session directory is `path`, if Cerebro created one there. */
export function workspaceAt(db: CerebroDatabase, path: string): Workspace | null {
  const target = canonicalWorktreePath(path);
  return (
    [...sessionWorkspaces(db).values()]
      .filter(
        (workspace) =>
          workspace.mode === 'isolated' && !workspace.removedAt && canonicalWorktreePath(workspace.path) === target,
      )
      .sort((left, right) => left.createdAt - right.createdAt)[0] ?? null
  );
}

/** Later epic steps work in the copy of the first one: one branch, one integration for the whole epic. */
export async function joinWorkspace(db: CerebroDatabase, sessionId: string, owner: Workspace): Promise<Workspace> {
  const excluded = owner.sharedIgnored ?? [];
  const { dirty, staged, untracked } = await localChanges(owner.root);
  // Work left by previous steps is inherited, exactly like changes present in a project at copy creation.
  return save(db, {
    ...owner,
    sessionId,
    baseline: await workspaceManifest(owner.root, excluded),
    initialDirty: [...new Set([...dirty, ...staged, ...untracked])].filter((name) => inScope(name, excluded)),
    reason: `${owner.reason} Copie partagée avec les étapes précédentes de l’epic.`,
    createdAt: Date.now(),
  });
}

/** A started epic keeps its original location even when the project preference changes. */
export async function createWorkspaceInContext(
  db: CerebroDatabase,
  sessionId: string,
  project: Project,
  context: WorkspaceContext,
): Promise<Workspace> {
  if (context.mode === 'isolated') {
    const owner = workspaceAt(db, context.path);
    if (!owner || (owner.projectId && owner.projectId !== project.id))
      throw new Error('Le worktree d’origine de l’epic est introuvable dans ce projet.');
    return joinWorkspace(db, sessionId, owner);
  }
  const root = await repositoryRoot(context.path).catch(() => context.path);
  return save(db, {
    sessionId,
    projectId: project.id,
    projectName: project.name,
    projectRoot: root,
    mode: context.mode,
    path: context.path,
    root,
    source: root,
    base: null,
    branch: null,
    initialDirty: [],
    baseline: {},
    reason: 'Dossier d’origine de l’epic, conservé indépendamment du réglage des nouvelles conversations.',
    createdAt: Date.now(),
  });
}

export function historicalWorkspace(sessionId: string, path: string): Workspace {
  return {
    sessionId,
    mode: 'unknown',
    path,
    root: path,
    source: path,
    base: null,
    branch: null,
    initialDirty: [],
    baseline: {},
    reason: 'Session historique sans provenance : sélection explicite nécessaire.',
    createdAt: 0,
  };
}

/**
 * Files touched by each commit, in a single Git run whatever the branch length: one process per
 * commit would spawn hundreds of them at once on a long branch. Merges are left out by diff-tree.
 */
async function pathsByCommit(root: string, oids: string[]): Promise<Map<string, string[]>> {
  const paths = new Map<string, string[]>();
  if (!oids.length) return paths;
  const expected = new Set(oids);
  let current: string[] | undefined;
  const output = await runGit(root, ['diff-tree', '--stdin', '-r', '--name-only', '-z'], {
    input: `${oids.join('\n')}\n`,
  });
  // Each commit header is its own NUL-terminated record, followed by the paths it changed.
  for (const token of output.split('\0')) {
    if (!token) continue;
    if (expected.has(token) && !paths.has(token)) {
      current = [];
      paths.set(token, current);
    } else current?.push(token);
  }
  return paths;
}

/** The workspace recorded for a session, or the project folder of a session older than workspaces. */
export function sessionWorkspace(db: CerebroDatabase, sessionId: string): Workspace {
  const session = db.getSession(sessionId);
  if (!session) throw new Error('Session introuvable.');
  return workspaceFor(db, sessionId) ?? historicalWorkspace(sessionId, db.getProject(session.projectId)!.path);
}

/** `snapshot`, when given, is a commit snapshot of this session's workspace just prepared by the caller: it is not collected again. */
export async function sessionProvenance(
  db: CerebroDatabase,
  planner: GitPlanner,
  sessionId: string,
  snapshot?: GitSnapshot,
): Promise<Provenance> {
  const workspace = sessionWorkspace(db, sessionId);
  const warning =
    'Le périmètre décrit un espace de travail, pas l’auteur des modifications. Toute édition humaine ou externe dans cet espace doit être vérifiée explicitement. Les changements initiaux ne sont pas attribués à la session.';
  if (workspace.mode !== 'isolated') return { workspace, changes: [], commits: [], warning };
  snapshot ??= await planner.prepareCommit(workspace.root, workspace);
  const excluded = workspace.sharedIgnored ?? [];
  const collected = planner.snapshotManifest(snapshot.id);
  const current = collected
    ? Object.fromEntries(Object.entries(collected).filter(([name]) => inScope(name, excluded)))
    : await workspaceManifest(workspace.root, excluded);
  const changed = snapshot.files.filter((f) => workspace.baseline[f.path] !== current[f.path]);
  const branchMatches = await git(workspace.root, ['symbolic-ref', '--short', 'HEAD']).then(
    (branch) => branch === workspace.branch,
    () => false,
  );
  const reflog = await git(workspace.root, ['reflog', 'show', '--format=%gs', workspace.branch!]).catch(() => '');
  const historyKnown = reflogHistoryKnown(reflog);
  const valid =
    branchMatches &&
    historyKnown &&
    (await git(workspace.root, ['merge-base', '--is-ancestor', workspace.base!, 'HEAD']).then(
      () => true,
      () => false,
    ));
  const records = valid
    ? (await git(workspace.root, ['log', '--first-parent', '--format=%H %P%x09%s', `${workspace.base}..HEAD`]))
        .split('\n')
        .filter(Boolean)
    : [];
  const commitPaths = await pathsByCommit(
    workspace.root,
    records.map((line) => line.slice(0, line.indexOf(' '))),
  );
  return {
    workspace: { ...workspace, baseline: {} },
    warning: valid ? warning : `${warning} L’historique de base a changé : attribution incertaine.`,
    changes: changed.map((f) => ({
      path: f.path,
      certainty:
        valid && !workspace.initialDirty.includes(f.path) && !workspace.baseline[f.path]?.startsWith('link:')
          ? 'workspace'
          : 'uncertain',
      reason: workspace.initialDirty.includes(f.path)
        ? 'Fichier modifié avant la session : sélection manuelle des hunks nécessaire.'
        : 'Modification dans l’espace isolé ; auteur non garanti.',
    })),
    commits: records.map((line) => {
      const [ids, ...title] = line.split('\t');
      const [oid, ...parents] = ids.split(' ');
      const paths = commitPaths.get(oid) ?? [];
      return {
        hash: oid,
        title: title.join('\t'),
        certainty:
          parents.length !== 1 || paths.some((p) => workspace.initialDirty.includes(p))
            ? ('uncertain' as const)
            : ('workspace' as const),
      };
    }),
  };
}
