import { canonicalWorktreePath, type WorktreeGate } from './worktree-gate.ts';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, readlink, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { GitPushes } from './git-push.ts';

const LIMIT = 4 * 1024 * 1024;
const EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export interface GitHunk {
  id: string;
  patch: string;
}
export interface GitCandidate {
  path: string;
  diff: string;
  hunks: GitHunk[];
  warnings: string[];
  blocked: boolean;
}
export interface GitSnapshot {
  root: string;
  id: string;
  head: string | null;
  branch: string | null;
  fingerprint: string;
  files: GitCandidate[];
  stagedDiff: string;
  log: string;
  createdAt: number;
}
export interface CommitSelection {
  path: string;
  all?: boolean;
  hunks?: string[];
}
export interface CommitStep {
  message: string;
  selection: CommitSelection[];
}
export interface CommitPlan {
  snapshotId: string;
  commits: CommitStep[];
  acknowledged: string[];
  push: boolean;
}
export interface CommitResult {
  commits: { hash: string; title: string }[];
  exclusions: string[];
  error: string | null;
  pushId: string | null;
  operationId?: string;
}
interface Saved {
  path: string;
  snapshot: GitSnapshot;
  work: string;
  index: string;
  branch: string | null;
  used: boolean;
}

async function git(path: string, args: string[], index?: string, input?: string | Buffer): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn('git', ['-C', path, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(index ? { GIT_INDEX_FILE: index } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let exceeded = false;
    child.stdout.on('data', (data: Buffer) => {
      stdout += data;
      if (Buffer.byteLength(stdout) > LIMIT) {
        exceeded = true;
        child.kill();
      }
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data).slice(-LIMIT);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      (code === 0 || (code === 1 && args.includes('--no-index'))) && !exceeded
        ? accept(stdout)
        : reject(
            new Error(exceeded ? 'Contexte Git trop volumineux (4 Mio).' : stderr || `git ${args[0]} : code ${code}`),
          ),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function branch(path: string): Promise<string | null> {
  return (await git(path, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim() || null;
}
async function head(path: string): Promise<string | null> {
  return (await git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim() || null;
}
async function indexPath(path: string): Promise<string> {
  return resolve(path, (await git(path, ['rev-parse', '--git-path', 'index'])).trim());
}
async function indexHash(path: string): Promise<string> {
  return hash(
    await readFile(await indexPath(path)).catch((cause) => {
      if (cause.code === 'ENOENT') return Buffer.alloc(0);
      throw cause;
    }),
  );
}
async function workHash(path: string): Promise<string> {
  const files = [
    ...new Set(
      (await git(path, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean),
    ),
  ].sort();
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file + '\0');
    const full = join(path, file);
    try {
      const stat = await lstat(full);
      digest.update(String(stat.mode));
      if (stat.isSymbolicLink()) digest.update(await readlink(full));
      else if (stat.isFile()) digest.update(await readFile(full));
      else throw new Error(`Type de fichier non pris en charge : ${file}`);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      digest.update('deleted');
    }
  }
  return digest.digest('hex');
}
function hunks(diff: string): GitHunk[] {
  const start = diff.indexOf('\n@@ ');
  if (start < 0 || /^(new file mode|deleted file mode|old mode|new mode|GIT binary patch)/m.test(diff)) return [];
  const prefix = diff.slice(0, start + 1);
  return diff
    .slice(start + 1)
    .split(/(?=^@@ )/m)
    .filter(Boolean)
    .map((hunk) => ({ id: hash(prefix + hunk), patch: prefix + hunk }));
}
function scan(file: string, diff: string): { warnings: string[]; blocked: boolean } {
  const warnings: string[] = [];
  const added = diff
    .split('\n')
    .filter((line) => line.startsWith('+'))
    .join('\n');
  const blocked =
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})/.test(
      added,
    );
  if (blocked) warnings.push('Secret détecté : exclu.');
  if (/(^|\/)(\.env(?:\.|$)|id_rsa|credentials|secrets?\b)/i.test(file))
    warnings.push('Fichier pouvant contenir des secrets : vérification explicite requise.');
  if (/(^|\/)(node_modules|dist|build|coverage|\.cache|tmp)(\/|$)|\.(log|tmp|bak|min\.js|map)$/.test(file))
    warnings.push('Fichier généré ou temporaire présumé : vérification explicite requise.');
  if (/GIT binary patch/.test(diff)) warnings.push('Fichier binaire : contenu non inspecté par le scanner.');
  return { warnings, blocked };
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
  await git(path, ['read-tree', '-m', base, selected, staged], index);
  const unmerged = (await git(path, ['ls-files', '-u', '-z'], index)).split('\0').filter(Boolean);
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
    const oid = (await git(path, ['hash-object', '-w', '--stdin'], undefined, merged)).trim();
    await git(path, ['update-index', '--add', '--cacheinfo', entries[0].mode, oid, file], index);
  }
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
    path = (await git(path, ['rev-parse', '--show-toplevel'])).trim();
    const links = await sharedDependencyLinks(shared, path);
    await git(path, ['mktree'], undefined, '');
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
    else await git(path, ['read-tree', '--empty'], temporaryIndex);
    // A freshly written copy otherwise makes racily-clean entries look older than
    // the index: Git can miss same-size changes with identical cached timestamps.
    // An old, nonzero timestamp (Git ignores zero) forces content checks without
    // touching the real index.
    await utimes(temporaryIndex, 1, 1);
    try {
      const untracked = new Set(
        (await git(path, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean),
      );
      const changed = (
        await git(path, ['diff', '--name-only', '--no-renames', '-z', before.head ?? EMPTY], temporaryIndex)
      )
        .split('\0')
        .filter(Boolean);
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
              temporaryIndex,
            )
          : await git(
              path,
              ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', before.head ?? EMPTY, '--', file],
              temporaryIndex,
            );
        bytes += Buffer.byteLength(diff);
        if (bytes > LIMIT) throw new Error('Plan trop volumineux (4 Mio).');
        files.push({ path: file, diff, hunks: hunks(diff), ...scan(file, diff) });
      }
      if (
        before.branch !== (await branch(path)) ||
        before.head !== (await head(path)) ||
        before.work !== (await workHash(path)) ||
        before.index !== (await indexHash(path))
      )
        throw new Error(
          `État Git modifié pendant la collecte : recommencez. HEAD=${before.head !== (await head(path))} work=${before.work !== (await workHash(path))} index=${before.index !== (await indexHash(path))}`,
        );
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
          temporaryIndex,
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
    const top = (await git(path, ['rev-parse', '--show-toplevel'])).trim();
    if (!saved || saved.path !== top || saved.used)
      throw new Error('Plan absent, expiré ou déjà exécuté : préparez une nouvelle sélection.');
    path = top;
    this.gate.assertAvailable(path);
    const index = await indexPath(path);
    if (this.locks.has(index)) throw new Error('Un commit est déjà en cours dans ce dépôt.');
    this.locks.add(index);
    let lock: Awaited<ReturnType<typeof open>> | null = null;
    const dir = await mkdtemp(join(tmpdir(), 'cerebro-execute-'));
    const result: CommitResult = { commits: [], exclusions: [], error: null, pushId: null };
    try {
      lock = await open(`${index}.lock`, 'wx');
      this.gate.assertAvailable(path);
      if (
        saved.branch !== (await branch(path)) ||
        saved.snapshot.head !== (await head(path)) ||
        saved.work !== (await workHash(path)) ||
        saved.index !== (await indexHash(path))
      )
        throw new Error('État Git obsolète : préparez un nouveau plan.');
      const selectedPaths = new Set(plan.commits.flatMap((step) => step.selection.map((s) => s.path)));
      result.exclusions = saved.snapshot.files.flatMap((f) => {
        if (!selectedPaths.has(f.path)) return [f.path];
        const selections = plan.commits.flatMap((c) => c.selection).filter((s) => s.path === f.path);
        if (selections.some((s) => s.all)) return [];
        const selectedHunks = new Set(selections.flatMap((s) => s.hunks ?? []));
        return f.hunks.filter((h) => !selectedHunks.has(h.id)).map((h) => `${f.path} (hunk ${h.id})`);
      });
      let base = saved.snapshot.head ?? EMPTY;
      const original = join(dir, 'original');
      const bytes = await readFile(index).catch((cause) => {
        if (cause.code === 'ENOENT') return null;
        throw cause;
      });
      if (bytes) await writeFile(original, bytes);
      else await git(path, ['read-tree', '--empty'], original);
      let staged = (await git(path, ['write-tree'], original)).trim();
      const prepared: { tree: string; index: string; merged: string; message: string }[] = [];
      for (const [n, step] of plan.commits.entries()) {
        const temporary = join(dir, `commit-${n}`);
        await git(path, ['read-tree', base], temporary);
        for (const selection of step.selection) {
          const file = saved.snapshot.files.find((f) => f.path === selection.path);
          if (!file) throw new Error(`Fichier absent de la sélection collectée : ${selection.path}`);
          if (file.blocked) throw new Error(`Secret détecté, fichier exclu : ${file.path}`);
          if (file.warnings.length && !plan.acknowledged.includes(file.path))
            throw new Error(`Vérification explicite requise : ${file.path}`);
          let patch = file.diff;
          if (!selection.all) {
            const hunks = selection.hunks!.map((id) => file.hunks.find((h) => h.id === id));
            if (hunks.some((h) => !h)) throw new Error(`Hunk inconnu : ${file.path}`);
            // Reuse one header and keep the original hunk order.
            const wanted = new Set(selection.hunks);
            patch = file.hunks
              .filter((h) => wanted.has(h.id))
              .map((h) => h.patch)
              .join('');
          }
          // --3way rebases later hunks on the commits already prepared from this snapshot.
          await git(path, ['apply', '--cached', '--3way', '--whitespace=nowarn'], temporary, patch);
        }
        const tree = (await git(path, ['write-tree'], temporary)).trim();
        const baseTree = (await git(path, ['rev-parse', `${base}^{tree}`])).trim();
        if (tree === baseTree) throw new Error('Commit vide dans le plan.');
        const merged = join(dir, `merged-${n}`);
        await mergedIndex(path, base, tree, staged, merged, dir);
        prepared.push({ tree, index: temporary, merged, message: step.message });
        staged = (await git(path, ['write-tree'], merged)).trim();
        base = tree;
      }
      // Everything, including index preservation, is checked before the first mutation.
      if (
        saved.branch !== (await branch(path)) ||
        saved.snapshot.head !== (await head(path)) ||
        saved.work !== (await workHash(path)) ||
        saved.index !== (await indexHash(path))
      )
        throw new Error('État Git obsolète avant exécution.');
      saved.used = true;
      let expectedHead = saved.snapshot.head;
      let expectedIndex = saved.index;
      for (const step of prepared) {
        this.gate.assertAvailable(path);
        if (
          saved.branch !== (await branch(path)) ||
          (await head(path)) !== expectedHead ||
          saved.work !== (await workHash(path)) ||
          expectedIndex !== (await indexHash(path))
        )
          throw new Error('Modifications concurrentes : exécution interrompue.');
        await git(path, ['commit', '--file=-'], step.index, step.message);
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
        // Atomic replacement under the real index lock, never a git add/reset on unrelated paths.
        const mergedBytes = await readFile(step.merged);
        expectedIndex = hash(mergedBytes);
        await writeFile(`${index}.lock`, mergedBytes);
        await rename(`${index}.lock`, index);
        await lock.close();
        lock = null;
        lock = await open(`${index}.lock`, 'wx');
        this.gate.assertAvailable(path);
        if (expectedIndex !== (await indexHash(path)))
          throw new Error('L’index a changé entre deux commits : exécution interrompue.');
        expectedHead = oid;
        if (saved.work !== (await workHash(path)))
          throw new Error('Le worktree a changé pendant le commit (hook ou édition externe) : vérification requise.');
      }
    } catch (cause) {
      result.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (lock) {
        await lock.close();
        await rm(`${index}.lock`, { force: true });
      }
      await rm(dir, { recursive: true, force: true });
      this.locks.delete(index);
    }
    if (!result.error && plan.push) result.pushId = (await this.pushes.start(path, { allowDirty: true })).id;
    return result;
  }

  async verifySnapshot(path: string, id: string): Promise<GitSnapshot> {
    const saved = this.snapshots.get(id);
    const top = (await git(path, ['rev-parse', '--show-toplevel'])).trim();
    if (!saved || saved.path !== top) throw new Error('Sélection absente ou expirée.');
    if (
      saved.branch !== (await branch(top)) ||
      saved.snapshot.head !== (await head(top)) ||
      saved.work !== (await workHash(top)) ||
      saved.index !== (await indexHash(top))
    )
      throw new Error('Sélection obsolète : HEAD, index ou worktree a changé.');
    return saved.snapshot;
  }
  /** Diffs shown to the user by a still-retained snapshot of `root`, so a later plan can prove a file was reviewed as is. */
  reviewedDiffs(id: string, root: string): Map<string, string> | null {
    const saved = this.snapshots.get(id);
    if (!saved || canonicalWorktreePath(saved.path) !== canonicalWorktreePath(root)) return null;
    return new Map(saved.snapshot.files.map((file) => [file.path, file.diff]));
  }
}
