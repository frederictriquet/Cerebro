import { execFileSync, spawn } from 'node:child_process';

const MIB = 1024 * 1024;
/** Read-only and plumbing commands; anything slower is stuck. */
export const DEFAULT_TIMEOUT = 2 * 60_000;
/** Commands that run user hooks (commit, merge) may legitimately take longer. */
export const HOOK_TIMEOUT = 10 * 60_000;
export interface GitOptions {
  /** Extra variables, applied over the standard environment. */
  env?: Record<string, string>;
  /** Alternate index file (GIT_INDEX_FILE). */
  index?: string;
  /** Written to stdin; stdin is closed empty otherwise. */
  input?: string | Buffer;
  /** Bytes of stdout beyond which the command is killed. 8 Mio by default. */
  maxBuffer?: number;
  /** Milliseconds before the process group is killed; 0 disables it. */
  timeout?: number;
  /** Receives stdout and stderr as they arrive, for progress display. */
  onOutput?: (chunk: Buffer) => void;
}
/** Non-zero exit, signal, timeout or overflow. stdout/stderr are kept so callers can inspect partial output. */
export class GitError extends Error {
  /** Exit code, or null when the process was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  constructor(message: string, code: number | null, stdout: string, stderr: string) {
    super(message);
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Same environment for every git call: no prompt, no editor, no optional lock, stable messages. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no', LC_ALL: 'C', ...extra };
}
const subcommand = (args: string[]): string => args.find((arg, i) => !arg.startsWith('-') && args[i - 1] !== '-c') ?? 'git';
const environment = (options: GitOptions): NodeJS.ProcessEnv => gitEnv({ ...options.env, ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) });

export function git(path: string, args: string[], options: GitOptions & { encoding: 'buffer' }): Promise<Buffer>;
export function git(path: string, args: string[], options?: GitOptions & { encoding?: 'utf8' }): Promise<string>;
export function git(path: string, args: string[], options: GitOptions & { encoding?: 'utf8' | 'buffer' } = {}): Promise<string | Buffer> {
  const limit = options.maxBuffer ?? 8 * MIB;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  return new Promise((accept, reject) => {
    // Own process group, so hooks and aliases started by git die with it.
    const group = process.platform !== 'win32';
    const child = spawn('git', ['-C', path, ...args], { env: environment(options), detached: group, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = []; let size = 0;
    let stderr = Buffer.alloc(0);
    let failure: string | null = null;
    const kill = (reason: string): void => {
      if (failure !== null) return;
      failure = reason;
      try { if (group && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    };
    const timer = timeout > 0 ? setTimeout(() => kill(`git ${subcommand(args)} : délai de ${Math.round(timeout / 1000)} s dépassé.`), timeout) : null;
    child.stdout.on('data', (data: Buffer) => {
      options.onOutput?.(data);
      size += data.length;
      if (size > limit) kill(`Contexte Git trop volumineux (${Math.round(limit / MIB * 10) / 10} Mio).`);
      else stdout.push(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      options.onOutput?.(data);
      stderr = Buffer.concat([stderr, data]);
      if (stderr.length > limit) stderr = stderr.subarray(stderr.length - limit);
    });
    child.once('error', cause => { if (timer) clearTimeout(timer); reject(cause); });
    child.once('close', code => {
      if (timer) clearTimeout(timer);
      // Decode once the output is complete: a multi-byte character may span two chunks.
      const output = Buffer.concat(stdout);
      if (code === 0 && failure === null) return accept(options.encoding === 'buffer' ? output : output.toString('utf8'));
      const errors = stderr.toString('utf8');
      reject(new GitError(failure ?? (errors.trim() || `git ${subcommand(args)} : code ${code}`), failure === null ? code : null, output.toString('utf8'), errors));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}

/** Blocking variant for startup and synchronous paths; keep it to quick plumbing commands. */
export function gitSync(path: string, args: string[], options: Pick<GitOptions, 'timeout'> = {}): string {
  return execFileSync('git', ['-C', path, ...args], {
    env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: options.timeout ?? DEFAULT_TIMEOUT, killSignal: 'SIGKILL',
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
