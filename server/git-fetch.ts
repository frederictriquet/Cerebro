import { resolve } from 'node:path';
import type { CerebroDatabase } from './db.ts';
import { git as runGit } from './git.ts';
import type { GitPulls } from './git-pull.ts';
import type { GitPushes } from './git-push.ts';

const INTERVAL_MS = 2 * 60_000;
const INITIAL_DELAY_MS = 1_500;
const POKE_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 30_000;

const git = async (path: string, args: string[]): Promise<string> => (await runGit(path, args)).trim();

function fetchEnv(): Record<string, string> {
  return {
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' }),
  };
}

interface TrackedProject {
  path: string;
  commonDir: string;
  remote: string;
  upstream: string;
}

async function inspectTracked(path: string): Promise<TrackedProject | null> {
  try {
    const [branch, upstream, rawCommonDir] = await Promise.all([
      git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      git(path, ['rev-parse', '--verify', '@{upstream}']),
      git(path, ['rev-parse', '--git-common-dir']),
    ]);
    if (!branch || !upstream || !rawCommonDir) return null;
    const remote = await git(path, ['config', '--get', `branch.${branch}.remote`]);
    if (!remote || remote === '.') return null;
    return { path, commonDir: resolve(path, rawCommonDir), remote, upstream };
  } catch {
    return null;
  }
}

/**
 * Periodically refreshes remote-tracking refs (`git fetch`) for every project on a branch with a network upstream,
 * without touching the worktree, index, `FETCH_HEAD` or auto-maintenance. Emits `onChange` only when an upstream ref
 * actually moves.
 */
export class AutoFetch {
  private readonly db: CerebroDatabase;
  private readonly pulls: GitPulls;
  private readonly pushes: GitPushes;
  private readonly onChange: () => void;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private pokeTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private autoImmediate = false;
  private stopped = false;

  constructor(db: CerebroDatabase, pulls: GitPulls, pushes: GitPushes, onChange: () => void, intervalMs = INTERVAL_MS) {
    this.db = db;
    this.pulls = pulls;
    this.pushes = pushes;
    this.onChange = onChange;
    this.intervalMs = intervalMs;
  }

  start({ immediate = false }: { immediate?: boolean } = {}): void {
    this.stopped = false;
    this.autoImmediate = immediate;
    this.timer ??= setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    if (immediate) this.schedulePoke(INITIAL_DELAY_MS);
  }

  /** Schedules a near-term fetch when automatic startup fetching is enabled (e.g. after adding a project). */
  poke(): void {
    if (!this.autoImmediate || this.stopped) return;
    this.schedulePoke(POKE_DELAY_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.pokeTimer) clearTimeout(this.pokeTimer);
    this.pokeTimer = null;
    await this.inFlight;
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.inFlight ??= this.runTick().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private schedulePoke(delayMs: number): void {
    if (this.pokeTimer) clearTimeout(this.pokeTimer);
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      void this.tick();
    }, delayMs);
    this.pokeTimer.unref();
  }

  private async runTick(): Promise<void> {
    const projects = this.db.listProjects();
    const tracked: TrackedProject[] = [];
    const targets = new Map<string, TrackedProject>();

    for (const project of projects) {
      if (this.stopped) return;
      const info = await inspectTracked(project.path);
      if (!info) continue;
      const [pulling, pushing] = await Promise.all([
        this.pulls.current(info.path).catch(() => null),
        this.pushes.current(info.path).catch(() => null),
      ]);
      if (pulling?.status === 'running' || pushing?.status === 'running') continue;
      tracked.push(info);
      const key = `${info.commonDir}\0${info.remote}`;
      if (!targets.has(key)) targets.set(key, info);
    }

    for (const target of targets.values()) {
      if (this.stopped) return;
      try {
        await runGit(
          target.path,
          [
            '-c',
            'gc.auto=0',
            'fetch',
            '--quiet',
            '--no-write-fetch-head',
            '--no-auto-maintenance',
            '--',
            target.remote,
          ],
          { timeout: FETCH_TIMEOUT_MS, env: fetchEnv() },
        );
      } catch {
        // Silent in background: offline networks, locked SSH keys or unreachable remotes are retried on the next tick.
      }
    }

    if (this.stopped || tracked.length === 0) return;
    let changed = false;
    for (const entry of tracked) {
      const after = await git(entry.path, ['rev-parse', '--verify', '@{upstream}']).catch(() => null);
      if (after !== null && after !== entry.upstream) changed = true;
    }
    if (changed && !this.stopped) this.onChange();
  }
}
