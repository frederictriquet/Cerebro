import type { CerebroDatabase } from './db.ts';
import { sessionWorkspaces } from './provenance.ts';
import { canonicalWorktreePath, pathWithin } from './worktree-gate.ts';
import { isActiveRun, type CommandRun, type EpicRun } from '../shared/backlog.ts';
import type { AutomaticCommit } from '../shared/git.ts';
import type { Session } from '../shared/types.ts';

/** A session taking its turn: it may write in its folder at any moment. */
export const sessionBusy = (status: string): boolean => status !== 'idle' && status !== 'exited';

/** What works in a repository folder: open sessions, and how many runs of each kind are in progress. */
export interface RepositoryActivity { sessions: Session[]; commands: number; automaticCommits: number; epics: number }

/**
 * Activity in `root` (canonical) or below it: sessions not exited whose folder is there, running commands and automatic
 * commits, active epics. Each table is read once, whatever the number of sessions.
 */
export function repositoryActivity(db: CerebroDatabase, root: string): RepositoryActivity {
  const inside = (path: string | null | undefined): boolean => !!path && pathWithin(root, canonicalWorktreePath(path));
  const runs = <T>(table: string): T[] => (db.connection.prepare(`SELECT data FROM ${table}`).all() as {data:string}[]).map(row => JSON.parse(row.data) as T);
  const workspaces = sessionWorkspaces(db);
  const projects = new Map(db.listProjects().map(project => [project.id, project.path]));
  return {
    sessions: db.listSessions().filter(session => session.status !== 'exited' && inside(workspaces.get(session.id)?.path ?? projects.get(session.projectId))),
    commands: runs<CommandRun>('command_runs').filter(run => run.status === 'running' && inside(run.cwd)).length,
    automaticCommits: runs<AutomaticCommit>('automatic_commits').filter(run => run.status === 'running' && inside(run.path)).length,
    epics: runs<EpicRun>('epic_runs').filter(run => isActiveRun(run) && inside(run.contextRoot)).length,
  };
}
