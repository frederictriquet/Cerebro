import { Catalog } from './catalog.ts';
import type { CerebroDatabase } from './db.ts';
import { EpicWorkspaces } from './epic-workspace.ts';
import { GitPlanner } from './git-plan.ts';
import { GitPushes } from './git-push.ts';
import { Reviews } from './review.ts';
import { SessionGit } from './session-git.ts';
import { WorktreeGate } from './worktree-gate.ts';

/** In-memory state shared by a server's routes and managers, built once by buildServer and injected. */
export interface Services {
  gate: WorktreeGate;
  pushes: GitPushes;
  git: GitPlanner;
  reviews: Reviews;
  sessionGit: SessionGit;
  epicWorkspaces: EpicWorkspaces;
  catalog: Catalog;
}

export function createServices(db: CerebroDatabase, catalog = new Catalog()): Services {
  const gate = new WorktreeGate();
  const pushes = new GitPushes(gate);
  const git = new GitPlanner(gate, pushes);
  return {
    gate,
    pushes,
    git,
    reviews: new Reviews(git),
    sessionGit: new SessionGit(db, git),
    epicWorkspaces: new EpicWorkspaces(db, gate),
    catalog,
  };
}
