import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PREVIEW_LIMIT = 50;
// LC_ALL=C keeps git's error messages in English so `notRepository` can recognize them.
const git = async (path: string, args: string[]): Promise<string> =>
  (
    await exec('git', ['-C', path, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } })
  ).stdout.trimEnd();
const message = (error: unknown): string =>
  error instanceof Error ? ((error as { stderr?: unknown }).stderr || error.message).toString().trim() : String(error);
/** A missing folder or one outside any repository: the normal "not a repository" case, as opposed to a failure. */
const notRepository = (error: unknown): boolean =>
  /not a git repository|cannot change to .*No such file or directory/.test(message(error));

export interface GitSummary {
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
 * Resolves to an empty summary outside a repository; any other git failure rejects instead of passing for a clean tree.
 */
export async function gitSummary(path: string, includeCommits = false): Promise<GitSummary> {
  const empty: GitSummary = { branch: null, dirty: 0, ahead: 0, hasCommits: false, hasUpstream: false };
  try {
    if ((await git(path, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return empty;
    const [branch, status, head, upstream] = await Promise.all([
      git(path, ['branch', '--show-current']),
      git(path, ['status', '--porcelain']),
      git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => null),
      git(path, ['rev-parse', '--verify', '@{upstream}']).catch(() => null),
    ]);
    const result: GitSummary = {
      branch: branch || null,
      dirty: status === '' ? 0 : status.split(/\r?\n/).length,
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
  } catch (error) {
    if (notRepository(error)) return empty;
    throw new Error(`Lecture Git impossible pour ${path} : ${message(error)}`, { cause: error });
  }
}
