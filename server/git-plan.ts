import { canonicalWorktreePath, type WorktreeGate } from './worktree-gate.ts';
import { GitOutputLimitError } from './git-process.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readlink,
  rename,
  rm,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { GitPushes } from './git-push.ts';
import { git as runGit, GitError, repositoryRoot, splitZ, type GitOptions } from './git.ts';
import {
  SECRET_WARNING,
  type CommitResult,
  type GitCandidate,
  type GitHunk,
  type GitSecret,
  type GitSnapshot,
} from '../shared/git.ts';
import { errorMessage } from './util.ts';
import { workspaceManifest } from './workspace-files.ts';

const LIMIT = 4 * 1024 * 1024;
const EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export interface CommitSelection {
  path: string;
  all?: boolean;
  hunks?: string[];
}
export interface CommitStep {
  message: string;
  selection: CommitSelection[];
}
/** A file declared a false positive of the secret scanner, in the diff that snapshot showed. */
export interface SecretOverride {
  path: string;
  snapshotId: string;
}
export interface CommitPlan {
  snapshotId: string;
  commits: CommitStep[];
  acknowledged: string[];
  /** Never implied: a blocked file is only committed when listed here with the snapshot that showed its exact diff. */
  overrides?: SecretOverride[];
  push: boolean;
}
interface Saved {
  path: string;
  snapshot: GitSnapshot;
  work: string;
  manifest: Record<string, string>;
  index: string;
  branch: string | null;
  used: boolean;
}

/** `diff --no-index` exits with 1 when the files differ: that is its output, not a failure. */
const git = (path: string, args: string[], options: GitOptions = {}): Promise<string> =>
  runGit(path, args, { maxBuffer: LIMIT, ...options }).catch((cause) => {
    if (cause instanceof GitOutputLimitError) throw new Error('Contexte Git trop volumineux (4 Mio).');
    if (cause instanceof GitError && cause.code === 1 && args.includes('--no-index')) return cause.stdout;
    throw cause;
  });
async function branch(path: string): Promise<string | null> {
  return (await git(path, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim() || null;
}
async function head(path: string): Promise<string | null> {
  return (await git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim() || null;
}
async function indexPath(path: string): Promise<string> {
  return resolve(path, (await git(path, ['rev-parse', '--git-path', 'index'])).trim());
}
// A bisect is absent: it only moves HEAD, and committing there reads none of its state.
const OPERATIONS: [string, string][] = [
  ['MERGE_HEAD', 'une fusion (merge)'],
  ['CHERRY_PICK_HEAD', 'un cherry-pick'],
  ['REVERT_HEAD', 'un revert'],
  ['REBASE_HEAD', 'un rebase'],
  ['rebase-merge', 'un rebase'],
  ['rebase-apply', 'un rebase ou git am'],
];
/** Refusal to commit while a Git operation is in progress: `git commit` would read its state (MERGE_HEAD becomes a second parent). */
export class GitOperationInProgress extends Error {
  readonly operation?: string;
  constructor(message: string, operation?: string) {
    super(message);
    this.operation = operation;
  }
}
/** Throws while a merge, cherry-pick, revert or rebase is in progress in this worktree; only commit creation needs it, never read-only views. */
export async function assertNoGitOperation(path: string): Promise<void> {
  const locations = (await git(path, ['rev-parse', ...OPERATIONS.flatMap(([name]) => ['--git-path', name])])).split(
    '\n',
  );
  for (const [position, [, label]] of OPERATIONS.entries()) {
    const location = resolve(path, locations[position]);
    if (
      await lstat(location).then(
        () => true,
        (cause) => {
          if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw cause;
        },
      )
    )
      throw new GitOperationInProgress(
        `Opération Git en cours (${label}) : terminez-la ou annulez-la avant de créer un commit.`,
        label,
      );
  }
}
/** Takes the real index lock with Git's own protocol; a lock held elsewhere is a retryable refusal, not a failure. */
async function lockIndex(index: string): Promise<FileHandle> {
  return open(`${index}.lock`, 'wx').catch((cause: NodeJS.ErrnoException) => {
    throw cause.code === 'EEXIST'
      ? new GitOperationInProgress('Une autre opération Git est en cours (index.lock) : réessayez.', 'index.lock')
      : cause;
  });
}
async function indexHash(path: string): Promise<string> {
  return hash(
    await readFile(await indexPath(path)).catch((cause) => {
      if (cause.code === 'ENOENT') return Buffer.alloc(0);
      throw cause;
    }),
  );
}
/** Reads and hashes every Git-visible file: the costliest check, kept to the points where the worktree may have moved. */
const manifestHash = (manifest: Record<string, string>): string => hash(JSON.stringify(manifest));
async function workHash(path: string): Promise<string> {
  return manifestHash(await workspaceManifest(path));
}
function hunks(diff: string): GitHunk[] {
  const start = diff.indexOf('\n@@ ');
  if (start < 0 || /^(new file mode|deleted file mode|old mode|new mode|GIT binary patch)/m.test(diff)) return [];
  const prefix = diff.slice(0, start + 1);
  // The position keeps ids unique even if two hunks of a file had identical text.
  return diff
    .slice(start + 1)
    .split(/(?=^@@ )/m)
    .filter(Boolean)
    .map((hunk, position) => ({ id: hash(`${position}\0${prefix}${hunk}`), patch: prefix + hunk }));
}
const SECRETS: [GitSecret['kind'], RegExp][] = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['aws', /\bAKIA[0-9A-Z]{16}/g],
  ['github', /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['openai', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
];
export const SECRET_EXCLUSION = 'Secret détecté : dérogation absente ou diff modifié depuis l’examen.';
/** Shows what was recognized without revealing it; a key header is a public marker, not the key. */
const mask = (kind: GitSecret['kind'], value: string): string =>
  kind === 'private-key' ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
/** Recognized patterns on the added lines of the hunks, numbered in the new version of the file. */
function secrets(diff: string): GitSecret[] {
  const found: GitSecret[] = [];
  let line: number | null = null;
  for (const text of diff.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) line = Number(header[1]);
    else if (line === null || text.startsWith('\\')) continue;
    else if (text.startsWith('+')) {
      for (const [kind, pattern] of SECRETS)
        for (const match of text.matchAll(pattern)) found.push({ line, kind, excerpt: mask(kind, match[0]) });
      line++;
    } else if (!text.startsWith('-')) line++;
  }
  return found;
}
/** Warnings other than the secret one: those yield to an ordinary review (`acknowledged`). */
export const reviewWarnings = (file: GitCandidate): string[] => file.warnings.filter((w) => w !== SECRET_WARNING);
function scan(file: string, diff: string): { warnings: string[]; secrets: GitSecret[]; blocked: boolean } {
  const warnings: string[] = [];
  const found = secrets(diff);
  const blocked = found.length > 0;
  if (blocked) warnings.push(SECRET_WARNING);
  if (/(^|\/)(\.env(?:\.|$)|id_rsa|credentials|secrets?\b)/i.test(file))
    warnings.push('Fichier pouvant contenir des secrets : vérification explicite requise.');
  if (/(^|\/)(node_modules|dist|build|coverage|\.cache|tmp)(\/|$)|\.(log|tmp|bak|min\.js|map)$/.test(file))
    warnings.push('Fichier généré ou temporaire présumé : vérification explicite requise.');
  // Anchored to Git's own header line: a text file that merely mentions it is not binary.
  if (/^GIT binary patch$/m.test(diff)) warnings.push('Fichier binaire : contenu non inspecté par le scanner.');
  return { warnings, secrets: found, blocked };
}

export interface SharedDependencies {
  sharedIgnored?: string[];
  source: string;
}
/** Dependency directories linked from the source project into an isolated workspace, still pointing at it. */
export async function sharedDependencyLinks(
  workspace: SharedDependencies | null | undefined,
  root: string,
): Promise<string[]> {
  if (!workspace?.sharedIgnored?.length) return [];
  const active: string[] = [];
  for (const name of workspace.sharedIgnored) {
    const path = join(root, name);
    const stat = await lstat(path).catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw cause;
    });
    if (!stat?.isSymbolicLink()) continue;
    const target = resolve(dirname(path), await readlink(path));
    if (target === resolve(workspace.source, name)) active.push(name);
  }
  return active;
}

export function parseCommitPlan(value: unknown): CommitPlan {
  const p = value as CommitPlan;
  if (
    !p ||
    typeof p !== 'object' ||
    typeof p.snapshotId !== 'string' ||
    typeof p.push !== 'boolean' ||
    !Array.isArray(p.acknowledged) ||
    !p.acknowledged.every((x) => typeof x === 'string') ||
    (p.overrides !== undefined &&
      (!Array.isArray(p.overrides) ||
        !p.overrides.every((o) => o && typeof o.path === 'string' && typeof o.snapshotId === 'string'))) ||
    !Array.isArray(p.commits) ||
    p.commits.length === 0 ||
    p.commits.length > 50
  )
    throw new Error('Plan de commit invalide.');
  const seen = new Map<string, Set<string>>();
  for (const step of p.commits) {
    if (
      !step ||
      typeof step.message !== 'string' ||
      !step.message.trim() ||
      step.message.length > 10_000 ||
      !Array.isArray(step.selection) ||
      !step.selection.length
    )
      throw new Error('Message ou sélection invalide.');
    for (const selection of step.selection) {
      if (
        !selection ||
        typeof selection.path !== 'string' ||
        !(
          (selection.all === true && selection.hunks === undefined) ||
          (selection.all === undefined &&
            Array.isArray(selection.hunks) &&
            selection.hunks.length &&
            selection.hunks.every((h) => typeof h === 'string'))
        )
      )
        throw new Error('Sélection invalide : all=true ou hunks=[identifiants].');
      const previous = seen.get(selection.path) ?? new Set<string>();
      const ids = selection.all ? ['*'] : selection.hunks!;
      if (
        previous.has('*') ||
        (selection.all && previous.size) ||
        ids.some((id) => previous.has(id)) ||
        new Set(ids).size !== ids.length
      )
        throw new Error('Sélection répétée dans le plan.');
      ids.forEach((id) => previous.add(id));
      seen.set(selection.path, previous);
    }
  }
  return p;
}

/** Merge selected commit tree into the preexisting index, preserving staged edits.
 * Text conflicts are refused before committing; no heuristic attribution is used. */
async function mergedIndex(
  path: string,
  base: string,
  selected: string,
  staged: string,
  index: string,
  dir: string,
): Promise<void> {
  await git(path, ['read-tree', '-m', base, selected, staged], { index });
  const unmerged = splitZ(await git(path, ['ls-files', '-u', '-z'], { index }));
  const groups = new Map<string, { mode: string; oid: string; stage: string }[]>();
  for (const record of unmerged) {
    const separator = record.indexOf('\t');
    const meta = record.slice(0, separator);
    const file = record.slice(separator + 1);
    const [mode, oid, stage] = meta.split(' ');
    const rows = groups.get(file) ?? [];
    rows.push({ mode, oid, stage });
    groups.set(file, rows);
  }
  for (const [file, entries] of groups) {
    // Added on both sides: a new file has no hunks, so the commit takes it whole and,
    // like `git commit -- <file>`, its version replaces the staged one.
    const selectedEntry = entries.find((e) => e.stage === '2');
    if (
      entries.length === 2 &&
      selectedEntry &&
      entries.some((e) => e.stage === '3') &&
      entries.every((e) => e.mode === '100644' || e.mode === '100755')
    ) {
      await git(path, ['update-index', '--add', '--cacheinfo', selectedEntry.mode, selectedEntry.oid, file], { index });
      continue;
    }
    // Deleted on both sides (the other half of a staged rename).
    if (entries.length === 1 && entries[0].stage === '1') {
      await git(path, ['update-index', '--force-remove', '--', file], { index });
      continue;
    }
    if (
      entries.length !== 3 ||
      entries.some((e) => e.mode !== '100644' && e.mode !== '100755') ||
      new Set(entries.map((e) => e.mode)).size !== 1
    )
      throw new Error(`Conflit avec l’index préexistant : ${file}`);
    const locations: string[] = [];
    for (const stage of ['2', '1', '3']) {
      const location = join(dir, randomUUID());
      const content = await git(path, ['cat-file', 'blob', entries.find((e) => e.stage === stage)!.oid]);
      if (content.includes('\0') || content.includes('\ufffd'))
        throw new Error(
          `Fusion binaire ou encodage non UTF-8 : sélectionnez le fichier entier après vérification de l’index (${file}).`,
        );
      await writeFile(location, content);
      locations.push(location);
    }
    const merged = await git(path, ['merge-file', '-p', ...locations]).catch(() => {
      throw new Error(`Conflit avec les hunks déjà indexés : ${file}`);
    });
    const oid = (await git(path, ['hash-object', '-w', '--stdin'], { input: merged })).trim();
    await git(path, ['update-index', '--add', '--cacheinfo', entries[0].mode, oid, file], { index });
  }
}

/** The real index of a repository and, while a plan runs, the handle of its lock file. */
interface IndexLock {
  index: string;
  handle: FileHandle | null;
}
/** One commit of a plan, built in temporary indexes before anything is written. */
interface PreparedCommit {
  tree: string;
  /** Index holding exactly the commit's tree. */
  index: string;
  /** The preexisting index with this commit's changes merged in: the real index once it is committed. */
  merged: string;
  message: string;
}
/** Whether the branch, HEAD, worktree and index are still those of the snapshot. */
async function matchesSnapshot(saved: Saved, path: string): Promise<boolean> {
  return (
    saved.branch === (await branch(path)) &&
    saved.snapshot.head === (await head(path)) &&
    saved.work === (await workHash(path)) &&
    saved.index === (await indexHash(path))
  );
}
/** Files, or hunks, of the snapshot that no commit of the plan selects. */
function exclusions(plan: CommitPlan, snapshot: GitSnapshot): string[] {
  const selectedPaths = new Set(plan.commits.flatMap((step) => step.selection.map((s) => s.path)));
  return snapshot.files.flatMap((f) => {
    if (!selectedPaths.has(f.path)) return [f.path];
    const selections = plan.commits.flatMap((c) => c.selection).filter((s) => s.path === f.path);
    if (selections.some((s) => s.all)) return [];
    const selectedHunks = new Set(selections.flatMap((s) => s.hunks ?? []));
    return f.hunks.filter((h) => !selectedHunks.has(h.id)).map((h) => `${f.path} (hunk ${h.id})`);
  });
}
/** Tree of the preexisting index, read from a copy of it so the real one stays untouched. */
async function stagedTree(path: string, index: string, dir: string): Promise<string> {
  const original = join(dir, 'original');
  const bytes = await readFile(index).catch((cause) => {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  });
  if (bytes) await writeFile(original, bytes);
  else await git(path, ['read-tree', '--empty'], { index: original });
  return (await git(path, ['write-tree'], { index: original })).trim();
}
/** Patch of a selection: the whole file, or its selected hunks in their original order. */
function selectionPatch(
  plan: CommitPlan,
  snapshot: GitSnapshot,
  selection: CommitSelection,
  overridden: Set<string>,
): string {
  const file = snapshot.files.find((f) => f.path === selection.path);
  if (!file) throw new Error(`Fichier absent de la sélection collectée : ${selection.path}`);
  if (file.blocked && !overridden.has(file.path)) throw new Error(`${SECRET_EXCLUSION} (${file.path})`);
  if (reviewWarnings(file).length && !plan.acknowledged.includes(file.path))
    throw new Error(`Vérification explicite requise : ${file.path}`);
  if (selection.all) return file.diff;
  const hunks = selection.hunks!.map((id) => file.hunks.find((h) => h.id === id));
  if (hunks.some((h) => !h)) throw new Error(`Hunk inconnu : ${file.path}`);
  // Reuse one header and keep the original hunk order.
  const wanted = new Set(selection.hunks);
  return file.hunks
    .filter((h) => wanted.has(h.id))
    .map((h) => h.patch)
    .join('');
}
/**
 * Builds every commit of the plan in temporary indexes, each on top of the previous one, and checks that the
 * preexisting index can be kept around them. Nothing in the repository changes.
 */
async function prepareCommits(
  path: string,
  plan: CommitPlan,
  snapshot: GitSnapshot,
  index: string,
  dir: string,
  overridden: Set<string>,
): Promise<PreparedCommit[]> {
  let base = snapshot.head ?? EMPTY;
  let staged = await stagedTree(path, index, dir);
  const prepared: PreparedCommit[] = [];
  for (const [n, step] of plan.commits.entries()) {
    const temporary = join(dir, `commit-${n}`);
    await git(path, ['read-tree', base], { index: temporary });
    for (const selection of step.selection)
      // --3way rebases later hunks on the commits already prepared from this snapshot.
      await git(path, ['apply', '--cached', '--3way', '--whitespace=nowarn'], {
        index: temporary,
        input: selectionPatch(plan, snapshot, selection, overridden),
      });
    const tree = (await git(path, ['write-tree'], { index: temporary })).trim();
    const baseTree = (await git(path, ['rev-parse', `${base}^{tree}`])).trim();
    if (tree === baseTree) throw new Error('Commit vide dans le plan.');
    const merged = join(dir, `merged-${n}`);
    await mergedIndex(path, base, tree, staged, merged, dir);
    prepared.push({ tree, index: temporary, merged, message: step.message });
    staged = (await git(path, ['write-tree'], { index: merged })).trim();
    base = tree;
  }
  return prepared;
}
/**
 * Commits one prepared step and records it in `result`, then refuses a commit whose parent or tree is not the
 * expected one (a concurrent reference change, or a hook that edited the selection). Returns its hash.
 */
async function commitStep(
  path: string,
  step: PreparedCommit,
  expectedHead: string | null,
  result: CommitResult,
): Promise<string> {
  await assertNoGitOperation(path);
  await git(path, ['commit', '--file=-'], { index: step.index, input: step.message });
  const oid = (await head(path))!;
  const actualTree = (await git(path, ['rev-parse', 'HEAD^{tree}'])).trim();
  const parents = (await git(path, ['rev-list', '--parents', '-n', '1', oid])).trim().split(' ').slice(1);
  if (parents.join(' ') !== (expectedHead ?? ''))
    throw new Error(
      `Parent inattendu pour ${oid} : modification concurrente des références, vérification manuelle requise.`,
    );
  result.commits.push({ hash: oid, title: (await git(path, ['log', '-1', '--format=%s'])).trim() });
  if (actualTree !== step.tree)
    throw new Error(
      `Le hook a modifié la sélection du commit ${oid} ; index préexistant conservé, vérification manuelle requise.`,
    );
  return oid;
}

export function selectionDiff(snapshot: GitSnapshot, selections: CommitSelection[]): string {
  const validated = parseCommitPlan({
    snapshotId: snapshot.id,
    commits: [{ message: 'review', selection: selections }],
    acknowledged: [],
    push: false,
  });
  return validated.commits[0].selection
    .map((selection) => {
      const file = snapshot.files.find((f) => f.path === selection.path);
      if (!file) throw new Error(`Fichier absent du contexte : ${selection.path}`);
      if (selection.all) return file.diff;
      if (selection.hunks!.some((id) => !file.hunks.some((h) => h.id === id)))
        throw new Error('Hunk absent du contexte.');
      return file.hunks
        .filter((h) => selection.hunks!.includes(h.id))
        .map((h) => h.patch)
        .join('');
    })
    .join('\n');
}

/** Prepared snapshots and commit locks of a server: a plan can only execute a snapshot this planner prepared. */
export class GitPlanner {
  private readonly snapshots = new Map<string, Saved>();
  private readonly locks = new Set<string>();
  private readonly gate: WorktreeGate;
  private readonly pushes: GitPushes;

  constructor(gate: WorktreeGate, pushes: GitPushes) {
    this.gate = gate;
    this.pushes = pushes;
  }

  /** `shared` describes the workspace whose dependency links (seen by Git as untracked files) stay out of the plan. */
  async prepareCommit(path: string, shared?: SharedDependencies | null): Promise<GitSnapshot> {
    path = await repositoryRoot(path);
    const links = await sharedDependencyLinks(shared, path);
    await git(path, ['mktree'], { input: '' });
    const before = {
      branch: await branch(path),
      head: await head(path),
      work: await workHash(path),
      index: await indexHash(path),
    };
    if ((await git(path, ['ls-files', '-u'])).trim()) throw new Error('Conflits Git non résolus.');
    const directory = await mkdtemp(join(tmpdir(), 'cerebro-collect-'));
    const temporaryIndex = join(directory, 'index');
    const originalIndex = await readFile(await indexPath(path)).catch((cause) => {
      if (cause.code === 'ENOENT') return null;
      throw cause;
    });
    if (originalIndex) await writeFile(temporaryIndex, originalIndex);
    else await git(path, ['read-tree', '--empty'], { index: temporaryIndex });
    // A freshly written copy otherwise makes racily-clean entries look older than
    // the index: Git can miss same-size changes with identical cached timestamps.
    // An old, nonzero timestamp (Git ignores zero) forces content checks without
    // touching the real index.
    await utimes(temporaryIndex, 1, 1);
    try {
      const untracked = new Set(splitZ(await git(path, ['ls-files', '--others', '--exclude-standard', '-z'])));
      const changed = splitZ(
        await git(path, ['diff', '--name-only', '--no-renames', '-z', before.head ?? EMPTY], { index: temporaryIndex }),
      );
      const paths = [...new Set([...changed, ...untracked])]
        .filter((file) => !links.some((link) => file === link || file.startsWith(`${link}/`)))
        .sort();
      if (paths.length > 500) throw new Error('Plus de 500 fichiers : réduisez le périmètre.');
      const files: GitCandidate[] = [];
      let bytes = 0;
      for (const file of paths) {
        // No git add: preparation must not even store secret blobs in Git's object database.
        const diff = untracked.has(file)
          ? await git(
              path,
              ['diff', '--no-index', '--binary', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file],
              { index: temporaryIndex },
            )
          : await git(
              path,
              ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', before.head ?? EMPTY, '--', file],
              { index: temporaryIndex },
            );
        bytes += Buffer.byteLength(diff);
        if (bytes > LIMIT) throw new Error('Plan trop volumineux (4 Mio).');
        files.push({ path: file, diff, hunks: hunks(diff), ...scan(file, diff) });
      }
      const after = {
        branch: await branch(path),
        head: await head(path),
        manifest: await workspaceManifest(path),
        index: await indexHash(path),
      };
      const work = manifestHash(after.manifest);
      if (
        before.branch !== after.branch ||
        before.head !== after.head ||
        before.work !== work ||
        before.index !== after.index
      )
        throw new Error('Le dépôt a changé pendant la préparation : relancez.');
      const snapshot: GitSnapshot = {
        root: path,
        id: randomUUID(),
        branch: before.branch,
        head: before.head,
        fingerprint: hash(JSON.stringify(before)),
        files,
        stagedDiff: await git(
          path,
          ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', before.head ?? EMPTY],
          { index: temporaryIndex },
        ),
        log: before.head ? await git(path, ['log', '-15', '--format=%h %s']) : '',
        createdAt: Date.now(),
      };
      // Bound retained state and expire unused plans after one hour.
      for (const [id, saved] of this.snapshots)
        if (saved.snapshot.createdAt < Date.now() - 3_600_000) this.snapshots.delete(id);
      if (this.snapshots.size >= 100) this.snapshots.delete(this.snapshots.keys().next().value!);
      this.snapshots.set(snapshot.id, {
        path,
        snapshot,
        work: before.work,
        manifest: after.manifest,
        index: before.index,
        branch: before.branch,
        used: false,
      });
      return snapshot;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async executeCommitPlan(path: string, raw: unknown): Promise<CommitResult> {
    const plan = parseCommitPlan(raw);
    const saved = this.snapshots.get(plan.snapshotId);
    const top = await repositoryRoot(path);
    if (!saved || saved.path !== top || saved.used)
      throw new Error('Plan absent, expiré ou déjà exécuté : préparez une nouvelle sélection.');
    path = top;
    this.gate.assertAvailable(path);
    const index = await indexPath(path);
    if (this.locks.has(index)) throw new Error('Un commit est déjà en cours dans ce dépôt.');
    this.locks.add(index);
    const lock: IndexLock = { index, handle: null };
    const dir = await mkdtemp(join(tmpdir(), 'cerebro-execute-'));
    const result: CommitResult = { commits: [], exclusions: [], error: null, pushId: null };
    try {
      lock.handle = await lockIndex(index);
      this.gate.assertAvailable(path);
      if (!(await matchesSnapshot(saved, path))) throw new Error('État Git obsolète : préparez un nouveau plan.');
      result.exclusions = exclusions(plan, saved.snapshot);
      const overridden = this.overridden(plan, saved);
      const prepared = await prepareCommits(path, plan, saved.snapshot, index, dir, overridden);
      const selected = new Set(plan.commits.flatMap((step) => step.selection.map((s) => s.path)));
      result.overridden = [...overridden].filter((file) => selected.has(file));
      // Everything, including index preservation, is checked before the first mutation.
      if (!(await matchesSnapshot(saved, path))) throw new Error('État Git obsolète avant exécution.');
      await assertNoGitOperation(path);
      saved.used = true;
      await this.commitPrepared(path, saved, prepared, lock, result);
    } catch (cause) {
      result.error = errorMessage(cause);
      // A refusal is only retryable while nothing was committed; afterwards the plan is half applied.
      result.blocked = cause instanceof GitOperationInProgress && !result.commits.length;
      if (cause instanceof GitOperationInProgress && result.commits.length)
        result.error = `Plan appliqué partiellement : ${result.commits.length} commit(s) sur ${plan.commits.length} créé(s), puis arrêt car une autre opération Git est en cours (${cause.operation ?? 'inconnue'}). Vérifiez l’état du dépôt avant de commiter la suite.`;
    } finally {
      if (lock.handle) {
        await lock.handle.close();
        await rm(`${index}.lock`, { force: true });
      }
      await rm(dir, { recursive: true, force: true });
      this.locks.delete(index);
    }
    if (!result.error && plan.push) result.pushId = (await this.pushes.start(path, { allowDirty: true })).id;
    return result;
  }

  /**
   * Commits the prepared steps one at a time while holding the real index lock. Before each commit, the branch,
   * HEAD and the index must be exactly as the previous step left them; the worktree is checked after each commit.
   */
  private async commitPrepared(
    path: string,
    saved: Saved,
    prepared: PreparedCommit[],
    lock: IndexLock,
    result: CommitResult,
  ): Promise<void> {
    let expectedHead = saved.snapshot.head;
    let expectedIndex = saved.index;
    for (const step of prepared) {
      this.gate.assertAvailable(path);
      // The worktree was hashed just before: by the final check of the plan, then after each commit below.
      if (
        saved.branch !== (await branch(path)) ||
        (await head(path)) !== expectedHead ||
        expectedIndex !== (await indexHash(path))
      )
        throw new Error('Modifications concurrentes : exécution interrompue.');
      const oid = await commitStep(path, step, expectedHead, result);
      // Atomic replacement under the real index lock, never a git add/reset on unrelated paths.
      const mergedBytes = await readFile(step.merged);
      expectedIndex = hash(mergedBytes);
      await writeFile(`${lock.index}.lock`, mergedBytes);
      await rename(`${lock.index}.lock`, lock.index);
      await lock.handle!.close();
      lock.handle = null;
      lock.handle = await lockIndex(lock.index);
      this.gate.assertAvailable(path);
      if (expectedIndex !== (await indexHash(path)))
        throw new Error('L’index a changé entre deux commits : exécution interrompue.');
      expectedHead = oid;
      if (saved.work !== (await workHash(path)))
        throw new Error('Le worktree a changé pendant le commit (hook ou édition externe) : vérification requise.');
    }
  }

  /** Blocked files of the plan's snapshot whose override names a retained snapshot that showed this exact diff. */
  private overridden(plan: CommitPlan, saved: Saved): Set<string> {
    const valid = new Set<string>();
    for (const override of plan.overrides ?? []) {
      const file = saved.snapshot.files.find((f) => f.path === override.path);
      if (file?.blocked && this.reviewedDiffs(override.snapshotId, saved.path)?.get(file.path) === file.diff)
        valid.add(file.path);
    }
    return valid;
  }

  /** Signatures of the files, read when the snapshot was taken (`workspaceManifest` format), while it is retained. */
  snapshotManifest(id: string): Record<string, string> | null {
    return this.snapshots.get(id)?.manifest ?? null;
  }
  async verifySnapshot(path: string, id: string): Promise<GitSnapshot> {
    const saved = this.snapshots.get(id);
    const top = await repositoryRoot(path);
    if (!saved || saved.path !== top) throw new Error('Sélection absente ou expirée.');
    if (!(await matchesSnapshot(saved, top))) throw new Error('Sélection obsolète : HEAD, index ou worktree a changé.');
    return saved.snapshot;
  }
  /** Diffs shown to the user by a still-retained snapshot of `root`, so a later plan can prove a file was reviewed as is. */
  reviewedDiffs(id: string, root: string): Map<string, string> | null {
    const saved = this.snapshots.get(id);
    if (!saved || canonicalWorktreePath(saved.path) !== canonicalWorktreePath(root)) return null;
    return new Map(saved.snapshot.files.map((file) => [file.path, file.diff]));
  }
}
