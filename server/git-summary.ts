import { execGit } from './git-process.ts';

const PREVIEW_LIMIT = 50;
// LC_ALL=C keeps Git's messages in English so that "not a git repository" can be recognized.
const git = async (path: string, args: string[]): Promise<string> =>
  (await execGit(['-C', path, ...args], { env: { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } })).toString('utf8').trimEnd();

/** Only a path outside any work tree is "not a repository"; any other failure is a read error. */
async function insideWorkTree(path: string): Promise<boolean> {
  try { return await git(path, ['rev-parse', '--is-inside-work-tree']) === 'true'; }
  catch (cause) {
    if (/not a git repository/i.test(String((cause as { stderr?: unknown }).stderr ?? ''))) return false;
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

/** Read local refs only. Count and preview use the same captured commit range. */
export async function gitSummary(path: string, includeCommits = false): Promise<GitSummary> {
  const empty: GitSummary = { repository: false, branch: null, dirty: 0, ahead: 0, hasCommits: false, hasUpstream: false };
  try {
    if (!await insideWorkTree(path)) return empty;
    const [branch, status, head, upstream] = await Promise.all([
      git(path, ['branch', '--show-current']),
      git(path, ['status', '--porcelain']),
      git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => null),
      git(path, ['rev-parse', '--verify', '@{upstream}']).catch(() => null),
    ]);
    const result: GitSummary = {
      repository: true, branch: branch || null, dirty: status === '' ? 0 : status.split(/\r?\n/).length,
      ahead: head ? null : 0, hasCommits: head !== null, hasUpstream: upstream !== null,
    };
    if (head && upstream) {
      try {
        const range = `${upstream}..${head}`;
        const count = Number(await git(path, ['rev-list', '--count', range, '--']));
        if (Number.isInteger(count) && count >= 0) result.ahead = count;
        if (includeCommits) {
          const [name, log] = await Promise.all([
            git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
            git(path, ['log', '-z', `--max-count=${PREVIEW_LIMIT}`, '--format=%H%x00%s%x00%an', '--no-decorate', '--no-show-signature', range, '--']),
          ]);
          const fields = log.split('\0');
          const commits = [];
          for (let i = 0; i + 2 < fields.length; i += 3) {
            commits.push({ hash: fields[i], subject: fields[i + 1], author: fields[i + 2] });
          }
          result.pendingCommits = { upstream: name, commits, truncated: count > commits.length };
        }
      } catch {
        if (includeCommits) result.pendingCommitsError = 'Impossible de lire les commits à pousser. Réessayez dans quelques instants.';
      }
    }
    return result;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split('\n').find(line => line.trim() && !line.startsWith('Command failed')) : undefined;
    return { ...empty, repository: true, error: `Impossible de lire l’état Git${detail ? ` : ${detail.trim()}` : '.'}` };
  }
}
