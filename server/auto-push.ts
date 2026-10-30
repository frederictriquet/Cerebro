import { git as runGit } from './git.ts';
import type { CerebroDatabase } from './db.ts';
import type { GitPushes } from './git-push.ts';
import { errorMessage } from './util.ts';

const INTERVAL_MS = 5000;
const git = async (path: string, args: string[]): Promise<string> => (await runGit(path, args)).trim();

interface Head {
  path: string;
  branch: string;
  commit: string;
}

/** Branch and commit of the folder; null on a detached HEAD, an empty repository or outside Git. */
async function readHead(path: string): Promise<Head | null> {
  try {
    const [branch, commit] = await Promise.all([
      git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      git(path, ['rev-parse', '--verify', 'HEAD']),
    ]);
    return branch && commit ? { path, branch, commit } : null;
  } catch {
    return null;
  }
}

/** True when the branch has commits its upstream lacks, or no upstream yet while a remote can receive it. */
async function unpushed(path: string): Promise<boolean> {
  const upstream = await git(path, ['rev-parse', '--verify', '@{upstream}']).catch(() => null);
  if (upstream === null) return (await git(path, ['remote'])) !== '';
  return Number(await git(path, ['rev-list', '--count', `${upstream}..HEAD`, '--'])) > 0;
}

/**
 * Pushes the project folder of projects with `autoPush` whenever a new commit lands on its branch, whoever created it
 * (Cerebro, an agent, a merge). HEAD is polled: the first reading, a branch switch or a HEAD that only moved back to
 * pushed commits push nothing. A failed push is reported like a manual one and retried only on the next commit.
 */
export class AutoPush {
  private readonly seen = new Map<string, Head>();
  private readonly db: CerebroDatabase;
  private readonly pushes: GitPushes;
  /** A Cerebro operation still creating commits in this folder: it pushes, or not, by itself. */
  private readonly busy: (path: string) => boolean;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(db: CerebroDatabase, pushes: GitPushes, busy: (path: string) => boolean) {
    this.db = db;
    this.pushes = pushes;
    this.busy = busy;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const projects = this.db.listProjects().filter((project) => project.autoPush);
      for (const id of this.seen.keys()) if (!projects.some((project) => project.id === id)) this.seen.delete(id);
      for (const project of projects) {
        try {
          await this.check(project.id, project.path);
        } catch (cause) {
          console.warn(`[auto-push] ${project.path} :`, errorMessage(cause));
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async check(id: string, path: string): Promise<void> {
    const head = await readHead(path);
    const previous = this.seen.get(id);
    if (!head) return void this.seen.delete(id);
    if (previous && previous.path === head.path && previous.branch === head.branch && previous.commit === head.commit)
      return;
    // Left unrecorded so that the next tick looks again once the folder is free.
    if (this.busy(path) || (await this.pushes.current(path))?.status === 'running') return;
    if (previous && previous.path === head.path && previous.branch === head.branch && (await unpushed(path))) {
      try {
        await this.pushes.start(path, {
          allowDirty: true,
          expectedHead: head.commit,
          expectedBranch: `refs/heads/${head.branch}`,
        });
      } catch (cause) {
        // A merge or another Git operation holds the folder: retried on the next tick.
        console.warn(`[auto-push] push différé pour ${path} :`, errorMessage(cause));
        return;
      }
    }
    this.seen.set(id, head);
  }
}
