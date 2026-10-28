import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { CerebroDatabase } from './db.ts';
import { runGit } from './git-process.ts';
import { sharedDependencyLinks } from './git-plan.ts';
import { mergeCommitReflog } from './git-reflog.ts';
import type { Services } from './services.ts';
import { canonicalWorktreePath, pathWithin } from './worktree-gate.ts';
import { repositoryActivity, sessionBusy, type RepositoryActivity } from './repository-activity.ts';
import { sessionWorkspaces, workspaceFor } from './provenance.ts';
import { regularFileSignature, workspaceFileSignature } from './workspace-files.ts';
import { branchLabel, git, GitError, gitEnv, parseStatusZ, repositoryRoot, splitZ } from './git.ts';
import type {
  AutomaticCleanup,
  PreparedWorktreeOperation,
  StartingContent,
  StartingContentDiscard,
  StartingContentPlan,
  StartingContentStep,
  StartingOrigin,
  WorktreeInventory,
  WorktreeOperation,
  WorktreeRecord,
  WorktreeView,
} from '../shared/worktrees.ts';
import type { Workspace } from '../shared/git.ts';
import { errorMessage } from './util.ts';
import { isActiveRun } from '../shared/backlog.ts';

const gitBytes = (path: string, args: string[]): Promise<Buffer> =>
  git(path, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const mergeRef = (operationId: string): string => `refs/cerebro/merges/${operationId}`;
let mergeTreeSupport: Promise<boolean> | null = null;
/** Whether `git merge-tree --write-tree` (Git 2.38) is available: the merge machinery itself, without a worktree. */
function mergeTreeAvailable(): Promise<boolean> {
  return (mergeTreeSupport ??= runGit(['version']).then(
    (result) => {
      const [major, minor] = (/(\d+)\.(\d+)/.exec(result.stdout.toString('utf8')) ?? []).slice(1).map(Number);
      return major > 2 || (major === 2 && minor >= 38);
    },
    () => false,
  ));
}
/** Shown with the conflict forecast when Git is too old to simulate the merge itself. */
const APPROXIMATE_FORECAST =
  'Prévision approchée (Git antérieur à 2.38) : les renommages de dossiers et les fichiers renommés des deux côtés ne sont pas suivis.';
/**
 * Commits the merge of the target into a copy, with the hooks and Git configuration of any other commit. A refusal
 * leaves the merge in progress in the copy: it is finished once the cause is fixed, or abandoned.
 */
async function commitTargetUpdate(path: string): Promise<void> {
  try {
    await git(path, ['commit', '--no-edit']);
  } catch (cause) {
    const detail = (cause as { stderr?: string }).stderr?.trim() || errorMessage(cause);
    throw new WorktreeError(
      `Git a refusé le commit de la mise à jour (hook ou configuration) : ${detail}\nLa mise à jour reste en cours dans la copie : corrigez la cause puis terminez-la, ou annulez-la.`,
    );
  }
}
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export class WorktreeError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 409) {
    super(message);
    this.statusCode = statusCode;
  }
}
interface RegisteredWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
}
/** A kept file the user checked: it only holds the conversation's work, as long as its content stays `version`. */
export interface StartingConfirmation {
  path: string;
  version: string;
}
/** One dirty file of the plan. `write` is its final content (null: absent); undefined leaves the file untouched. */
interface PlannedFile {
  path: string;
  signature: string | undefined;
  current: Buffer | null;
  next: Buffer | null;
  write?: Buffer | null;
  step: StartingContentStep | null;
}
interface TargetMerge {
  tree: string;
  commits: number;
  read: (file: string) => Promise<Buffer | null>;
}
type SimulatedMerge = TargetMerge | { conflicts: string[] };
interface PlannedStarting {
  files: PlannedFile[];
  merge: TargetMerge | null;
}

function records(db: CerebroDatabase): WorktreeRecord[] {
  return (db.connection.prepare('SELECT data FROM worktree_inventory ORDER BY rowid').all() as { data: string }[]).map(
    (row) => JSON.parse(row.data),
  );
}
function store(db: CerebroDatabase, record: WorktreeRecord): void {
  db.connection
    .prepare('INSERT INTO worktree_inventory VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
    .run(record.id, JSON.stringify(record));
}
const CLEANED_SHOWN = 20;
const worktreeId = (common: string, path: string): string => hash(`${common}\0${path}`).slice(0, 32);
async function commonDirectory(path: string): Promise<string> {
  return realpath(resolve(path, (await git(path, ['rev-parse', '--git-common-dir'])).trim()));
}
/**
 * Persist identity while the session/project still exist. No foreign key cascades this record. A copy already
 * gone from disk fails, unless `missing` is 'removed': it is then recorded as removed and its removal date returned.
 */
export async function rememberWorktree(
  db: CerebroDatabase,
  workspace: Workspace,
  missing: 'fail' | 'removed' = 'fail',
): Promise<number | null> {
  if (workspace.mode !== 'isolated' || workspace.removedAt) return null;
  const commonDir = await commonDirectory(workspace.root).catch(() =>
    commonDirectory(workspace.projectRoot ?? workspace.source),
  );
  let removedAt: number | null = null;
  const path = await realpath(workspace.root).catch(async (cause: NodeJS.ErrnoException) => {
    if (missing !== 'removed' || cause.code !== 'ENOENT') throw cause;
    removedAt = Date.now();
    return join(
      await realpath(dirname(workspace.root)).catch(() => resolve(dirname(workspace.root))),
      basename(workspace.root),
    );
  });
  const id = worktreeId(commonDir, path);
  const session = db.getSession(workspace.sessionId);
  const project = session ? db.getProject(session.projectId) : null;
  const source =
    workspace.projectRoot ??
    (project ? await repositoryRoot(project.path).catch(() => workspace.source) : workspace.source);
  const target =
    workspace.targetBranch ??
    (await git(source, ['symbolic-ref', '--quiet', 'HEAD']).then(
      (text) => text.trim(),
      () => null,
    ));
  // Discovery may see Git's worktree before its workspace provenance is saved.
  // Upgrade that provisional record, but preserve registered identities and targets.
  // Read after the awaits so concurrent registration cannot be overwritten.
  const previous = records(db).find((record) => record.id === id);
  if (previous?.managed || previous?.removedAt) return previous.removedAt;
  store(db, {
    id,
    commonDir,
    path,
    source,
    projectId: workspace.projectId ?? project?.id ?? null,
    projectName: workspace.projectName ?? project?.name ?? basename(source),
    sessionId: workspace.sessionId,
    sessionTitle: session?.title ?? null,
    managed: true,
    expectedBranch: workspace.branch ? `refs/heads/${workspace.branch}` : null,
    targetBranch: target,
    sharedIgnored: workspace.sharedIgnored,
    createdAt: workspace.createdAt,
    removedAt,
    ...(project ? { commitSettings: project.commitSettings } : {}),
  });
  return removedAt;
}

/** Keep the final labels and repository association before session/project deletion. */
export async function archiveSessionWorktree(db: CerebroDatabase, id: string): Promise<void> {
  const workspace = workspaceFor(db, id);
  if (!workspace || workspace.mode !== 'isolated' || workspace.removedAt) return;
  // A copy deleted or moved outside Cerebro before being inventoried must not make its conversation undeletable.
  if (!records(db).some((record) => record.sessionId === id)) {
    const removedAt = await rememberWorktree(db, workspace, 'removed');
    if (removedAt) {
      workspace.removedAt = removedAt;
      db.connection
        .prepare('UPDATE session_workspaces SET data=? WHERE session_id=?')
        .run(JSON.stringify(workspace), id);
    }
  }
  const inventory = records(db);
  const session = db.getSession(id);
  for (const record of inventory.filter((r) => r.sessionId === id)) {
    const project = session ? db.getProject(session.projectId) : null;
    if (session) {
      record.sessionTitle = session.title;
      record.projectId = session.projectId;
    }
    if (project) {
      record.projectName = project.name;
      record.commitSettings = project.commitSettings;
    }
    store(db, record);
  }
}

// Git 2.34 has no `worktree list -z`. Decode its quoted porcelain paths without shell parsing.
function decodePath(path: string): string {
  if (!path.startsWith('"')) return path;
  const pieces: Buffer[] = [];
  const escapes: Record<string, string> = {
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    '"': '"',
  };
  for (let i = 1; i < path.length - 1;) {
    if (path[i] !== '\\') {
      const point = String.fromCodePoint(path.codePointAt(i)!);
      pieces.push(Buffer.from(point));
      i += point.length;
      continue;
    }
    i++;
    const octal = /^[0-7]{1,3}/.exec(path.slice(i));
    if (octal) {
      pieces.push(Buffer.from([parseInt(octal[0], 8)]));
      i += octal[0].length;
    } else {
      pieces.push(Buffer.from(escapes[path[i]] ?? path[i]));
      i++;
    }
  }
  return Buffer.concat(pieces).toString('utf8');
}
async function registered(path: string): Promise<RegisteredWorktree[]> {
  const output = await git(path, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain']);
  return output
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const rawPath = lines.find((line) => line.startsWith('worktree '));
      if (!rawPath) throw new WorktreeError('Inventaire Git illisible.');
      return {
        path: canonicalWorktreePath(decodePath(rawPath.slice(9))),
        head: lines.find((line) => line.startsWith('HEAD '))?.slice(5) ?? null,
        branch: lines.find((line) => line.startsWith('branch '))?.slice(7) ?? null,
        locked: lines.some((line) => /^locked(?: |$)/.test(line)),
        prunable: lines.some((line) => /^prunable(?: |$)/.test(line)),
      };
    });
}
/**
 * Ignored directories that a reinstall or a build recreates: dependencies and build outputs or caches. Only
 * at the root of the copy: deeper, a `data/build/` may hold anything. Listed in the README.
 */
const REGENERABLE_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  'vendor',
  'dist',
  'build',
  '.vite',
  '.next',
  'coverage',
  '__pycache__',
  '.cache',
]);
/**
 * An ignored entry has nothing to lose when it is a link to the same path of the source project, a
 * file identical to that path there (e.g. `.claude/settings.local.json` written by the agent), a
 * regenerable directory at the root of the copy, or a path the project declares regenerable (`declared`, e.g.
 * `web/dist`). Another directory qualifies only if every entry below it does, within a small bound.
 */
async function disposableIgnored(
  root: string,
  source: string,
  name: string,
  declared: ReadonlySet<string>,
  budget = { entries: 200 },
): Promise<boolean> {
  if (--budget.entries < 0) return false;
  const path = join(root, name);
  const stat = await lstat(path).catch(() => null);
  if (!stat) return false;
  if (declared.has(name)) return true;
  if (stat.isSymbolicLink()) return resolve(dirname(path), await readlink(path)) === resolve(source, name);
  if (stat.isDirectory()) {
    if (dirname(name) === '.' && REGENERABLE_DIRS.has(name)) return true;
    for (const entry of await readdir(path))
      if (!(await disposableIgnored(root, source, join(name, entry), declared, budget))) return false;
    return true;
  }
  if (!stat.isFile()) return false;
  const original = await workspaceFileSignature(join(source, name)).catch(() => undefined);
  return original !== undefined && original === (await workspaceFileSignature(path));
}
/** Unified diff of one file between two contents, labelled with its repository path. */
async function contentDiff(
  cwd: string,
  file: string,
  before: Buffer | null,
  after: Buffer | null,
  temporary: string,
): Promise<string> {
  const left = join(temporary, 'diff-before');
  const right = join(temporary, 'diff-after');
  await writeFile(left, before ?? '');
  await writeFile(right, after ?? '');
  try {
    await git(cwd, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', left, right]);
    return '';
  } catch (cause) {
    const failure = cause as { code?: unknown; stdout?: unknown };
    if (failure.code !== 1 || typeof failure.stdout !== 'string') throw cause;
    const hunks = failure.stdout.slice(Math.max(0, failure.stdout.indexOf('\n@@') + 1));
    return `--- a/${file}\n+++ b/${file}\n${hunks}`;
  }
}
/**
 * Lines a diff adds and removes. Lines without a letter or digit (blank lines, braces) are ignored: too common to
 * tell two changes apart.
 */
function diffLines(diff: string): { added: Set<string>; removed: Set<string> } {
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const line of diff.split('\n').slice(2)) {
    if (!/[\p{L}\p{N}]/u.test(line.slice(1))) continue;
    if (line.startsWith('+')) added.add(line.slice(1));
    else if (line.startsWith('-')) removed.add(line.slice(1));
  }
  return { added, removed };
}
/**
 * What is left of the starting content of an edited file. settled: none is left in its uncommitted changes (the public
 * `settled` state); separable and manual are both `mixed`, separable when the starting content can be removed
 * automatically.
 */
type MixedStartingState = 'settled' | 'separable' | 'manual';
/** Every change Git reports in a worktree, untracked files and submodules included. */
const STATUS = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'];
const underShared = (path: string, shared: Iterable<string>): boolean =>
  [...shared].some((name) => path === name || path.startsWith(`${name}/`));
/**
 * Checks that the record still designates the same Git worktree, then reads its branch, its head and the
 * worktrees its commits can be merged into. Returns its entry in Git's inventory.
 */
async function inspectIdentity(record: WorktreeRecord, view: WorktreeView): Promise<RegisteredWorktree> {
  const common = await commonDirectory(record.path);
  if (common !== record.commonDir) throw new WorktreeError('Le chemin désigne un autre dépôt : gestion refusée.');
  const listing = await registered(record.path);
  const entry = listing.find((w) => resolve(w.path) === record.path);
  if (!entry) throw new WorktreeError('Ce chemin n’est plus enregistré comme worktree Git.');
  view.primary =
    (await realpath((await git(record.path, ['rev-parse', '--absolute-git-dir'])).trim())) === record.commonDir;
  view.branch = entry.branch;
  view.head = (await git(record.path, ['rev-parse', '--verify', 'HEAD'])).trim();
  view.targets = listing
    .filter((w) => w.branch !== null && resolve(w.path) !== record.path && !w.prunable)
    .map((w) => ({ branch: w.branch!, path: resolve(w.path) }));
  const target = listing.find(
    (w) => w.branch === record.targetBranch && resolve(w.path) !== record.path && !w.prunable,
  );
  view.targetPath = target ? resolve(target.path) : null;
  view.targetHead = await targetHead(record);
  return entry;
}
async function targetHead(record: WorktreeRecord): Promise<string | null> {
  return record.targetBranch
    ? git(record.path, ['rev-parse', '--verify', record.targetBranch]).then(
        (text) => text.trim(),
        () => null,
      )
    : null;
}
/**
 * Ignored entries of the copy, outside the dependency directories shared with the project: those with nothing to
 * lose (`disposable`), that a removal deletes, and the others (`kept`).
 */
async function classifyIgnored(
  record: WorktreeRecord,
  workspace: Workspace | null,
  declared: ReadonlySet<string>,
): Promise<{ ignored: string[]; disposable: string[]; kept: string[] }> {
  const sharedIgnored = new Set(await sharedDependencyLinks(workspace ?? record, record.path));
  // The inventory only needs removable ignored entries, not every file below them.
  // Expanding node_modules here made each UI refresh walk thousands of files.
  const ignored = splitZ(
    await git(record.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']),
  ).filter((path) => !underShared(path, sharedIgnored));
  const disposable: string[] = [];
  if (record.managed)
    for (const name of ignored)
      if (await disposableIgnored(record.path, record.source, name.replace(/\/$/, ''), declared)) disposable.push(name);
  return { ignored, disposable, kept: ignored.filter((name) => !disposable.includes(name)) };
}
/** Uncommitted and ignored files of the copy, outside the dependency directories shared with the project. */
async function inspectStatus(
  record: WorktreeRecord,
  workspace: Workspace | null,
  view: WorktreeView,
  declared: ReadonlySet<string>,
): Promise<{ files: string[]; ignored: string[] }> {
  const sharedIgnored = new Set(await sharedDependencyLinks(workspace ?? record, record.path));
  const files = parseStatusZ(await git(record.path, STATUS)).filter((path) => !underShared(path, sharedIgnored));
  const { ignored, disposable, kept } = await classifyIgnored(record, workspace, declared);
  view.files = files.slice(0, 100);
  view.dirty = files.length;
  view.ignoredFiles = kept.slice(0, 100);
  view.ignored = kept.length;
  view.disposableIgnored = disposable;
  return { files, ignored };
}
/** Whether a merge, rebase, cherry-pick or revert is in progress in the copy, and its files still in conflict. */
async function inspectMergeInProgress(path: string, gitDir: string, view: WorktreeView): Promise<void> {
  view.mergeInProgress = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some(
    (name) => existsSync(join(gitDir, name)),
  );
  if (!view.mergeInProgress) return;
  view.conflicts = splitZ(await git(path, ['diff', '--name-only', '-z', '--diff-filter=U']));
  view.remainingMarkers = await remainingConflictMarkers(path, view.conflicts);
}
const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m;
/** Files of `files` whose version in `source` (a revision, or `--cached` for the index) has a conflict marker line. */
async function filesWithMarkers(path: string, source: string, files: string[]): Promise<Set<string>> {
  if (!files.length) return new Set();
  const pattern = ['-l', '-z', '-E', '^(<<<<<<<|>>>>>>>)( |$)'];
  const args = source === '--cached' ? ['grep', '--cached', ...pattern] : ['grep', ...pattern, source];
  const output = await git(path, [...args, '--', ...files.map((file) => `:(literal)${file}`)]).catch((cause) => {
    // Exit code 1: no match. A missing revision has nothing to compare with either.
    if ((cause instanceof GitError && cause.code === 1) || source !== '--cached') return '';
    throw cause;
  });
  return new Set(splitZ(output).map((name) => (source === '--cached' ? name : name.slice(source.length + 1))));
}
/**
 * Files a merge in progress would commit with conflict markers: the files in conflict, as they are in the copy, and
 * the files already staged, as they are in the index (staging a file takes it out of the conflicts). A staged file
 * whose markers already were in one side of the merge keeps them as content.
 */
async function remainingConflictMarkers(path: string, conflicts: string[]): Promise<string[]> {
  const remaining: string[] = [];
  for (const file of conflicts) {
    const content = await readFile(join(path, file), 'utf8').catch(() => null);
    if (content !== null && CONFLICT_MARKER.test(content)) remaining.push(file);
  }
  const staged = splitZ(await git(path, ['diff', '--cached', '--name-only', '-z', '--diff-filter=d'])).filter(
    (file) => !conflicts.includes(file),
  );
  const marked = [...(await filesWithMarkers(path, '--cached', staged))];
  if (marked.length) {
    const sides = await Promise.all(['HEAD', 'MERGE_HEAD'].map((side) => filesWithMarkers(path, side, marked)));
    remaining.push(...marked.filter((file) => !sides.some((side) => side.has(file))));
  }
  return remaining;
}
type ConflictSideState = 'modified' | 'added' | 'deleted' | 'renamed' | 'unchanged';
/** One file left in conflict: what each side did to it since the merge base, and the commits that touched it. */
export interface ConflictFile {
  path: string;
  /** The copy's side (HEAD). */
  ours: ConflictSideState;
  /** The target's side (MERGE_HEAD). */
  theirs: ConflictSideState;
  /** Subjects of the copy's commits that touched the file (latest 10). */
  oursCommits: string[];
  /** Subjects of the target's commits that touched the file (latest 10). */
  theirsCommits: string[];
}
export interface ConflictCommit {
  hash: string;
  subject: string;
}
/** Everything needed to resolve a merge of the target left in conflict in a copy. */
export interface ConflictContext {
  view: WorktreeView;
  mergeHead: string;
  base: string;
  files: ConflictFile[];
  /** The copy's commits since the merge base (latest 50). */
  oursCommits: ConflictCommit[];
  /** The target's commits since the merge base (latest 50). */
  theirsCommits: ConflictCommit[];
  /** Files in conflict without any marker left. */
  resolved: string[];
}
interface MergeSide {
  commits: ConflictCommit[];
  /** Each path changed since the merge base; a renamed file is listed under both names, with its former name. */
  changes: Map<string, { state: ConflictSideState; from?: string }>;
}
async function mergeSide(path: string, base: string, revision: string): Promise<MergeSide> {
  const log = await git(path, ['log', '-n', '50', '--format=%h%x09%s', `${base}..${revision}`]);
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
  const changes: MergeSide['changes'] = new Map();
  const entries = splitZ(await git(path, ['diff', '--name-status', '-z', '-M', base, revision]));
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i][0];
    if (status === 'R') {
      const from = entries[++i];
      const to = entries[++i];
      changes.set(from, { state: 'renamed' });
      changes.set(to, { state: 'renamed', from });
    } else if (status === 'C') {
      i++;
      changes.set(entries[++i], { state: 'added' });
    } else changes.set(entries[++i], { state: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified' });
  }
  return { commits, changes };
}
/** Whether the integrated commits are in the target's upstream branch, when it has one. */
async function inspectPublication(record: WorktreeRecord, view: WorktreeView): Promise<void> {
  const upstream = (await git(record.path, ['for-each-ref', '--format=%(upstream)', record.targetBranch!])).trim();
  if (
    upstream &&
    (await git(record.path, ['rev-parse', '--verify', '--quiet', `${upstream}^{commit}`]).then(
      () => true,
      () => false,
    ))
  )
    view.published = await git(record.path, ['merge-base', '--is-ancestor', view.head!, upstream]).then(
      () => true,
      () => false,
    );
}
/** Digest of everything a merge or removal relies on: an action prepared on it runs only if it is unchanged. */
async function inspectFingerprint(
  record: WorktreeRecord,
  view: WorktreeView,
  entry: RegisteredWorktree,
  gitDir: string,
  files: string[],
  ignored: string[],
  targetState: string,
): Promise<string> {
  const index = await readFile(join(gitDir, 'index')).catch((cause) => {
    if (cause.code === 'ENOENT') return Buffer.alloc(0);
    throw cause;
  });
  return hash(
    JSON.stringify([
      record.path,
      record.targetBranch,
      view.branch,
      view.head,
      view.targetHead,
      view.targetPath,
      files,
      ignored,
      targetState,
      hash(index),
      entry.locked,
    ]),
  );
}
/** A reference that changed during collection cannot produce an actionable snapshot. */
async function assertStableReferences(record: WorktreeRecord, view: WorktreeView): Promise<void> {
  if (
    view.head !== (await git(record.path, ['rev-parse', 'HEAD'])).trim() ||
    view.branch !==
      (await git(record.path, ['symbolic-ref', '--quiet', 'HEAD']).then(
        (text) => text.trim(),
        () => null,
      )) ||
    view.targetHead !== (await targetHead(record))
  )
    throw new WorktreeError('Les références ont changé pendant la collecte : actualisez.');
}
/** One dirty file being planned, with the versions its plan is made from. */
interface FileVersions {
  file: PlannedFile;
  signature: string | undefined;
  /** Content of a regular file; null for a missing file or a link. */
  current: Buffer | null;
  regular: boolean;
  /** Version in the copy's last commit. */
  head: Buffer | null;
  changedByMerge: boolean;
  /** Carries the local changes onto the merged version; undefined when they overlap the target's changes. */
  carry: () => Promise<Buffer | null | undefined>;
  threeWay: (current: Buffer, base: Buffer | null, other: Buffer | null) => Promise<Buffer | null>;
}
async function fileVersions(
  root: string,
  path: string,
  merge: TargetMerge | null,
  temporary: string,
): Promise<FileVersions> {
  const target = join(root, path);
  const signature = await workspaceFileSignature(target);
  const regular = signature !== undefined && !signature.startsWith('link:');
  const current = regular ? await readFile(target) : null;
  const head = await gitBytes(root, ['cat-file', 'blob', `HEAD:${path}`]).catch(() => null);
  const next = merge ? await merge.read(path) : head;
  // Without a merge `next` is `head`: only a merge can change the file.
  const changedByMerge = merge !== null && (next === null || head === null ? next !== head : !next.equals(head));
  const threeWay = async (current: Buffer, base: Buffer | null, other: Buffer | null): Promise<Buffer | null> => {
    const files = ['current', 'base', 'other'].map((name) => join(temporary, `plan-${name}`));
    await writeFile(files[0], current);
    await writeFile(files[1], base ?? '');
    await writeFile(files[2], other ?? '');
    return gitBytes(root, ['merge-file', '-p', '-L', 'copie', '-L', 'départ', '-L', 'cible', ...files]).catch(
      () => null,
    );
  };
  return {
    file: { path, signature, current, next, step: null },
    signature,
    current,
    regular,
    head,
    changedByMerge,
    carry: async () => {
      if (!changedByMerge) return undefined;
      if (!current) return signature === undefined && !next ? null : undefined;
      return (await threeWay(current, head, next)) ?? undefined;
    },
    threeWay,
  };
}
/**
 * A file without starting content left, or confirmed as such: it stays as is, carried onto the merged version, and
 * becomes the conversation's work. False when it cannot be carried.
 */
async function planSettled(
  root: string,
  versions: FileVersions,
  step: StartingContentStep,
  settled: boolean,
  temporary: string,
): Promise<boolean> {
  const { file } = versions;
  step.state = settled ? 'settled' : 'mixed';
  step.action = 'settle';
  step.reason = settled
    ? 'Le contenu de départ n’apparaît plus dans ses changements non commités.'
    : 'Vérifié par vous : ne contient que le travail de la conversation.';
  if (versions.changedByMerge) {
    const carried = await versions.carry();
    if (carried === undefined) return false;
    file.write = carried;
  }
  step.diff = await contentDiff(
    root,
    file.path,
    file.next,
    file.write !== undefined ? file.write : versions.current,
    temporary,
  );
  return true;
}
/**
 * The mixed file with its starting content removed and the changes made since kept; otherwise the reason it cannot
 * be separated automatically.
 */
async function separation(
  root: string,
  workspace: Workspace,
  versions: FileVersions,
  found: { content: () => Promise<Buffer> } | null,
): Promise<Buffer | string> {
  const { file, current } = versions;
  if (!found) return 'Contenu de départ introuvable (ni dans la cible, ni conservé à la création).';
  if (!current) return 'Fichier supprimé ou remplacé par un lien depuis la création.';
  if (!file.next) return 'Fichier absent de la version à jour de la copie.';
  if (
    workspace.base &&
    (await git(root, ['diff', '--quiet', workspace.base, 'HEAD', '--', `:(literal)${file.path}`]).then(
      () => false,
      () => true,
    ))
  )
    return 'Fichier déjà modifié par un commit de la copie.';
  return (
    (await versions.threeWay(current, await found.content(), file.next)) ??
    'Les changements faits depuis la création touchent les mêmes lignes que le contenu de départ.'
  );
}
/**
 * A mixed file left for a manual review. Carried onto the merged version when it can be; otherwise written unchanged,
 * which undoes the target's changes, and false when even that is impossible.
 */
async function planReview(
  root: string,
  versions: FileVersions,
  step: StartingContentStep,
  reason: string,
  temporary: string,
): Promise<boolean> {
  const { file, current } = versions;
  step.diff = await contentDiff(root, file.path, versions.head, current, temporary);
  if (!versions.changedByMerge) {
    step.reason = `${reason} Examinez ce fichier et cochez-le dans les diffs.`;
    return true;
  }
  const carried = await versions.carry();
  if (carried !== undefined) {
    file.write = carried;
    step.reason = `${reason} Le fichier est reporté tel quel sur la version à jour de la copie : examinez son diff.`;
    return true;
  }
  if (versions.signature !== undefined && !versions.regular) return false;
  // Written unchanged: its diff against the merged version also shows the target's later changes, undone.
  file.write = current;
  step.reason = `${reason} Attention : la cible a aussi modifié ce fichier depuis la création de la copie. Son diff montre ces changements annulés : ne le commitez pas tel quel, reportez seulement le travail de la conversation.`;
  return true;
}
function parseConfirmations(confirmations: unknown): StartingConfirmation[] {
  if (
    !Array.isArray(confirmations) ||
    !confirmations.every((entry) => typeof entry?.path === 'string' && typeof entry?.version === 'string')
  )
    throw new WorktreeError('Confirmations invalides.', 400);
  return confirmations as StartingConfirmation[];
}
/**
 * Refuses a plan made on stale confirmations, one that removes nothing, or one whose files changed since it was made.
 * Returns its steps.
 */
async function assertPlanApplicable(
  root: string,
  plan: PlannedStarting,
  confirmed: StartingConfirmation[],
): Promise<StartingContentStep[]> {
  const steps = plan.files.flatMap((file) => (file.step ? [file.step] : []));
  const stale = confirmed.filter((entry) => steps.find((step) => step.path === entry.path)?.action === 'keep');
  if (stale.length)
    throw new WorktreeError(
      `${stale.map((entry) => entry.path).join(', ')} : contenu modifié depuis votre vérification. Rien n’a été modifié : relisez-le et recommencez.`,
    );
  const kept = steps.filter((step) => step.action === 'keep');
  if (!steps.some((step) => step.action !== 'keep'))
    throw new WorktreeError(
      kept.length
        ? `Aucun contenu de départ ne peut être retiré automatiquement :\n${kept.map((step) => `${step.path} : ${step.reason}`).join('\n')}`
        : 'Aucun fichier n’a encore le contenu de départ.',
    );
  // Compared again right before writing: anything edited since the plan stops the action.
  for (const file of plan.files)
    if (
      (file.write !== undefined || file.step?.action === 'settle') &&
      (await workspaceFileSignature(join(root, file.path))) !== file.signature
    )
      throw new WorktreeError(`${file.path} a changé pendant la préparation : rien n’a été modifié, recommencez.`);
  return steps;
}
/** Writes each file's content given by `content`; null deletes it. */
async function writePlannedFiles(
  root: string,
  files: PlannedFile[],
  content: (file: PlannedFile) => Buffer | null,
): Promise<void> {
  for (const file of files) {
    const target = join(root, file.path);
    const value = content(file);
    if (value === null) await rm(target, { force: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, value);
    }
  }
}
/**
 * Applies a starting content plan: the index of the rewritten files goes back to the copy's last commit, the copy
 * receives the target's commits when the plan merges them, and the planned contents are written last.
 */
async function applyStartingPlan(view: WorktreeView, plan: PlannedStarting): Promise<void> {
  const written = plan.files.filter((file) => file.write !== undefined);
  const literals = written.map((file) => `:(literal)${file.path}`);
  const inHead = written.length
    ? splitZ(
        await git(view.path, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...written.map((file) => file.path)]),
      )
    : [];
  if (literals.length) await git(view.path, ['rm', '--cached', '--quiet', '--ignore-unmatch', '-r', '--', ...literals]);
  if (plan.merge) await commitTargetMerge(view, plan.merge, written, inHead);
  else if (inHead.length)
    await git(view.path, ['reset', '--quiet', 'HEAD', '--', ...inHead.map((path) => `:(literal)${path}`)]);
  await writePlannedFiles(view.path, written, (file) => file.write!);
}
/**
 * Moves the copy onto the simulated merge with its target, a merge commit. On failure, the rewritten files get their
 * previous content back.
 */
async function commitTargetMerge(
  view: WorktreeView,
  merge: TargetMerge,
  written: PlannedFile[],
  inHead: string[],
): Promise<void> {
  const head = view.head!;
  // The worktree too, so the tree can switch to the merge.
  if (inHead.length) await git(view.path, ['checkout', 'HEAD', '--', ...inHead.map((path) => `:(literal)${path}`)]);
  for (const file of written) if (!inHead.includes(file.path)) await rm(join(view.path, file.path), { force: true });
  const message = `Copie : intégrer ${branchLabel(view.targetBranch, 'la cible')} avant de retirer le contenu de départ`;
  try {
    const commit = (
      await git(view.path, ['commit-tree', merge.tree, '-p', head, '-p', view.targetHead!, '-m', message])
    ).trim();
    await git(view.path, ['read-tree', '-m', '-u', head, commit]);
    try {
      await git(view.path, ['update-ref', '-m', mergeCommitReflog(message), 'HEAD', commit, head]);
    } catch (cause) {
      await git(view.path, ['read-tree', '-m', '-u', commit, head]);
      throw cause;
    }
  } catch (cause) {
    await writePlannedFiles(view.path, written, (file) => file.current);
    throw new WorktreeError(
      `La copie n’a pas pu être mise à jour avec ${branchLabel(view.targetBranch, 'la cible')} : ${errorMessage(cause)}\nLes fichiers de la copie ont été remis dans leur état précédent.`,
    );
  }
}
/** Why `activity` blocks a merge into, or the removal of, its folder. */
/**
 * The removal blocker of ignored entries with something to lose, always the last of `removeBlockers`. A removal that
 * the user confirmed with their explicit deletion lifts it.
 */
const ignoredReason = (count: number): string =>
  `${count} fichier(s) ignoré(s) conservé(s) : déplacez-les, déclarez-les régénérables dans les réglages du projet, ou confirmez leur suppression au retrait.`;
/** What prevents an action, minus the ignored entries a removal was confirmed to delete. */
function actionBlockers(view: WorktreeView, kind: 'merge' | 'remove', deleteIgnored: boolean): string[] {
  if (kind === 'merge') return view.mergeBlockers;
  return deleteIgnored
    ? view.removeBlockers.filter((reason) => reason !== ignoredReason(view.ignored ?? 0))
    : view.removeBlockers;
}
function activityReasons(activity: RepositoryActivity, removing: boolean): string[] {
  const repeat = (count: number, reason: string): string[] => Array.from({ length: count }, () => reason);
  return [
    ...activity.sessions
      .filter((session) => removing || sessionBusy(session.status))
      .map((session) => `Session ${session.title} (${session.status}).`),
    ...repeat(activity.commands, 'Une commande utilise ce worktree.'),
    ...repeat(activity.automaticCommits, 'Un commit automatique utilise ce worktree.'),
    ...(removing ? repeat(activity.epics, 'Un epic utilise encore ce worktree.') : []),
  ];
}

export class WorktreeManager {
  private db: CerebroDatabase;
  private services: Services;
  private syncing: Promise<string[]> | null = null;
  private listings = new Map<string, Promise<WorktreeInventory>>();
  private plans = new Map<
    string,
    {
      id: string;
      kind: 'merge' | 'remove';
      fingerprint: string;
      expires: number;
      /** Ignored entries with something to lose that the user confirmed to delete with the copy. */
      deleteIgnored: string[];
    }
  >();
  private startingCommits = new Map<string, { commit: string; subject: string } | null>();
  private forecasts = new Map<string, string[] | null>();
  private separations = new Map<string, MixedStartingState>();
  private forecastQueue: Promise<void> = Promise.resolve();
  private forecastQueued = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  // Automatic cleanups run one at a time: two triggers for the same copy never inspect it concurrently.
  private cleanupQueue: Promise<void> = Promise.resolve();
  private cleanupQueued = new Set<string>();
  /** Repositories (common directories) already rid of the merge refs left by an earlier process. */
  private purgedMergeRefs = new Set<string>();
  /** Sessions whose copy was just removed: their `worktree` field changed. */
  onSessionsChanged: (ids: string[]) => void = () => {};
  constructor(db: CerebroDatabase, services: Services) {
    this.db = db;
    this.services = services;
    for (const operation of this.operations())
      if (operation.status === 'running') {
        operation.status = 'interrupted';
        operation.error = 'Serveur interrompu : vérifier tout merge en cours avant de relancer.';
        operation.finishedAt = Date.now();
        this.saveOperation(operation);
      }
  }
  private operations(): WorktreeOperation[] {
    return (
      this.db.connection.prepare('SELECT data FROM worktree_operations ORDER BY rowid DESC').all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  private saveOperation(operation: WorktreeOperation): void {
    this.db.connection
      .prepare('INSERT INTO worktree_operations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(operation.id, JSON.stringify(operation));
  }
  private async sync(): Promise<string[]> {
    if (this.syncing) return this.syncing;
    this.syncing = this.discover().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }
  private async discover(): Promise<string[]> {
    const errors: string[] = [];
    const managed = records(this.db).filter((r) => r.managed);
    const registeredSessions = new Set(managed.map((r) => r.sessionId));
    // Later epic steps share the first step's copy, whose record already identifies it: rememberWorktree would only
    // ask Git again to find that record, on every listing.
    const registeredPaths = new Set(managed.filter((r) => !r.removedAt).map((r) => r.path));
    for (const workspace of sessionWorkspaces(this.db).values()) {
      if (
        workspace.mode !== 'isolated' ||
        workspace.removedAt ||
        registeredSessions.has(workspace.sessionId) ||
        registeredPaths.has(canonicalWorktreePath(workspace.root))
      )
        continue;
      try {
        await rememberWorktree(this.db, workspace);
      } catch (cause) {
        if (!records(this.db).some((r) => r.sessionId === workspace.sessionId))
          errors.push(`Espace ${workspace.root} : ${errorMessage(cause)}`);
      }
    }
    const known = records(this.db);
    const projects = this.db.listProjects();
    const paths = [...new Set([...projects.map((p) => p.path), ...known.flatMap((r) => [r.path, r.source])])];
    const anchors = new Map<string, string>();
    // Isolated copies still in use, by canonical path: resolved once per discovery, only if a copy needs attributing.
    let isolated: Map<string, Workspace> | undefined;
    const workspaces = (): Map<string, Workspace> => {
      if (isolated) return isolated;
      isolated = new Map();
      for (const row of this.db.connection.prepare('SELECT data FROM session_workspaces').all() as { data: string }[]) {
        const workspace = JSON.parse(row.data) as Workspace;
        if (workspace.mode !== 'isolated' || workspace.removedAt) continue;
        const canonical = canonicalWorktreePath(workspace.root);
        if (!isolated.has(canonical)) isolated.set(canonical, workspace);
      }
      return isolated;
    };
    await Promise.all(
      paths.map(async (path) => {
        try {
          const common = await commonDirectory(path);
          if (!anchors.has(common)) anchors.set(common, path);
        } catch {
          /* Retained records below expose unavailable directories. */
        }
      }),
    );
    for (const [commonDir, anchor] of anchors) {
      try {
        await this.purgeMergeRefs(commonDir, anchor);
        const listing = await registered(anchor);
        // Several projects may live in one repository (e.g. two folders of a monorepo).
        const sharing = projects.filter((p) => listing.some((w) => pathWithin(w.path, canonicalWorktreePath(p.path))));
        const sources = new Map<string, Promise<{ source: string; target: string | null }>>();
        const origin = (project: (typeof projects)[number] | undefined) => {
          const key = project?.id ?? '';
          let found = sources.get(key);
          if (!found)
            sources.set(
              key,
              (found = (async () => {
                const source = project
                  ? await repositoryRoot(project.path)
                  : (known.find((r) => r.commonDir === commonDir)?.source ?? anchor);
                return {
                  source,
                  target: await git(source, ['symbolic-ref', '--quiet', 'HEAD']).then(
                    (text) => text.trim(),
                    () => null,
                  ),
                };
              })()),
            );
          return found;
        };
        for (const worktree of listing) {
          // Read after the awaits, so a registration made meanwhile is never overwritten.
          const path = resolve(worktree.path);
          const id = worktreeId(commonDir, path);
          const previous = records(this.db).find((r) => r.id === id);
          const preparing = /^refs\/heads\/cerebro\/session-(.+)$/.exec(worktree.branch ?? '')?.[1];
          if (previous && !previous.removedAt) {
            if (previous.managed) continue;
            // Copies discovered before their repository was shared, or credited to the wrong one of its projects.
            const project = this.owner(sharing, path, workspaces(), preparing);
            if (
              previous.projectId !== (project?.id ?? null) &&
              (previous.projectId === null || sharing.some((p) => p.id === previous.projectId))
            )
              store(this.db, {
                ...previous,
                projectId: project?.id ?? null,
                projectName: project?.name ?? basename(previous.source),
              });
            continue;
          }
          // A copy recorded as removed but deleted outside Git leaves only stale metadata: keep its archived record.
          if (previous && worktree.prunable) continue;
          if (preparing && this.db.getSession(preparing)?.status === 'starting' && !workspaceFor(this.db, preparing))
            continue;
          const project = this.owner(sharing, path, workspaces(), preparing);
          // Unattributed in a shared repository: listed under each of its projects, credited to none.
          const { source, target } = await origin(project ?? sharing[0]);
          store(this.db, {
            id,
            commonDir,
            path,
            source,
            projectId: project?.id ?? previous?.projectId ?? null,
            projectName: project?.name ?? previous?.projectName ?? basename(source),
            sessionId: null,
            sessionTitle: null,
            managed: false,
            expectedBranch: worktree.branch,
            targetBranch: target,
            createdAt: Date.now(),
            removedAt: null,
          });
        }
      } catch (cause) {
        errors.push(`Dépôt ${anchor} : ${errorMessage(cause)}`);
      }
    }
    return errors;
  }
  /** A merge pins its tip only while it runs: the refs of operations interrupted by a stop are dropped once per repository. */
  private async purgeMergeRefs(commonDir: string, anchor: string): Promise<void> {
    if (this.purgedMergeRefs.has(commonDir)) return;
    this.purgedMergeRefs.add(commonDir);
    const running = new Set(
      this.operations()
        .filter((operation) => operation.status === 'running')
        .map((operation) => mergeRef(operation.id)),
    );
    const stale = (await git(anchor, ['for-each-ref', '--format=%(refname)', 'refs/cerebro/merges/']))
      .split('\n')
      .filter((ref) => ref && !running.has(ref));
    if (stale.length)
      await git(anchor, ['update-ref', '--stdin'], { input: stale.map((ref) => `delete ${ref}\n`).join('') });
  }
  /**
   * The project a discovered copy belongs to: the one of the conversation that created it, else the only project
   * located inside it, else the repository's only project. null when the repository is shared and nothing tells.
   */
  private owner<P extends { id: string; path: string }>(
    sharing: P[],
    path: string,
    workspaces: Map<string, Workspace>,
    branchSession?: string,
  ): P | undefined {
    const workspace = workspaces.get(path);
    const sessionId = workspace?.sessionId ?? branchSession;
    const projectId = workspace?.projectId ?? (sessionId ? this.db.getSession(sessionId)?.projectId : undefined);
    const own = sharing.find((p) => p.id === projectId);
    if (own) return own;
    const inside = sharing.filter((p) => pathWithin(path, canonicalWorktreePath(p.path)));
    if (inside.length === 1) return inside[0];
    return sharing.length === 1 ? sharing[0] : undefined;
  }
  private record(id: string): WorktreeRecord {
    const record = records(this.db).find((r) => r.id === id);
    if (!record) throw new WorktreeError('Worktree introuvable.', 404);
    // 410: a copy removed meanwhile, often by the automatic cleanup, which the UI can simply drop.
    if (record.removedAt)
      throw new WorktreeError(
        record.autoCleanup?.status === 'removed'
          ? 'Copie déjà retirée par le nettoyage automatique.'
          : 'Copie déjà retirée.',
        410,
      );
    return record;
  }
  async list(projectId?: string): Promise<WorktreeInventory> {
    const key = projectId ?? '';
    const current = this.listings.get(key);
    if (current) return current;
    const pending = this.collectList(projectId).finally(() => {
      if (this.listings.get(key) === pending) this.listings.delete(key);
    });
    this.listings.set(key, pending);
    return pending;
  }
  private async collectList(projectId?: string): Promise<WorktreeInventory> {
    const errors = await this.sync();
    const project = projectId ? this.db.getProject(projectId) : null;
    if (projectId && !project) throw new WorktreeError('Projet introuvable.', 404);
    const common = project ? await commonDirectory(project.path).catch(() => null) : null;
    const inventory = records(this.db);
    const inProject = (record: WorktreeRecord): boolean =>
      !projectId || record.projectId === projectId || record.commonDir === common;
    const selected = inventory.filter((r) => !r.removedAt && inProject(r));
    const worktrees: WorktreeView[] = [];
    for (let i = 0; i < selected.length; i += 8)
      worktrees.push(...(await Promise.all(selected.slice(i, i + 8).map((record) => this.inspect(record)))));
    // A copy credited to no project of its shared repository is shown as belonging to each of them.
    const unattributed = worktrees.filter((view) => view.projectId === null);
    if (project)
      for (const view of unattributed)
        if (view.commonDir === common)
          Object.assign(view, { projectId: project.id, projectName: project.name, projectExists: true });
    if (!project && unattributed.length) {
      const projects = this.db.listProjects();
      const repositories = await Promise.all(projects.map((p) => commonDirectory(p.path).catch(() => null)));
      for (const view of unattributed) {
        const names = projects.filter((_, i) => repositories[i] === view.commonDir).map((p) => p.name);
        if (names.length) Object.assign(view, { projectName: names.join(', '), projectExists: true });
      }
    }
    // Read again after the inspections: a copy removed meanwhile is listed among the cleaned ones.
    const cleaned = records(this.db)
      .filter((r) => r.removedAt && r.autoCleanup?.status === 'removed' && !r.historyDeletedAt && inProject(r))
      .sort((left, right) => right.removedAt! - left.removedAt!)
      .slice(0, CLEANED_SHOWN)
      .map((record) => {
        const session = record.sessionId ? this.db.getSession(record.sessionId) : null;
        return {
          id: record.id,
          path: record.path,
          projectId: record.projectId,
          projectName: (record.projectId ? this.db.getProject(record.projectId)?.name : null) ?? record.projectName,
          sessionId: record.sessionId,
          sessionTitle: session?.title ?? record.sessionTitle,
          session: session ? { id: session.id, title: session.title, status: session.status } : null,
          branch: record.expectedBranch,
          removedAt: record.removedAt!,
        };
      });
    return { worktrees, cleaned, errors };
  }
  deleteHistory(ids: unknown): void {
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string'))
      throw new WorktreeError('Liste d’entrées requise.', 400);
    const inventory = new Map(records(this.db).map((record) => [record.id, record]));
    const selected = [...new Set<string>(ids)].map((id) => {
      const record = inventory.get(id);
      if (!record) throw new WorktreeError('Entrée introuvable.', 404);
      if (!record.removedAt || record.autoCleanup?.status !== 'removed')
        throw new WorktreeError('Seules les copies déjà nettoyées peuvent être retirées de l’historique.');
      return record;
    });
    this.db.transaction(() => {
      for (const record of selected) store(this.db, { ...record, historyDeletedAt: Date.now() });
    });
  }
  async get(id: string): Promise<WorktreeView> {
    await this.sync();
    return this.inspect(this.record(id));
  }
  private async inspect(record: WorktreeRecord, ownOperation?: string): Promise<WorktreeView> {
    const view = this.blankView(record);
    try {
      const entry = await inspectIdentity(record, view);
      const workspace = record.sessionId ? this.workspaceOf(record.sessionId) : null;
      const { files, ignored } = await inspectStatus(record, workspace, view, this.declaredRegenerable(record));
      if (workspace?.mode === 'isolated' && canonicalWorktreePath(workspace.root) === record.path)
        await this.inspectStartingContent(record, workspace, files, view);
      const gitDir = (await git(record.path, ['rev-parse', '--absolute-git-dir'])).trim();
      await inspectMergeInProgress(record.path, gitDir, view);
      view.resolver = await this.inspectResolver(record, gitDir, view);
      await this.inspectIntegration(record, view);
      await this.inspectBlockers(record, view, entry, gitDir, ownOperation);
      const targetState = await this.inspectTarget(view);
      view.fingerprint = await inspectFingerprint(record, view, entry, gitDir, files, ignored, targetState);
      await assertStableReferences(record, view);
    } catch (cause) {
      view.error = errorMessage(cause);
      view.integration = 'unknown';
      view.fingerprint = null;
      view.mergeBlockers = [view.error];
      view.removeBlockers = [view.error];
    }
    return view;
  }
  /** The view of a record before anything is read from Git: every collected field is unknown or empty. */
  private blankView(record: WorktreeRecord): WorktreeView {
    const session = record.sessionId ? this.db.getSession(record.sessionId) : null;
    return {
      ...record,
      projectName: (record.projectId ? this.db.getProject(record.projectId)?.name : null) ?? record.projectName,
      projectExists: record.projectId !== null && this.db.getProject(record.projectId) !== null,
      session: session ? { id: session.id, title: session.title, status: session.status } : null,
      primary: false,
      branch: null,
      head: null,
      dirty: null,
      files: [],
      ignored: null,
      ignoredFiles: [],
      disposableIgnored: [],
      ahead: null,
      behind: null,
      targetPath: null,
      targetHead: null,
      targets: [],
      integration: 'unknown',
      published: null,
      mergeInProgress: false,
      activeSessions: [],
      mergeBlockers: [],
      removeBlockers: [],
      fingerprint: null,
      error: null,
      operation: this.operations().find((op) => op.worktreeId === record.id) ?? null,
      changesSinceCreation: null,
      startingContent: null,
      targetDirty: null,
      integrationConflicts: null,
      integrationNote: null,
      conflicts: [],
      remainingMarkers: [],
      resolver: null,
    };
  }
  /** The session launched to resolve the merge in progress, as long as it is still the merge it was launched for. */
  private async inspectResolver(
    record: WorktreeRecord,
    gitDir: string,
    view: WorktreeView,
  ): Promise<WorktreeView['resolver']> {
    const resolution = record.conflictResolution;
    if (!resolution || !view.mergeInProgress) return null;
    const mergeHead = await readFile(join(gitDir, 'MERGE_HEAD'), 'utf8').catch(() => '');
    if (mergeHead.split('\n', 1)[0]?.trim() !== resolution.mergeHead) return null;
    const session = this.db.getSession(resolution.sessionId);
    return session ? { sessionId: session.id, title: session.title, status: session.status } : null;
  }
  private workspaceOf(sessionId: string): Workspace | null {
    return workspaceFor(this.db, sessionId);
  }
  /** Files changed since the copy was created, and those still holding the content copied from the project. */
  private async inspectStartingContent(
    record: WorktreeRecord,
    workspace: Workspace,
    files: string[],
    view: WorktreeView,
  ): Promise<void> {
    const changed: string[] = [];
    const starting: StartingContent[] = [];
    for (const file of files) {
      const inherited = workspace.baseline[file] === (await workspaceFileSignature(join(record.path, file)));
      if (!inherited) changed.push(file);
      if ((inherited || workspace.initialDirty.includes(file)) && starting.length < 100) {
        const found = await this.findStarting(record.path, workspace, view.targetPath, view.targetHead, file).catch(
          () => null,
        );
        const state =
          !inherited && found
            ? await this.mixedStartingState(record.path, workspace, view.head!, file, found.content).catch(
                (): MixedStartingState => 'manual',
              )
            : 'manual';
        starting.push({
          path: file,
          state: inherited ? 'inherited' : state === 'settled' ? 'settled' : 'mixed',
          origin: found?.origin ?? null,
          separable: state === 'separable',
        });
      }
    }
    view.changesSinceCreation = {
      count: changed.length,
      files: changed.slice(0, 100),
      inheritedCount: files.length - changed.length,
      needsReviewCount: changed.filter((file) => workspace.initialDirty.includes(file)).length,
    };
    view.startingContent = starting;
  }
  /** Commits ahead of and behind the target, the conflicts their integration would leave, and its publication. */
  private async inspectIntegration(record: WorktreeRecord, view: WorktreeView): Promise<void> {
    if (!view.targetHead || record.targetBranch === view.branch) return;
    const counts = (
      await git(record.path, ['rev-list', '--left-right', '--count', `${view.targetHead}...${view.head}`])
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    view.behind = counts[0];
    view.ahead = counts[1];
    view.integration = view.ahead === 0 && view.dirty === 0 ? 'integrated' : 'pending';
    if (view.ahead && view.behind && !view.mergeInProgress) {
      view.integrationConflicts = this.forecast(view);
      view.integrationNote = (await mergeTreeAvailable()) ? null : APPROXIMATE_FORECAST;
    }
    if (view.integration === 'integrated') await inspectPublication(record, view);
  }
  /** What prevents a removal or a merge of the copy itself; the target worktree is checked by `inspectTarget`. */
  private async inspectBlockers(
    record: WorktreeRecord,
    view: WorktreeView,
    entry: RegisteredWorktree,
    gitDir: string,
    ownOperation: string | undefined,
  ): Promise<void> {
    const activity = repositoryActivity(this.db, record.path);
    view.activeSessions = activity.sessions.map((s) => ({ id: s.id, title: s.title, status: s.status }));
    const commonBlockers: string[] = [];
    if (view.operation?.status === 'running' && view.operation.id !== ownOperation)
      commonBlockers.push('Une opération Git utilise ce worktree.');
    if (!record.managed || view.primary)
      commonBlockers.push('Worktree principal ou géré hors de Cerebro : lecture seule.');
    if (view.branch !== record.expectedBranch || !view.branch)
      commonBlockers.push('Branche du worktree changée ou détachée : vérifier son identité.');
    if (!record.targetBranch || !view.targetHead || record.targetBranch === view.branch)
      commonBlockers.push('Choisissez une branche cible distincte et existante.');
    if (view.mergeInProgress)
      commonBlockers.push('Un merge est en cours dans la copie : terminez-le ou annulez-le avant cette action.');
    if (view.dirty && !view.mergeInProgress)
      commonBlockers.push(
        `La copie contient ${view.dirty} fichier(s) modifié(s) non commité(s) : commitez-les, ou retirez le contenu de départ, avant cette action.`,
      );
    if (entry.locked || existsSync(join(gitDir, 'index.lock')))
      commonBlockers.push('Worktree ou index verrouillé par Git.');
    if ((await this.services.pushes.current(record.path))?.status === 'running')
      commonBlockers.push('Un push est en cours.');
    view.removeBlockers = [...commonBlockers, ...activityReasons(activity, true)];
    if (view.ahead === null || view.ahead > 0)
      view.removeBlockers.push('Des commits restent à intégrer, ou leur intégration ne peut pas être vérifiée.');
    if (view.ignored) view.removeBlockers.push(ignoredReason(view.ignored));
    view.mergeBlockers = [...commonBlockers, ...activityReasons(activity, false)];
    if (!view.targetPath) view.mergeBlockers.push('La branche cible doit être ouverte dans un worktree Git.');
    if (view.ahead === 0) view.mergeBlockers.push('Aucun nouveau commit à intégrer.');
  }
  /**
   * What prevents a merge into the target worktree: uncommitted files, an operation in progress or a session at
   * work there. Returns the target's state for the fingerprint, empty without a target worktree.
   */
  private async inspectTarget(view: WorktreeView): Promise<string> {
    if (!view.targetPath) return '';
    const dirty = await git(view.targetPath, STATUS);
    const targetGitDir = (await git(view.targetPath, ['rev-parse', '--absolute-git-dir'])).trim();
    const pending = [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
      'index.lock',
    ].filter((name) => existsSync(join(targetGitDir, name)));
    view.targetDirty = parseStatusZ(dirty).length;
    if (view.targetDirty)
      view.mergeBlockers.push(
        `Le dossier cible doit être propre : ${view.targetPath} contient ${view.targetDirty} fichier(s) non commité(s). Commitez-les d’abord (« Commit / push du projet »).`,
      );
    if (pending.length)
      view.mergeBlockers.push(
        `Le dossier cible doit être propre : une opération Git est en cours dans ${view.targetPath}.`,
      );
    view.mergeBlockers.push(...activityReasons(repositoryActivity(this.db, view.targetPath), false));
    return hash(dirty + '\0' + JSON.stringify(pending));
  }
  async target(id: string, branch: unknown): Promise<WorktreeView> {
    if (typeof branch !== 'string' || !branch.startsWith('refs/heads/'))
      throw new WorktreeError('Branche cible invalide.', 400);
    const view = await this.get(id);
    if (!view.targets.some((target) => target.branch === branch))
      throw new WorktreeError('Choisissez une branche ouverte dans un autre worktree.', 400);
    if (view.operation?.status === 'running') throw new WorktreeError('Une opération utilise ce worktree.');
    this.services.gate.assertAvailable(view.path);
    const record = this.record(id);
    record.targetBranch = branch;
    store(this.db, record);
    return this.inspect(record);
  }
  /**
   * Finds the content copied from the project at creation: committed on the target since, still in the
   * target worktree, or in the snapshot taken at creation. The commit search is cached per target tip.
   */
  private async findStarting(
    path: string,
    workspace: Workspace,
    targetPath: string | null,
    targetHead: string | null,
    file: string,
  ): Promise<{ origin: StartingOrigin; content: () => Promise<Buffer> } | null> {
    const signature = workspace.baseline[file];
    if (!signature || signature === 'missing' || signature.startsWith('link:')) return null;
    const digest = signature.slice(signature.indexOf(':') + 1);
    if (targetHead && workspace.base) {
      const key = [path, file, signature, workspace.base, targetHead].join('\0');
      let found = this.startingCommits.get(key);
      if (found === undefined) {
        found = null;
        const candidates = (
          await git(path, [
            'rev-list',
            '--max-count=50',
            `${workspace.base}..${targetHead}`,
            '--',
            `:(literal)${file}`,
          ]).catch(() => '')
        )
          .split('\n')
          .filter(Boolean);
        // The oldest match is the commit that brought this content to the target.
        for (const candidate of candidates) {
          const content = await gitBytes(path, ['cat-file', 'blob', `${candidate}:${file}`]).catch(() => null);
          if (content && hash(content) === digest) found = { commit: candidate, subject: '' };
        }
        if (found) found.subject = (await git(path, ['log', '-1', '--format=%s', found.commit])).trim();
        if (this.startingCommits.size >= 500) this.startingCommits.delete(this.startingCommits.keys().next().value!);
        this.startingCommits.set(key, found);
      }
      if (found) {
        const commit = found.commit;
        return {
          origin: { kind: 'target-commit', commit, subject: found.subject },
          content: () => gitBytes(path, ['cat-file', 'blob', `${commit}:${file}`]),
        };
      }
    }
    if (targetPath) {
      const content = await readFile(join(targetPath, file)).catch(() => null);
      if (content && hash(content) === digest)
        return { origin: { kind: 'target-worktree' }, content: async () => content };
    }
    const content = workspace.startingCopy
      ? await readFile(join(workspace.startingCopy, file)).catch(() => null)
      : workspace.startingSnapshot
        ? await gitBytes(path, ['cat-file', 'blob', `${workspace.startingSnapshot}:${file}`]).catch(() => null)
        : null;
    if (content && hash(content) === digest) return { origin: { kind: 'snapshot' }, content: async () => content };
    return null;
  }
  /**
   * What is left of the starting content of a mixed file. Settled when none of the lines it added or removed is
   * still added or removed by the file's uncommitted changes: the conversation or a resolution session already took
   * it out. Otherwise separable when its removal succeeds against the copy's last commit: the file was not committed
   * in the copy, and its recent changes do not touch the lines of the starting content.
   */
  private async mixedStartingState(
    path: string,
    workspace: Workspace,
    head: string,
    file: string,
    starting: () => Promise<Buffer>,
  ): Promise<MixedStartingState> {
    const target = join(path, file);
    const key = [path, file, await workspaceFileSignature(target), workspace.baseline[file], head].join('\0');
    const cached = this.separations.get(key);
    if (cached !== undefined) return cached;
    let result: MixedStartingState = 'manual';
    const last = await gitBytes(path, ['cat-file', 'blob', `${head}:${file}`]).catch(() => null);
    const current = await readFile(target).catch(() => null);
    if (current) {
      const temporary = await mkdtemp(join(tmpdir(), 'cerebro-separable-'));
      try {
        const copied = await starting();
        if (await this.startingRemoved(path, workspace, file, copied, last, current, temporary)) result = 'settled';
        else {
          const committed = workspace.base
            ? await git(path, ['diff', '--quiet', workspace.base, 'HEAD', '--', `:(literal)${file}`]).then(
                () => false,
                () => true,
              )
            : false;
          if (!committed && last) {
            const base = join(temporary, 'base');
            const other = join(temporary, 'head');
            await writeFile(base, copied);
            await writeFile(other, last);
            if (
              await git(path, ['merge-file', '-p', target, base, other]).then(
                () => true,
                () => false,
              )
            )
              result = 'separable';
          }
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    if (this.separations.size >= 500) this.separations.delete(this.separations.keys().next().value!);
    this.separations.set(key, result);
    return result;
  }
  /**
   * Whether none of the lines the starting content added or removed is still added or removed by the changes from
   * `last` to `current`. False for binary content, which has no lines to compare, and for a starting content that
   * only changed lines too common to recognize.
   */
  private async startingRemoved(
    path: string,
    workspace: Workspace,
    file: string,
    copied: Buffer,
    last: Buffer | null,
    current: Buffer,
    temporary: string,
  ): Promise<boolean> {
    const base = workspace.base
      ? await gitBytes(path, ['cat-file', 'blob', `${workspace.base}:${file}`]).catch(() => null)
      : null;
    if ([copied, base, last, current].some((content) => content?.includes(0))) return false;
    const brought = diffLines(await contentDiff(path, file, base, copied, temporary));
    if (!brought.added.size && !brought.removed.size) return false;
    const left = diffLines(await contentDiff(path, file, last, current, temporary));
    return (
      ![...brought.added].some((line) => left.added.has(line)) &&
      ![...brought.removed].some((line) => left.removed.has(line))
    );
  }
  private startingWorkspace(view: WorktreeView): Workspace {
    const workspace = view.sessionId ? this.workspaceOf(view.sessionId) : null;
    if (workspace?.mode !== 'isolated' || canonicalWorktreePath(workspace.root) !== view.path)
      throw new WorktreeError(
        'Le contenu de départ de cette copie est inconnu : rien ne peut être retiré automatiquement.',
      );
    return workspace;
  }
  /**
   * Files the integration would leave in conflict, cached per pair of commits. A simulation can take seconds on
   * a copy far behind its target: it runs in the background, one at a time, and appears at a later refresh.
   */
  private forecast(view: WorktreeView): string[] | null {
    const key = `${view.path}\0${view.head}\0${view.targetHead}`;
    if (this.forecasts.has(key)) return this.forecasts.get(key)!;
    if (this.closed || this.forecastQueued.has(key)) return null;
    this.forecastQueued.add(key);
    const task = this.forecastQueue
      .then(async () => {
        if (this.closed) return;
        const temporary = await mkdtemp(join(tmpdir(), 'cerebro-forecast-'));
        let conflicts: string[] | null;
        try {
          const simulated = await this.simulateTargetMerge(view, temporary);
          conflicts = simulated && 'conflicts' in simulated ? simulated.conflicts : [];
        } catch {
          conflicts = null;
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
        if (this.forecasts.size >= 200) this.forecasts.delete(this.forecasts.keys().next().value!);
        this.forecasts.set(key, conflicts);
      })
      .catch(() => {
        /* A failed simulation leaves the forecast unknown. */
      })
      .finally(() => this.forecastQueued.delete(key));
    this.forecastQueue = task;
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return null;
  }
  private async assertEditable(view: WorktreeView): Promise<void> {
    if (this.closed) throw new WorktreeError('Serveur en cours d’arrêt.');
    if (view.error) throw new WorktreeError(view.error);
    if (!view.managed || view.primary)
      throw new WorktreeError('Worktree principal ou géré hors de Cerebro : lecture seule.');
    if (view.operation?.status === 'running') throw new WorktreeError('Une opération utilise ce worktree.');
    const busy = activityReasons(repositoryActivity(this.db, view.path), false);
    if (busy.length) throw new WorktreeError(busy.join('\n'));
    if ((await this.services.pushes.current(view.path))?.status === 'running')
      throw new WorktreeError('Un push est en cours.');
  }
  /**
   * Merges the target into the copy, so conflicts are resolved in the copy rather than in the target's folder.
   * A clean merge is committed at once; otherwise the merge stays in progress in the copy.
   */
  async updateFromTarget(id: string): Promise<WorktreeView> {
    const view = await this.get(id);
    await this.assertEditable(view);
    if (view.mergeInProgress) throw new WorktreeError('Une opération Git doit être résolue dans ce worktree.');
    if (view.dirty)
      throw new WorktreeError(
        `La copie contient ${view.dirty} fichier(s) non commité(s) : enregistrez le travail avant de la mettre à jour.`,
      );
    if (!view.targetHead || !view.behind)
      throw new WorktreeError('La copie contient déjà tous les commits de la cible.');
    const release = this.services.gate.lock([view.path]);
    try {
      const message = `Copie : intégrer ${branchLabel(view.targetBranch, 'la cible')}`;
      const clean = await git(view.path, ['merge', '--no-ff', '--no-commit', '-m', message, view.targetHead]).then(
        () => true,
        () => false,
      );
      // Committed apart from the merge, so the branch history records a commit, as for the conversation's own commits.
      if (clean) await commitTargetUpdate(view.path);
      else if (!existsSync(join((await git(view.path, ['rev-parse', '--absolute-git-dir'])).trim(), 'MERGE_HEAD')))
        throw new WorktreeError('Git n’a pas pu commencer la mise à jour de la copie.');
      return await this.inspect(this.record(id));
    } finally {
      release();
    }
  }
  /** Abandons a merge in progress in the copy: the copy returns to its last commit. */
  async abortTargetUpdate(id: string): Promise<WorktreeView> {
    const view = await this.get(id);
    await this.assertEditable(view);
    if (!view.mergeInProgress) throw new WorktreeError('Aucune mise à jour en cours dans cette copie.');
    const release = this.services.gate.lock([view.path]);
    try {
      await git(view.path, ['merge', '--abort']);
      return await this.inspect(this.forgetResolver(id));
    } finally {
      release();
    }
  }
  /** Commits a merge whose conflicts were resolved in the copy. */
  async finishTargetUpdate(id: string): Promise<WorktreeView> {
    const view = await this.get(id);
    await this.assertEditable(view);
    if (!view.mergeInProgress) throw new WorktreeError('Aucune mise à jour en cours dans cette copie.');
    const release = this.services.gate.lock([view.path]);
    try {
      const remaining = await remainingConflictMarkers(view.path, view.conflicts);
      if (remaining.length) throw new WorktreeError(`Marqueurs de conflit encore présents : ${remaining.join(', ')}.`);
      if (view.conflicts.length)
        await git(view.path, ['add', '-A', '--', ...view.conflicts.map((file) => `:(literal)${file}`)]);
      await commitTargetUpdate(view.path);
      return await this.inspect(this.forgetResolver(id));
    } finally {
      release();
    }
  }
  /** Links the session launched to resolve the conflicts of the merge `mergeHead` to the copy. */
  rememberResolver(id: string, sessionId: string, mergeHead: string): void {
    store(this.db, { ...this.record(id), conflictResolution: { sessionId, mergeHead, startedAt: Date.now() } });
  }
  /** Once the merge is finished or abandoned, its resolution session stays an ordinary conversation. */
  private forgetResolver(id: string): WorktreeRecord {
    const record = this.record(id);
    if (!record.conflictResolution) return record;
    delete record.conflictResolution;
    store(this.db, record);
    return record;
  }
  /**
   * What resolving the merge of the target left in conflict in the copy needs: the commits of both sides since their
   * merge base and, for each file in conflict, what each side did to it and the commits that touched it. Read only.
   */
  async conflictResolution(id: string): Promise<ConflictContext> {
    const view = await this.get(id);
    if (view.error) throw new WorktreeError(view.error);
    if (!view.mergeInProgress || !view.conflicts.length)
      throw new WorktreeError('Aucun conflit de mise à jour en cours dans cette copie.');
    const mergeHead = (await git(view.path, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).catch(() => '')).trim();
    if (!mergeHead) throw new WorktreeError('Les conflits en cours ne viennent pas d’une mise à jour de la copie.');
    const base = (await git(view.path, ['merge-base', 'HEAD', mergeHead]).catch(() => '')).trim();
    if (!base) throw new WorktreeError('La copie et la cible n’ont pas d’historique commun.');
    const [ours, theirs] = await Promise.all([
      mergeSide(view.path, base, 'HEAD'),
      mergeSide(view.path, base, mergeHead),
    ]);
    const files: ConflictFile[] = [];
    for (const path of view.conflicts) {
      // A file renamed on one side is followed under its former name on the other.
      const names = [...new Set([path, ours.changes.get(path)?.from ?? theirs.changes.get(path)?.from ?? path])];
      const state = (side: MergeSide): ConflictSideState =>
        names.map((name) => side.changes.get(name)?.state).find((value) => value !== undefined) ?? 'unchanged';
      const subjects = async (revision: string): Promise<string[]> =>
        (
          await git(view.path, [
            'log',
            '-n',
            '10',
            '--format=%s',
            `${base}..${revision}`,
            '--',
            ...names.map((name) => `:(literal)${name}`),
          ])
        )
          .split('\n')
          .filter(Boolean);
      files.push({
        path,
        ours: state(ours),
        theirs: state(theirs),
        oursCommits: await subjects('HEAD'),
        theirsCommits: await subjects(mergeHead),
      });
    }
    return {
      view,
      mergeHead,
      base,
      files,
      oursCommits: ours.commits,
      theirsCommits: theirs.commits,
      resolved: view.conflicts.filter((file) => !view.remainingMarkers.includes(file)),
    };
  }
  /**
   * Merges the target into the copy's last commit without touching the copy: with `git merge-tree` when Git has it,
   * otherwise inside a temporary index. Null when there is nothing to merge.
   */
  private async simulateTargetMerge(view: WorktreeView, temporary: string): Promise<SimulatedMerge | null> {
    if (!view.targetHead || !view.behind || !view.head) return null;
    const base = (await git(view.path, ['merge-base', 'HEAD', view.targetHead]).catch(() => '')).trim();
    if (!base) return null;
    if (await mergeTreeAvailable()) {
      const args = ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', 'HEAD', view.targetHead];
      const result = await runGit(['-C', view.path, ...args], { kind: 'write', env: gitEnv() });
      // Exit status 1 reports conflicts; any other failure is not a forecast.
      if (result.code !== 0 && result.code !== 1)
        throw new GitError(result.stderr.toString('utf8').trim() || `git merge-tree : code ${result.code}`, result);
      const [tree, ...conflicts] = splitZ(result.stdout.toString('utf8'));
      if (result.code === 1) return { conflicts };
      return {
        tree,
        commits: view.behind,
        read: (file) => gitBytes(view.path, ['cat-file', 'blob', `${tree}:${file}`]).catch(() => null),
      };
    }
    return this.simulateInIndex(view, base, temporary);
  }
  /**
   * The merge of `simulateTargetMerge` for a Git without `merge-tree --write-tree`: a three-way merge of the trees,
   * then of each file changed on both sides, following a file renamed on one side and modified on the other.
   * Directory renames and a file renamed on both sides are not followed, as `APPROXIMATE_FORECAST` says.
   */
  private async simulateInIndex(view: WorktreeView, base: string, temporary: string): Promise<SimulatedMerge> {
    const index = { index: join(temporary, 'merge-index') };
    const renames = async (side: string): Promise<Map<string, string>> => {
      const fields = (await git(view.path, ['diff', '--name-status', '-z', '-M', '--diff-filter=R', base, side])).split(
        '\0',
      );
      const renamed = new Map<string, string>();
      for (let i = 0; i + 2 < fields.length; i += 3) renamed.set(fields[i + 1], fields[i + 2]);
      return renamed;
    };
    const renamedBy = { 2: await renames('HEAD'), 3: await renames(view.targetHead!) };
    await git(view.path, ['read-tree', '-i', '-m', '--aggressive', base, 'HEAD', view.targetHead!], index);
    const stages = new Map<string, Map<number, { mode: string; oid: string }>>();
    for (const entry of splitZ(await git(view.path, ['ls-files', '-u', '-z'], index))) {
      const [info, path] = [entry.slice(0, entry.indexOf('\t')), entry.slice(entry.indexOf('\t') + 1)];
      const [mode, oid, stage] = info.split(' ');
      if (!stages.has(path)) stages.set(path, new Map());
      stages.get(path)!.set(Number(stage), { mode, oid });
    }
    const conflicts: string[] = [];
    for (const [file, entry] of stages) {
      let path = file;
      let ours = entry.get(2);
      let theirs = entry.get(3);
      const ancestor = entry.get(1);
      // Deleted on one side because renamed there: the renamed file, untouched by the other side, takes its changes.
      const side = ancestor && !ours && theirs ? 2 : ancestor && ours && !theirs ? 3 : null;
      const renamed = side ? renamedBy[side].get(file) : undefined;
      if (side && renamed && !stages.has(renamed)) {
        const [mode, oid] = (await git(view.path, ['ls-files', '-s', '-z', '--', `:(literal)${renamed}`], index)).split(
          ' ',
        );
        if (mode && oid) {
          path = renamed;
          if (side === 2) ours = { mode, oid };
          else theirs = { mode, oid };
          await git(view.path, ['update-index', '--force-remove', '--', file], index);
        }
      }
      if (!ours || !theirs || ours.mode !== theirs.mode || ours.mode === '120000') {
        conflicts.push(path);
        continue;
      }
      const files = ['ancestor', 'ours', 'theirs'].map((name) => join(temporary, `merge-${name}`));
      await writeFile(files[0], ancestor ? await gitBytes(view.path, ['cat-file', 'blob', ancestor.oid]) : '');
      await writeFile(files[1], await gitBytes(view.path, ['cat-file', 'blob', ours.oid]));
      await writeFile(files[2], await gitBytes(view.path, ['cat-file', 'blob', theirs.oid]));
      const merged = await gitBytes(view.path, ['merge-file', '-p', files[1], files[0], files[2]]).catch(() => null);
      if (!merged) {
        conflicts.push(path);
        continue;
      }
      await writeFile(files[1], merged);
      const oid = (await git(view.path, ['hash-object', '-w', '--', files[1]])).trim();
      await git(view.path, ['update-index', '--cacheinfo', `${ours.mode},${oid},${path}`], index);
    }
    if (conflicts.length) return { conflicts };
    const tree = (await git(view.path, ['write-tree'], index)).trim();
    return {
      tree,
      commits: view.behind!,
      read: (file) => gitBytes(view.path, ['cat-file', 'blob', `${tree}:${file}`]).catch(() => null),
    };
  }
  /**
   * Decides, file by file, how the starting content leaves the copy while the changes made since stay.
   * With `merge`, every dirty file is carried onto the merged version; null when one of the conversation's
   * files cannot be, since writing it unchanged would silently undo the target's changes. A mixed file without
   * starting content left, or `confirmed` as such, is settled: it stays as is and becomes the conversation's work.
   */
  private async planFiles(
    view: WorktreeView,
    workspace: Workspace,
    paths: string[],
    merge: TargetMerge | null,
    temporary: string,
    confirmed: StartingConfirmation[],
  ): Promise<PlannedFile[] | null> {
    const planned: PlannedFile[] = [];
    for (const path of paths) {
      const file = await this.planFile(view, workspace, path, merge, temporary, confirmed);
      if (!file) return null;
      planned.push(file);
    }
    return planned;
  }
  /** Plans one dirty file; null when its changes cannot be carried onto the merged version. */
  private async planFile(
    view: WorktreeView,
    workspace: Workspace,
    path: string,
    merge: TargetMerge | null,
    temporary: string,
    confirmed: StartingConfirmation[],
  ): Promise<PlannedFile | null> {
    const versions = await fileVersions(view.path, path, merge, temporary);
    const { file, current, signature } = versions;
    const inherited = workspace.baseline[path] === signature;
    if (!inherited && !workspace.initialDirty.includes(path)) {
      if (!versions.changedByMerge) return file;
      const carried = await versions.carry();
      if (carried === undefined) return null;
      file.write = carried;
      return file;
    }
    const found = await this.findStarting(view.path, workspace, view.targetPath, view.targetHead, path).catch(
      () => null,
    );
    const step: StartingContentStep = {
      path,
      state: inherited ? 'inherited' : 'mixed',
      origin: found?.origin ?? null,
      action: 'keep',
      reason: null,
      diff: '',
      version: signature ?? null,
    };
    file.step = step;
    const settled =
      !inherited &&
      !!found &&
      !!current &&
      (await this.mixedStartingState(view.path, workspace, view.head!, path, found.content).catch(
        (): MixedStartingState => 'manual',
      )) === 'settled';
    if (settled || (!inherited && confirmed.some((entry) => entry.path === path && entry.version === signature)))
      return (await planSettled(view.path, versions, step, settled, temporary)) ? file : null;
    if (inherited) {
      step.action = 'restore';
      file.write = file.next;
      if (!found)
        step.reason =
          'Ce contenu n’existe plus que dans cette copie : il ne se trouve ni dans la cible, ni dans le dossier du projet.';
      return file;
    }
    const separated = await separation(view.path, workspace, versions, found);
    if (typeof separated !== 'string') {
      step.action = 'separate';
      file.write = separated;
      step.diff = await contentDiff(view.path, path, file.next, separated, temporary);
      return file;
    }
    return (await planReview(view.path, versions, step, separated, temporary)) ? file : null;
  }
  private async planStartingContent(
    view: WorktreeView,
    workspace: Workspace,
    temporary: string,
    confirmed: StartingConfirmation[] = [],
  ): Promise<PlannedStarting> {
    const shared = await sharedDependencyLinks(workspace, view.path);
    const paths = parseStatusZ(await git(view.path, STATUS)).filter((path) => !underShared(path, shared));
    const simulated = await this.simulateTargetMerge(view, temporary).catch(() => null);
    const merge = simulated && 'tree' in simulated ? simulated : null;
    const merged = merge ? await this.planFiles(view, workspace, paths, merge, temporary, confirmed) : null;
    if (merge && merged) return { files: merged, merge };
    return { files: (await this.planFiles(view, workspace, paths, null, temporary, confirmed))!, merge: null };
  }
  private publicPlan(view: WorktreeView, plan: PlannedStarting): StartingContentPlan {
    return {
      targetUpdate: plan.merge && view.targetBranch ? { branch: view.targetBranch, commits: plan.merge.commits } : null,
      steps: plan.files.flatMap((file) => (file.step ? [file.step] : [])),
    };
  }
  /** Preview of « Retirer le contenu de départ », without touching the copy. */
  async startingContentPlan(id: string): Promise<StartingContentPlan> {
    const view = await this.get(id);
    if (view.error) throw new WorktreeError(view.error);
    const workspace = this.startingWorkspace(view);
    const temporary = await mkdtemp(join(tmpdir(), 'cerebro-starting-'));
    try {
      return this.publicPlan(view, await this.planStartingContent(view, workspace, temporary));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  /** What a session needs to settle, in the copy, the files the automatic removal leaves for a manual review. */
  async startingContentResolution(
    id: string,
  ): Promise<{ view: WorktreeView; workspace: Workspace; plan: StartingContentPlan }> {
    const { view, workspace } = await this.startingEditable(id);
    const temporary = await mkdtemp(join(tmpdir(), 'cerebro-starting-'));
    try {
      const plan = this.publicPlan(view, await this.planStartingContent(view, workspace, temporary));
      if (!plan.steps.some((step) => step.action === 'keep'))
        throw new WorktreeError(
          'Aucun fichier n’est laissé à examiner : « Retirer le contenu de départ » les traite tous.',
        );
      return { view, workspace, plan };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  /** The copy and its starting content, when nothing prevents changing its files. */
  private async startingEditable(id: string): Promise<{ view: WorktreeView; workspace: Workspace }> {
    if (this.closed) throw new WorktreeError('Serveur en cours d’arrêt.');
    const view = await this.get(id);
    await this.assertEditable(view);
    if (view.mergeInProgress) throw new WorktreeError('Une opération Git doit être résolue dans ce worktree.');
    return { view, workspace: this.startingWorkspace(view) };
  }
  /**
   * Removes the content copied from the project at creation. When the target moved on, the copy first receives
   * its commits (a merge commit), so the changes kept apply to its latest version. Files untouched since the copy
   * take that version; files edited since keep only those edits when the starting content can be found.
   */
  async discardInherited(id: string, confirmations: unknown = []): Promise<StartingContentDiscard> {
    const confirmed = parseConfirmations(confirmations);
    const { view, workspace } = await this.startingEditable(id);
    const release = this.services.gate.lock([view.path]);
    const temporary = await mkdtemp(join(tmpdir(), 'cerebro-starting-'));
    try {
      const plan = await this.planStartingContent(view, workspace, temporary, confirmed);
      const steps = await assertPlanApplicable(view.path, plan, confirmed);
      await applyStartingPlan(view, plan);
      const restored = steps.filter((step) => step.action === 'restore').map((step) => step.path);
      const separated = steps.filter((step) => step.action === 'separate').map((step) => step.path);
      const settled = steps.filter((step) => step.action === 'settle').map((step) => step.path);
      await this.forgetStartingContent(view, workspace, plan, new Set([...restored, ...separated, ...settled]));
      return {
        restored,
        separated,
        settled,
        kept: steps.filter((step) => step.action === 'keep'),
        targetUpdate: this.publicPlan(view, plan).targetUpdate,
        view: await this.inspect(this.record(id)),
      };
    } finally {
      release();
      await rm(temporary, { recursive: true, force: true });
    }
  }
  /** The `done` files now start from the copy's last commit: what changes in them next belongs to the copy. */
  private async forgetStartingContent(
    view: WorktreeView,
    workspace: Workspace,
    plan: PlannedStarting,
    done: Set<string>,
  ): Promise<void> {
    workspace.initialDirty = workspace.initialDirty.filter((file) => !done.has(file));
    for (const file of plan.files)
      if (done.has(file.path)) {
        if (file.next === null) delete workspace.baseline[file.path];
        else
          workspace.baseline[file.path] = regularFileSignature(
            (await lstat(join(view.path, file.path))).mode,
            file.next,
          );
      }
    this.db.connection
      .prepare('UPDATE session_workspaces SET data=? WHERE session_id=?')
      .run(JSON.stringify(workspace), workspace.sessionId);
  }
  /**
   * Validates a merge or removal and returns the single-use token that `start` requires to run it. `deleteIgnored`:
   * the removal also deletes the ignored entries with something to lose, listed in the view the user confirms.
   */
  async prepareAction(id: string, kind: 'merge' | 'remove', deleteIgnored = false): Promise<PreparedWorktreeOperation> {
    const view = await this.get(id);
    const blockers = actionBlockers(view, kind, deleteIgnored);
    if (blockers.length || !view.fingerprint) throw new WorktreeError(blockers.join('\n'));
    const ignored = kind === 'remove' && deleteIgnored ? await this.keptIgnored(this.record(id)) : [];
    const token = randomUUID();
    for (const [key, plan] of this.plans) if (plan.expires < Date.now()) this.plans.delete(key);
    if (this.plans.size >= 100) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(token, {
      id,
      kind,
      fingerprint: view.fingerprint,
      expires: Date.now() + 10 * 60_000,
      deleteIgnored: ignored,
    });
    return { token, view };
  }
  /** Paths the project of the copy declares regenerable. */
  private declaredRegenerable(record: WorktreeRecord): ReadonlySet<string> {
    return new Set(record.projectId ? (this.db.getProject(record.projectId)?.regenerablePaths ?? []) : []);
  }
  private async keptIgnored(record: WorktreeRecord): Promise<string[]> {
    const workspace = record.sessionId ? this.workspaceOf(record.sessionId) : null;
    return (await classifyIgnored(record, workspace, this.declaredRegenerable(record))).kept;
  }
  async start(id: string, kind: 'merge' | 'remove', token: unknown): Promise<WorktreeOperation> {
    const { operation, done } = await this.begin(id, kind, token, false);
    // Nobody awaits a manual operation: its outcome is recorded, a late failure (saving it) is only logged.
    void done.catch((cause) =>
      console.error('[worktrees] Fin d’opération non enregistrée :', cause instanceof Error ? cause.message : cause),
    );
    return operation;
  }
  private async begin(
    id: string,
    kind: 'merge' | 'remove',
    token: unknown,
    automatic: boolean,
  ): Promise<{ operation: WorktreeOperation; done: Promise<void> }> {
    if (this.closed) throw new WorktreeError('Serveur en cours d’arrêt.');
    const plan = typeof token === 'string' ? this.plans.get(token) : undefined;
    if (!plan || plan.id !== id || plan.kind !== kind || plan.expires < Date.now())
      throw new WorktreeError('Sélection absente, expirée ou déjà utilisée.');
    const view = await this.get(id);
    if (view.fingerprint !== plan.fingerprint)
      throw new WorktreeError('L’état Git a changé depuis la confirmation : préparez de nouveau l’action.');
    const blockers = actionBlockers(view, kind, plan.deleteIgnored.length > 0);
    if (blockers.length) throw new WorktreeError(blockers.join('\n'));
    if (this.plans.get(token as string) !== plan) throw new WorktreeError('Sélection déjà utilisée.');
    const release = this.services.gate.lock([
      view.path,
      ...(kind === 'merge' && view.targetPath ? [view.targetPath] : []),
    ]);
    this.plans.delete(token as string);
    const operation: WorktreeOperation = {
      id: randomUUID(),
      worktreeId: id,
      kind,
      status: 'running',
      targetBranch: view.targetBranch,
      sourceHead: view.head,
      targetHead: view.targetHead,
      resultHead: null,
      output: '',
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      ...(automatic ? { automatic } : {}),
    };
    try {
      this.saveOperation(operation);
    } catch (cause) {
      release();
      throw cause;
    }
    const promise = this.execute(view, operation, plan.fingerprint, plan.deleteIgnored).finally(() => {
      release();
      this.pending.delete(promise);
    });
    this.pending.add(promise);
    return { operation: { ...operation }, done: promise };
  }
  private async execute(
    view: WorktreeView,
    operation: WorktreeOperation,
    fingerprint: string,
    deleteIgnored: string[],
  ): Promise<void> {
    try {
      const fresh = await this.inspect(this.record(view.id), operation.id);
      if (fresh.fingerprint !== fingerprint) throw new WorktreeError('État Git modifié avant exécution.');
      const blockers = actionBlockers(fresh, operation.kind, deleteIgnored.length > 0);
      if (blockers.length) throw new WorktreeError(blockers.join('\n'));
      if (operation.kind === 'merge') {
        // Keep the exact requested tip recoverable while merging, even if a branch is rewritten externally meanwhile.
        await git(view.path, ['update-ref', mergeRef(operation.id), view.head!]);
        try {
          if ((await git(view.targetPath!, ['symbolic-ref', '--quiet', 'HEAD'])).trim() !== view.targetBranch)
            throw new WorktreeError('La branche cible a changé.');
          try {
            operation.output = await git(view.targetPath!, ['merge', '--no-edit', '--', view.head!]);
          } catch (cause) {
            const failure = cause as Error & { stdout?: string; stderr?: string };
            operation.output = [failure.stdout, failure.stderr]
              .filter(Boolean)
              .join('\n')
              .slice(-64 * 1024);
            throw new WorktreeError(
              `Merge interrompu : ${failure.message}\nVérifiez ${view.targetPath}. Les conflits éventuels sont conservés ; aucun reset ni abandon automatique n’a été appliqué.`,
            );
          }
          operation.resultHead = (await git(view.targetPath!, ['rev-parse', 'HEAD'])).trim();
          if ((await git(view.targetPath!, ['symbolic-ref', '--quiet', 'HEAD'])).trim() !== view.targetBranch)
            throw new WorktreeError('La branche cible a changé pendant le merge : vérification manuelle requise.');
          await git(view.targetPath!, ['merge-base', '--is-ancestor', view.head!, 'HEAD']);
          operation.output = operation.output.slice(-64 * 1024);
        } finally {
          // Merged, the tip is in the target's history; interrupted, MERGE_HEAD and the source branch still hold it.
          await git(view.path, ['update-ref', '-d', mergeRef(operation.id)]).catch(() => '');
        }
      } else {
        const workspace = view.sessionId ? workspaceFor(this.db, view.sessionId) : null;
        const copy = this.record(view.id);
        const declared = this.declaredRegenerable(copy);
        // Checked again right before deletion: an entry edited since the inspection blocks the removal.
        for (const raw of fresh.disposableIgnored) {
          const name = raw.replace(/\/$/, '');
          if (!(await disposableIgnored(view.path, view.source, name, declared)))
            throw new WorktreeError(`${name} a changé : retrait annulé, rien n’a été supprimé de la copie.`);
        }
        // Git deletes every ignored entry: those with something to lose go only when the user confirmed each of them.
        if ((await this.keptIgnored(copy)).some((name) => !deleteIgnored.includes(name)))
          throw new WorktreeError(
            'Les fichiers ignorés ont changé depuis la confirmation : préparez de nouveau le retrait.',
          );
        // Git deletes the ignored entries checked above itself, without following links, and refuses a copy
        // locked or dirtied meanwhile. Only the shared dependency links, untracked for Git, go beforehand:
        // they are put back if the removal fails, so the copy kept stays usable.
        const links: { name: string; target: string }[] = [];
        for (const name of await sharedDependencyLinks(workspace ?? view, view.path))
          links.push({ name, target: await readlink(join(view.path, name)) });
        try {
          for (const link of links) await rm(join(view.path, link.name));
          await git(view.targetPath ?? view.source, ['worktree', 'remove', '--', view.path]);
        } catch (cause) {
          const lost: string[] = [];
          for (const link of links)
            if (!(await lstat(join(view.path, link.name)).catch(() => null)))
              await symlink(link.target, join(view.path, link.name), 'dir').catch(() => lost.push(link.name));
          if (lost.length)
            throw new WorktreeError(
              `${cause instanceof Error ? cause.message : String(cause)}\nLiens de dépendances non rétablis dans la copie : ${lost.join(', ')}.`,
            );
          throw cause;
        }
        if (workspace?.startingCopy) await rm(workspace.startingCopy, { recursive: true, force: true });
        if (workspace?.startingSnapshot)
          await git(view.targetPath ?? view.source, [
            'update-ref',
            '-d',
            `refs/cerebro/starting/${workspace.sessionId}`,
          ]).catch(() => '');
        const record = this.record(view.id);
        record.removedAt = Date.now();
        store(this.db, record);
        // Every epic step sharing this copy loses it, not only the session that created it.
        const changed: string[] = [];
        for (const [sessionId, workspace] of sessionWorkspaces(this.db)) {
          if (
            sessionId !== record.sessionId &&
            (workspace.mode !== 'isolated' || canonicalWorktreePath(workspace.root) !== record.path)
          )
            continue;
          workspace.removedAt = record.removedAt;
          if (operation.automatic) workspace.removedAutomatically = true;
          this.db.connection
            .prepare('UPDATE session_workspaces SET data=? WHERE session_id=?')
            .run(JSON.stringify(workspace), sessionId);
          changed.push(sessionId);
        }
        if (changed.length) this.onSessionsChanged(changed);
        operation.output = operation.automatic
          ? 'Copie nettoyée automatiquement après la fin de la conversation : rien n’était à conserver. Branche, commits et conversation conservés.'
          : 'Worktree supprimé ; branche, commits et conversation conservés.';
      }
      operation.status = 'succeeded';
    } catch (cause) {
      operation.status = 'failed';
      operation.error = errorMessage(cause);
    } finally {
      operation.finishedAt = Date.now();
      this.saveOperation(operation);
    }
  }
  /**
   * A conversation ended (its process really stopped) or was deleted: its copy is removed if nothing in it remains to keep.
   * `root` is captured by the caller while the session's workspace record still exists, so copies shared by epic steps are found too.
   */
  releaseSession(sessionId: string, root: string | null): Promise<void> {
    const path = root ? canonicalWorktreePath(root) : null;
    return this.queueCleanup(
      `session:${sessionId}`,
      (record) => record.sessionId === sessionId || record.path === path,
    );
  }
  /** After a restart or the end of an epic: retries every copy whose conversation is over. */
  resumeAutomaticCleanup(projectId?: string): Promise<void> {
    return this.queueCleanup(`sweep:${projectId ?? ''}`, (record) => !projectId || record.projectId === projectId);
  }
  private queueCleanup(key: string, selects: (record: WorktreeRecord) => boolean): Promise<void> {
    // A trigger already waiting will see the latest state: repeating it would only inspect the same copies twice.
    if (this.closed || this.cleanupQueued.has(key)) return this.cleanupQueue;
    this.cleanupQueued.add(key);
    const task = this.cleanupQueue
      .then(async () => {
        this.cleanupQueued.delete(key);
        if (this.closed) return;
        await this.sync();
        for (const record of records(this.db).filter(
          (r) => r.managed && !r.removedAt && r.sessionId !== null && selects(r),
        ))
          await this.cleanAutomatically(record.id);
      })
      .catch(() => {
        /* Each decision is persisted on its record; a failed discovery is retried at the next trigger. */
      });
    this.cleanupQueue = task;
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return task;
  }
  private async cleanAutomatically(id: string): Promise<void> {
    const record = records(this.db).find((r) => r.id === id && !r.removedAt);
    if (!record?.managed || !record.sessionId || this.closed) return;
    const session = this.db.getSession(record.sessionId);
    // An idle or open conversation is not over: only an effective stop or a deletion releases its copy.
    if (session && session.status !== 'exited') return;
    let decision: AutomaticCleanup;
    try {
      // The epic runner reuses a step's copy for the next one before it records that copy as its context.
      const epic = (this.db.connection.prepare('SELECT data FROM epic_runs').all() as { data: string }[])
        .map((row) => JSON.parse(row.data))
        .some((run) => isActiveRun(run) && run.projectId === record.projectId);
      if (epic)
        throw new WorktreeError('Un epic du projet est en cours : ses étapes peuvent encore utiliser cette copie.');
      const { token } = await this.prepareAction(id, 'remove');
      if (this.closed) return;
      const { operation, done } = await this.begin(id, 'remove', token, true);
      await done;
      const result = this.operations().find((op) => op.id === operation.id);
      decision =
        result?.status === 'succeeded'
          ? { status: 'removed', at: Date.now(), reasons: [] }
          : { status: 'failed', at: Date.now(), reasons: [result?.error ?? 'Retrait interrompu.'] };
    } catch (cause) {
      if (this.closed) return;
      decision = { status: 'kept', at: Date.now(), reasons: errorMessage(cause).split('\n').filter(Boolean) };
    }
    // Re-read synchronously: the removal, a rename or an archive may have updated the record meanwhile.
    const fresh = records(this.db).find((r) => r.id === id);
    if (fresh) {
      fresh.autoCleanup = decision;
      store(this.db, fresh);
    }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }
}
