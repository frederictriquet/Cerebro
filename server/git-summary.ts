import { git as runGit, parseStatusZ } from './git.ts';

const PREVIEW_LIMIT = 50;
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
  ahead: number | null;
  hasCommits: boolean;
  hasUpstream: boolean;
  pendingCommits?: {
    upstream: string;
    commits: { hash: string; subject: string; author: string }[];
    truncated: boolean;
  };
  pendingCommitsError?: string;
}

/**
 * Read local refs only. Count and preview use the same captured commit range.
 * Resolves to an empty summary outside a repository; any other git failure is reported in `error` instead of passing
 * for a clean tree.
 */
export async function gitSummary(path: string, includeCommits = false): Promise<GitSummary> {
  const empty: GitSummary = {
    repository: false,
    branch: null,
    dirty: 0,
    ahead: 0,
    hasCommits: false,
    hasUpstream: false,
  };
  try {
    if (!(await insideWorkTree(path))) return empty;
    const [branch, status, head, upstream] = await Promise.all([
      git(path, ['branch', '--show-current']),
      git(path, ['status', '--porcelain', '-z']),
      git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => null),
      git(path, ['rev-parse', '--verify', '@{upstream}']).catch(() => null),
    ]);
    const result: GitSummary = {
      repository: true,
      branch: branch || null,
      dirty: parseStatusZ(status).length,
      ahead: head ? null : 0,
      hasCommits: head !== null,
      hasUpstream: upstream !== null,
    };
    if (head && upstream) {
      try {
        const range = `${upstream}..${head}`;
        const count = Number(await git(path, ['rev-list', '--count', range, '--']));
        if (Number.isInteger(count) && count >= 0) result.ahead = count;
        if (includeCommits) {
          const [name, log] = await Promise.all([
            git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
            git(path, [
              'log',
              '-z',
              `--max-count=${PREVIEW_LIMIT}`,
              '--format=%H%x00%s%x00%an',
              '--no-decorate',
              '--no-show-signature',
              range,
              '--',
            ]),
          ]);
          const fields = log.split('\0');
          const commits = [];
          for (let i = 0; i + 2 < fields.length; i += 3) {
            commits.push({ hash: fields[i], subject: fields[i + 1], author: fields[i + 2] });
          }
          result.pendingCommits = { upstream: name, commits, truncated: count > commits.length };
        }
      } catch (error) {
        console.warn(`[git-summary] commits à pousser illisibles pour ${path} :`, message(error));
        if (includeCommits)
          result.pendingCommitsError = 'Impossible de lire les commits à pousser. Réessayez dans quelques instants.';
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
