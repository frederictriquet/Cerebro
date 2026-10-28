// Worktree inventory and removal of the starting content of a copy, as read by the web UI.
import {
  array,
  boolean,
  literal,
  nullable,
  number,
  object,
  optional,
  parser,
  string,
  variant,
  type Schema,
} from './parse.ts';
import { commitSettingsSchema } from './git.ts';
import type { CommitSettings } from './types.ts';

export interface WorktreeRecord {
  id: string;
  commonDir: string;
  path: string;
  source: string;
  projectId: string | null;
  projectName: string;
  sessionId: string | null;
  sessionTitle: string | null;
  managed: boolean;
  expectedBranch: string | null;
  targetBranch: string | null;
  sharedIgnored?: string[];
  createdAt: number;
  removedAt: number | null;
  commitSettings?: CommitSettings;
  /** Last automatic cleanup decision, taken when the conversation ended or was deleted. */
  autoCleanup?: AutomaticCleanup;
  /** Removed from the visible history; retain provenance and cleanup records. */
  historyDeletedAt?: number;
}
export interface AutomaticCleanup {
  status: 'removed' | 'kept' | 'failed';
  at: number;
  reasons: string[];
}
export interface WorktreeOperation {
  id: string;
  worktreeId: string;
  kind: 'merge' | 'remove';
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  targetBranch: string | null;
  sourceHead: string | null;
  targetHead: string | null;
  resultHead: string | null;
  output: string;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  automatic?: boolean;
}
export interface WorktreeView extends WorktreeRecord {
  projectExists: boolean;
  session: { id: string; title: string; status: string } | null;
  primary: boolean;
  branch: string | null;
  head: string | null;
  dirty: number | null;
  files: string[];
  ignored: number | null;
  ignoredFiles: string[];
  /** Ignored entries with nothing to lose, deleted on removal instead of blocking it. */
  disposableIgnored: string[];
  ahead: number | null;
  behind: number | null;
  targetPath: string | null;
  targetHead: string | null;
  targets: { branch: string; path: string }[];
  integration: 'integrated' | 'pending' | 'unknown';
  /** Whether the copy's commits are in the target's upstream branch; null without upstream or before integration. */
  published: boolean | null;
  mergeInProgress: boolean;
  activeSessions: { id: string; title: string; status: string }[];
  mergeBlockers: string[];
  removeBlockers: string[];
  fingerprint: string | null;
  error: string | null;
  operation: WorktreeOperation | null;
  changesSinceCreation: { count: number; files: string[]; inheritedCount: number; needsReviewCount: number } | null;
  /** Dirty files holding content copied from the project at creation, or not yet confirmed free of it (first 100). */
  startingContent: StartingContent[] | null;
  /** Number of files with uncommitted changes in the target worktree, when it is known. */
  targetDirty: number | null;
  /** Files that merging the copy's commits with the target would leave in conflict; null when not computed. */
  integrationConflicts: string[] | null;
  /** Limits of the conflict forecast, when it only approximates Git's merge. */
  integrationNote: string | null;
  /** Files still in conflict while a merge is in progress in the copy. */
  conflicts: string[];
}
/** A copy removed automatically: still listed so its branch and conversation can be found again. */
export interface CleanedWorktree {
  id: string;
  path: string;
  projectId: string | null;
  projectName: string;
  sessionId: string | null;
  sessionTitle: string | null;
  session: { id: string; title: string; status: string } | null;
  branch: string | null;
  removedAt: number;
}
/** Where the content copied from the project at creation can still be found. */
export type StartingOrigin =
  { kind: 'target-commit'; commit: string; subject: string } | { kind: 'target-worktree' } | { kind: 'snapshot' };
/** A dirty file of the copy that still holds content copied from the project at creation. */
export interface StartingContent {
  path: string;
  /**
   * inherited: unchanged since the copy; mixed: copied content edited since, by the conversation or someone else;
   * settled: edited since, and the copied content no longer appears in its uncommitted changes.
   */
  state: 'inherited' | 'mixed' | 'settled';
  /** null: this content now only exists in the copy. */
  origin: StartingOrigin | null;
  /** A mixed file whose starting content can be removed automatically, unless its recent changes overlap it. */
  separable: boolean;
}
/** What removing the starting content does to one file. */
export interface StartingContentStep {
  path: string;
  state: StartingContent['state'];
  origin: StartingOrigin | null;
  /**
   * restore: back to the copy's last commit; separate: keep only the changes made since the copy; settle: no starting
   * content left, the file becomes the conversation's work unchanged; keep: left for a manual review.
   */
  action: 'restore' | 'separate' | 'settle' | 'keep';
  reason: string | null;
  /** Changes left to commit for this file once the action is applied; for a kept file, its current changes. */
  diff: string;
  /** Content the plan was made with: a confirmation applies to this content only. */
  version: string | null;
}
export interface StartingContentPlan {
  /** The copy first receives the target's new commits, so the changes kept apply to its latest version. */
  targetUpdate: { branch: string; commits: number } | null;
  steps: StartingContentStep[];
}
/** Outcome of the removal of the starting content, with the copy as it now stands. */
export interface StartingContentDiscard {
  restored: string[];
  separated: string[];
  settled: string[];
  kept: StartingContentStep[];
  targetUpdate: StartingContentPlan['targetUpdate'];
  view: WorktreeView;
}
/** View of a copy with the token that confirms the merge or removal prepared on it. */
export interface PreparedWorktreeOperation {
  token: string;
  view: WorktreeView;
}
export interface WorktreeInventory {
  worktrees: WorktreeView[];
  cleaned: CleanedWorktree[];
  errors: string[];
}

const strings = array(string);

type SessionSummary = { id: string; title: string; status: string };
const sessionSummary = object<SessionSummary>({ id: string, title: string, status: string });

const origin: Schema<StartingOrigin> = variant<StartingOrigin, 'kind'>('kind', {
  'target-commit': object<Extract<StartingOrigin, { kind: 'target-commit' }>>({
    kind: literal('target-commit'),
    commit: string,
    subject: string,
  }),
  'target-worktree': object<Extract<StartingOrigin, { kind: 'target-worktree' }>>({ kind: literal('target-worktree') }),
  snapshot: object<Extract<StartingOrigin, { kind: 'snapshot' }>>({ kind: literal('snapshot') }),
});

const startingState = literal('inherited', 'mixed', 'settled');

const worktreeView = object<WorktreeView>({
  id: string,
  commonDir: string,
  path: string,
  source: string,
  projectId: nullable(string),
  projectName: string,
  sessionId: nullable(string),
  sessionTitle: nullable(string),
  managed: boolean,
  expectedBranch: nullable(string),
  targetBranch: nullable(string),
  sharedIgnored: optional(strings),
  createdAt: number,
  removedAt: nullable(number),
  commitSettings: optional(commitSettingsSchema),
  autoCleanup: optional(
    object<AutomaticCleanup>({ status: literal('removed', 'kept', 'failed'), at: number, reasons: strings }),
  ),
  historyDeletedAt: optional(number),
  projectExists: boolean,
  session: nullable(sessionSummary),
  primary: boolean,
  branch: nullable(string),
  head: nullable(string),
  dirty: nullable(number),
  files: strings,
  ignored: nullable(number),
  ignoredFiles: strings,
  disposableIgnored: strings,
  ahead: nullable(number),
  behind: nullable(number),
  targetPath: nullable(string),
  targetHead: nullable(string),
  targets: array(object<WorktreeView['targets'][number]>({ branch: string, path: string })),
  integration: literal('integrated', 'pending', 'unknown'),
  published: nullable(boolean),
  mergeInProgress: boolean,
  activeSessions: array(sessionSummary),
  mergeBlockers: strings,
  removeBlockers: strings,
  fingerprint: nullable(string),
  error: nullable(string),
  operation: nullable(
    object<WorktreeOperation>({
      id: string,
      worktreeId: string,
      kind: literal('merge', 'remove'),
      status: literal('running', 'succeeded', 'failed', 'interrupted'),
      targetBranch: nullable(string),
      sourceHead: nullable(string),
      targetHead: nullable(string),
      resultHead: nullable(string),
      output: string,
      error: nullable(string),
      startedAt: number,
      finishedAt: nullable(number),
      automatic: optional(boolean),
    }),
  ),
  changesSinceCreation: nullable(
    object<NonNullable<WorktreeView['changesSinceCreation']>>({
      count: number,
      files: strings,
      inheritedCount: number,
      needsReviewCount: number,
    }),
  ),
  startingContent: nullable(
    array(
      object<StartingContent>({ path: string, state: startingState, origin: nullable(origin), separable: boolean }),
    ),
  ),
  targetDirty: nullable(number),
  integrationConflicts: nullable(strings),
  integrationNote: nullable(string),
  conflicts: strings,
});

const step = object<StartingContentStep>({
  path: string,
  state: startingState,
  origin: nullable(origin),
  action: literal('restore', 'separate', 'settle', 'keep'),
  reason: nullable(string),
  diff: string,
  version: nullable(string),
});

const targetUpdate = nullable(
  object<NonNullable<StartingContentPlan['targetUpdate']>>({ branch: string, commits: number }),
);

export const parseWorktreeInventory = parser(
  object<WorktreeInventory>({
    worktrees: array(worktreeView),
    cleaned: array(
      object<CleanedWorktree>({
        id: string,
        path: string,
        projectId: nullable(string),
        projectName: string,
        sessionId: nullable(string),
        sessionTitle: nullable(string),
        session: nullable(sessionSummary),
        branch: nullable(string),
        removedAt: number,
      }),
    ),
    errors: strings,
  }),
);
export const parseStartingContentPlan = parser(object<StartingContentPlan>({ targetUpdate, steps: array(step) }));
export const parseStartingContentDiscard = parser(
  object<StartingContentDiscard>({
    restored: strings,
    separated: strings,
    settled: strings,
    kept: array(step),
    targetUpdate,
    view: worktreeView,
  }),
);
export const parsePreparedWorktreeOperation = parser(
  object<PreparedWorktreeOperation>({ token: string, view: worktreeView }),
);

/**
 * A declared regenerable path in its canonical form (`web/dist`), or null when it could leave the copy or designate
 * Git's own data: absolute, `.`/`..` segments, `.git`.
 */
export function normalizeRegenerablePath(raw: string): string | null {
  const segments = raw
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
    .split(/\/+/);
  if (raw.includes('\0') || raw.includes('\\') || raw.trim().startsWith('/')) return null;
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment === '.git'))
    return null;
  return segments.join('/');
}
