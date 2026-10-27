import { execFileSync } from 'node:child_process';
import { GIT_TIMEOUTS_MS } from './config.ts';
import { GitCommandError, runGit, type GitOptions as ProcessOptions } from './git-process.ts';

export interface GitOptions extends Omit<ProcessOptions, 'env'> {
  /** Extra variables, applied over the standard environment. */
  env?: Record<string, string>;
  /** Alternate index file (GIT_INDEX_FILE). */
  index?: string;
}
/** Non-zero exit, timeout or overflow. stdout/stderr are kept so callers can inspect partial output. */
export { GitCommandError as GitError };

/** Same environment for every git call: no prompt, no editor, no optional lock, stable messages. */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no', LC_ALL: 'C', ...extra };
}
const subcommand = (args: string[]): string => args.find((arg, i) => !arg.startsWith('-') && args[i - 1] !== '-c') ?? 'git';

/** Runs git in `path` through the bounded runner of git-process.ts (timeout by kind, process group killed). */
export function git(path: string, args: string[], options: GitOptions & { encoding: 'buffer' }): Promise<Buffer>;
export function git(path: string, args: string[], options?: GitOptions & { encoding?: 'utf8' }): Promise<string>;
export async function git(path: string, args: string[], options: GitOptions & { encoding?: 'utf8' | 'buffer' } = {}): Promise<string | Buffer> {
  const { index, env, encoding, ...rest } = options;
  const result = await runGit(['-C', path, ...args], { ...rest, env: gitEnv({ ...env, ...(index ? { GIT_INDEX_FILE: index } : {}) }) });
  if (result.code !== 0) throw new GitCommandError(result.stderr.toString('utf8').trim() || `git ${subcommand(args)} : code ${result.code}`, result);
  // Decoded once the output is complete: a multi-byte character may span two chunks.
  return encoding === 'buffer' ? result.stdout : result.stdout.toString('utf8');
}

/** Blocking variant for startup and synchronous paths; keep it to quick plumbing commands. */
export function gitSync(path: string, args: string[], options: { timeout?: number } = {}): string {
  return execFileSync('git', ['-C', path, ...args], {
    env: { ...process.env, ...gitEnv() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: options.timeout ?? GIT_TIMEOUTS_MS.read, killSignal: 'SIGKILL',
  });
}

/** Top-level folder of the working tree containing `path`. */
export async function repositoryRoot(path: string): Promise<string> {
  return (await git(path, ['rev-parse', '--show-toplevel'])).trim();
}
/** Entries of a NUL-terminated listing (`-z`). */
export const splitZ = (output: string): string[] => output.split('\0').filter(Boolean);
/** Paths of `git status --porcelain=v1 -z`: a rename or a copy counts once, by its new path. */
export function parseStatusZ(status: string): string[] {
  const entries = status.split('\0'); const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]; if (!entry) continue;
    files.push(entry.slice(3)); if (/[RC]/.test(entry.slice(0, 2))) i++;
  }
  return files;
}
/** Short name of a branch reference, or `fallback` when there is none. */
export const branchLabel = (branch: string | null, fallback: string): string => branch?.replace(/^refs\/heads\//, '') ?? fallback;
