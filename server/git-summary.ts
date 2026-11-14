import { git as runGit, parseStatusZ } from './git.ts';

const PREVIEW_LIMIT = 50;
const DIRTY_FILES_LIMIT = 200;
// git.ts sets LC_ALL=C: Git's messages stay in English so that "not a git repository" can be recognized.
const git = async (path: string, args: string[]): Promise<string> => (await runGit(path, args)).trimEnd();
const message = (error: unknown): string =>
  error instanceof Error ? ((error as { stderr?: unknown }).stderr || error.message).toString().trim() : String(error);

/**
 * Only a missing folder or a path outside any work tree is "not a repository"; any other failure is a read error,
 * which must not pass for a clean tree.
 */
async function insideWorkTree(path: string): Promise<boolean> {
  try {
    return (await git(path, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch (cause) {
    if (/not a git repository|cannot change to .*No such file or directory/i.test(message(cause))) return false;
    throw cause;
  }
}

export interface GitSummary {
  /** False only when the path is outside any Git work tree. */
  repository: boolean;
  /** Set when the repository exists but its state could not be read: the other fields are then unknown. */
  error?: string;
  branch: string | null;
  dirty: number;
  /** Paths counted by `dirty`, the first DIRTY_FILES_LIMIT of them; an untracked folder is one `folder/` entry. */
  dirtyFiles: { paths: string[]; truncated: boolean };
  /** Files already in the index (`git diff --cached`): the automatic commit refuses to start over them. */
  staged: number;
  ahead: number | null;
  behind: number | null;
  hasCommits: boolean;
  hasUpstream: boolean;
  pendingCommits?: {
    upstream: string;
    commits: { hash: string; subject: string; author: string }[];
    truncated: boolean;
  };
  pendingCommitsError?: string;
  incomingCommits?: {
    upstream: string;
    commits: { hash: string; subject: string; author: string }[];
    truncated: boolean;
  };
  incomingCommitsError?: string;
}

async function readCommitPreview(
  path: string,
  range: string,
  count: number,
  upstreamName: string,
): Promise<NonNullable<GitSummary['pendingCommits']>> {
  const log = await git(path, [
    'log',
    '-z',
    `--max-count=${PREVIEW_LIMIT}`,
    '--format=%H%x00%s%x00%an',
    '--no-decorate',
    '--no-show-signature',
    range,
    '--',
  ]);
  const fields = log.split('\0');
  const commits = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    commits.push({ hash: fields[i], subject: fields[i + 1], author: fields[i + 2] });
  }
  return { upstream: upstreamName, commits, truncated: count > commits.length };
}

/**
 * Commits present on `@{upstream}` and absent from the checked-out branch (`HEAD..@{upstream}`).
 * Reads local refs only; resolves to 0 outside a repository, on a detached HEAD, without an upstream, or on error.
 */
export async function gitBehind(path: string): Promise<number> {
  try {
    const [branch, raw] = await Promise.all([
      git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      git(path, ['rev-list', '--count', 'HEAD..@{upstream}', '--']),
    ]);
    if (!branch) return 0;
    const count = Number(raw.trim());
    return Number.isSafeInteger(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

/**
 * Read local refs only. Count and preview use the same captured commit range.
 * Resolves to an empty summary outside a repository; any other git failure is reported in `error` instead of passing
 * for a clean tree.
 */
export async function gitSummary(path: string, includeCommits = false, includeIncoming = false): Promise<GitSummary> {
  const empty: GitSummary = {
    repository: false,
    branch: null,
    dirty: 0,
    dirtyFiles: { paths: [], truncated: false },
    staged: 0,
    ahead: 0,
    behind: 0,
    hasCommits: false,
    hasUpstream: false,
  };
  try {
    if (!(await insideWorkTree(path))) return empty;
    const [branch, status, staged, head, upstream] = await Promise.all([
      git(path, ['branch', '--show-current']),
      git(path, ['status', '--porcelain', '-z']),
      git(path, ['diff', '--cached', '--name-only', '-z']),
      git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => null),
      git(path, ['rev-parse', '--verify', '@{upstream}']).catch(() => null),
    ]);
    const paths = parseStatusZ(status);
    const result: GitSummary = {
      repository: true,
      branch: branch || null,
      dirty: paths.length,
      dirtyFiles: { paths: paths.slice(0, DIRTY_FILES_LIMIT), truncated: paths.length > DIRTY_FILES_LIMIT },
      staged: staged.split('\0').filter((name) => name !== '').length,
      ahead: head ? null : 0,
      behind: head ? null : 0,
      hasCommits: head !== null,
      hasUpstream: upstream !== null,
    };
    if (head && upstream) {
      let behindCount = 0;
      let aheadCount = 0;
      let countsReadable = false;
      try {
        const [behindRaw, aheadRaw] = (
          await git(path, ['rev-list', '--left-right', '--count', `${upstream}...${head}`, '--'])
        ).split(/\s+/);
        behindCount = Number(behindRaw);
        aheadCount = Number(aheadRaw);
        if (Number.isInteger(behindCount) && behindCount >= 0) result.behind = behindCount;
        if (Number.isInteger(aheadCount) && aheadCount >= 0) result.ahead = aheadCount;
        countsReadable = result.behind !== null && result.ahead !== null;
      } catch (error) {
        console.warn(`[git-summary] divergence Git illisible pour ${path} :`, message(error));
        if (includeCommits)
          result.pendingCommitsError = 'Impossible de lire les commits à pousser. Réessayez dans quelques instants.';
        if (includeIncoming)
          result.incomingCommitsError = 'Impossible de lire les commits à tirer. Réessayez dans quelques instants.';
      }
      if (countsReadable && (includeCommits || includeIncoming)) {
        const upstreamName = await git(path, [
          'rev-parse',
          '--abbrev-ref',
          '--symbolic-full-name',
          '@{upstream}',
        ]).catch(() => null);
        if (upstreamName === null) {
          if (includeCommits)
            result.pendingCommitsError = 'Impossible de lire les commits à pousser. Réessayez dans quelques instants.';
          if (includeIncoming)
            result.incomingCommitsError = 'Impossible de lire les commits à tirer. Réessayez dans quelques instants.';
        } else {
          if (includeCommits) {
            try {
              result.pendingCommits = await readCommitPreview(path, `${upstream}..${head}`, aheadCount, upstreamName);
            } catch (error) {
              console.warn(`[git-summary] commits à pousser illisibles pour ${path} :`, message(error));
              result.pendingCommitsError =
                'Impossible de lire les commits à pousser. Réessayez dans quelques instants.';
            }
          }
          if (includeIncoming) {
            try {
              result.incomingCommits = await readCommitPreview(path, `${head}..${upstream}`, behindCount, upstreamName);
            } catch (error) {
              console.warn(`[git-summary] commits à tirer illisibles pour ${path} :`, message(error));
              result.incomingCommitsError = 'Impossible de lire les commits à tirer. Réessayez dans quelques instants.';
            }
          }
        }
      }
    }
    return result;
  } catch (cause) {
    const detail =
      cause instanceof Error
        ? cause.message.split('\n').find((line) => line.trim() && !line.startsWith('Command failed'))
        : undefined;
    return {
      ...empty,
      repository: true,
      error: `Impossible de lire l’état Git${detail ? ` : ${detail.trim()}` : '.'}`,
    };
  }
}
