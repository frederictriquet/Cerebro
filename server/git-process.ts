import { spawn } from 'node:child_process';
import { GIT_TIMEOUTS_MS } from './config.ts';

/** Bounds each Git run: hooks, merges and remote accesses get more time than plain reads. */
export type GitKind = 'read' | 'write' | 'network';
export interface GitOptions {
  /** Added to the server environment. */
  env?: Record<string, string>;
  input?: string | Buffer;
  /** Captured stdout limit; stderr keeps its last bytes within the same limit. */
  maxBuffer?: number;
  /** Deduced from the subcommand when omitted. */
  kind?: GitKind;
  /** Milliseconds; overrides the delay of the kind for a caller that needs a quick answer. */
  timeout?: number;
  /** Streams stdout and stderr as they arrive (push progress). */
  onOutput?: (data: Buffer) => void;
}
export interface GitResult { code: number | null; stdout: Buffer; stderr: Buffer }
/** Same shape as an execFile failure: callers read `code`, `stdout` and `stderr`. */
export class GitCommandError extends Error {
  code: number | null; stdout: string; stderr: string;
  constructor(message: string, result: GitResult) {
    super(message); this.code = result.code; this.stdout = result.stdout.toString('utf8'); this.stderr = result.stderr.toString('utf8');
  }
}
export class GitTimeoutError extends GitCommandError {}
export class GitOutputLimitError extends GitCommandError {}
/** Default stdout limit, shared by every caller: a status listing many untracked files must still fit. */
export const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;

const NETWORK = new Set(['push', 'fetch', 'pull', 'clone', 'ls-remote']);
const WRITE = new Set(['commit', 'merge', 'checkout', 'checkout-index', 'reset', 'read-tree', 'update-ref', 'update-index', 'write-tree', 'commit-tree', 'mktree', 'worktree', 'add', 'rm', 'stash', 'rebase', 'cherry-pick', 'revert', 'am', 'apply', 'gc', 'prune']);
/** Global options that take their value as the next argument. */
const VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
export function gitKind(args: string[]): GitKind {
  for (let i = 0; i < args.length; i++) {
    if (VALUED.has(args[i])) { i++; continue; }
    if (args[i].startsWith('-')) continue;
    return NETWORK.has(args[i]) ? 'network' : WRITE.has(args[i]) ? 'write' : 'read';
  }
  return 'read';
}
const subcommand = (args: string[]): string => args.find((arg, i) => !arg.startsWith('-') && !VALUED.has(args[i - 1] ?? '')) ?? 'git';

/**
 * Runs git in its own process group: at expiry the whole group (hooks, credential helpers, ssh)
 * receives SIGTERM, then SIGKILL, so a hung hook can neither hold a worktree lease nor block shutdown.
 * Resolves with the exit code; rejects only on timeout, output overflow or spawn failure.
 */
export function runGit(args: string[], options: GitOptions = {}): Promise<GitResult> {
  const timeoutMs = options.timeout ?? GIT_TIMEOUTS_MS[options.kind ?? gitKind(args)];
  const limit = options.maxBuffer ?? GIT_OUTPUT_LIMIT;
  return new Promise((accept, reject) => {
    const group = process.platform !== 'win32';
    const child = spawn('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env }, detached: group, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Buffers decoded once by the caller: decoding each chunk would split multi-byte UTF-8 characters at chunk boundaries.
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let stdoutBytes = 0; let stderrBytes = 0;
    let failure: 'timeout' | 'overflow' | null = null; let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals): void => { try { if (group && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
    const stop = (reason: 'timeout' | 'overflow'): void => {
      if (failure) return;
      failure = reason; kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2000); killTimer.unref();
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs); timer.unref();
    child.stdout.on('data', (data: Buffer) => { options.onOutput?.(data); stdout.push(data); stdoutBytes += data.length; if (stdoutBytes > limit) stop('overflow'); });
    child.stderr.on('data', (data: Buffer) => { options.onOutput?.(data); stderr.push(data); stderrBytes += data.length; while (stderrBytes - stderr[0].length >= limit) stderrBytes -= stderr.shift()!.length; });
    let settled = false;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (failure === 'timeout') reject(new GitTimeoutError(`Opération Git interrompue après ${timeoutMs / 1000} s (git ${subcommand(args)}) : un hook, un accès distant ou un verrou ne répond pas.`, result));
      else if (failure === 'overflow') reject(new GitOutputLimitError(`Sortie Git trop volumineuse (git ${subcommand(args)}).`, result));
      else accept(result);
    };
    child.on('error', cause => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); reject(cause); });
    child.on('close', settle);
    // A descendant that left the group may keep the pipes open: once killed, git's own exit is enough.
    child.on('exit', code => { if (failure) { child.stdout.destroy(); child.stderr.destroy(); settle(code); } });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}

/** execFile-like: resolves with stdout, rejects with a GitCommandError on a non-zero exit. */
export async function execGit(args: string[], options: GitOptions = {}): Promise<Buffer> {
  const result = await runGit(args, options);
  if (result.code !== 0) throw new GitCommandError(`Command failed: git ${args.join(' ')}\n${result.stderr.toString('utf8')}`, result);
  return result.stdout;
}
