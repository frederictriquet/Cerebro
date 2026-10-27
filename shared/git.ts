// Git contracts read by the web UI: snapshots to commit, pushes, reviews, provenance and automatic commits.
import {
  array,
  boolean,
  literal,
  nullable,
  number,
  object,
  optional,
  parser,
  record,
  string,
  type Schema,
} from './parse.ts';
import { AGENTS, EFFORTS, type CommitSettings } from './types.ts';

export interface GitHunk {
  id: string;
  patch: string;
}
export interface GitCandidate {
  path: string;
  diff: string;
  hunks: GitHunk[];
  warnings: string[];
  blocked: boolean;
}
export interface GitSnapshot {
  root: string;
  id: string;
  head: string | null;
  branch: string | null;
  fingerprint: string;
  files: GitCandidate[];
  stagedDiff: string;
  log: string;
  createdAt: number;
}
export interface CommitResult {
  commits: { hash: string; title: string }[];
  exclusions: string[];
  error: string | null;
  pushId: string | null;
  operationId?: string;
  blocked?: boolean;
}

export interface PushRemoteResult {
  remote: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  upstream: boolean;
  exitCode: number | null;
  output: string;
}
export interface PushOperation {
  id: string;
  branch: string | null;
  head: string | null;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  remotes: PushRemoteResult[];
}

export interface PreparedReview {
  id: string;
  root: string;
  snapshotId: string;
  scope: 'working' | 'unpushed' | 'last-commit' | 'empty';
  head: string | null;
  upstream: string | null;
  commits: string[];
  files: string[];
  context: string;
}

export interface WorkspaceContext {
  mode: 'isolated' | 'shared' | 'unknown';
  path: string;
}
export interface Workspace {
  sessionId: string;
  projectId?: string;
  projectName?: string;
  projectRoot?: string;
  targetBranch?: string | null;
  removedAt?: number;
  /** The copy was removed by the automatic cleanup at the end of the conversation, not by an explicit action. */
  removedAutomatically?: boolean;
  mode: 'isolated' | 'shared' | 'unknown';
  path: string;
  root: string;
  source: string;
  base: string | null;
  branch: string | null;
  initialDirty: string[];
  baseline: Record<string, string>;
  /** Directory, outside the repository, holding the files that were already modified in the project when the copy was created. */
  startingCopy?: string;
  /** Legacy: commit (under refs/cerebro/starting/) that held that content before it was kept out of Git. */
  startingSnapshot?: string;
  sharedIgnored?: string[];
  reason: string;
  createdAt: number;
}
export interface Provenance {
  workspace: Workspace;
  changes: { path: string; certainty: 'workspace' | 'uncertain'; reason: string }[];
  commits: { hash: string; title: string; certainty: 'workspace' | 'uncertain' }[];
  warning: string;
}

export interface SessionGitSnapshot extends GitSnapshot {
  provenance: Provenance;
  scopeNotice: string;
}
export interface SessionGitContext {
  mode: 'shared' | 'isolated' | 'removed';
  projectId: string;
  projectName: string;
  path: string;
}

export interface AutomaticCommit {
  id: string;
  scope: string;
  path: string;
  projectId: string | null;
  sessionId: string | null;
  settings: CommitSettings;
  push: boolean;
  /**
   * Outcome, on the vocabulary shared by the server's operations (running, succeeded, failed; see PushOperation)
   * plus the endings specific to automatic commits: blocked by a precondition, cancelled by the user, interrupted
   * by a server restart.
   */
  status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'interrupted';
  /** Step reached, independent of the outcome: `finished` once the status is no longer running. */
  phase: 'collecting' | 'drafting' | 'committing' | 'pushing' | 'finished';
  files: string[];
  exclusions: { path: string; reason: string }[];
  commits: CommitResult['commits'];
  pushOperation: PushOperation | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  needsProjectScope: boolean;
  /** Files the user reviewed in a diff snapshot; included despite warnings only while that diff is unchanged. */
  reviewed?: { snapshotId: string; paths: string[] };
}

const strings = array(string);

export const commitSettingsSchema = object<CommitSettings>({
  agent: literal(...AGENTS),
  model: nullable(string),
  effort: nullable(literal(...EFFORTS)),
  strategy: literal('single', 'atomic'),
});

const gitSnapshotFields = {
  root: string,
  id: string,
  head: nullable(string),
  branch: nullable(string),
  fingerprint: string,
  files: array(
    object<GitCandidate>({
      path: string,
      diff: string,
      hunks: array(object<GitHunk>({ id: string, patch: string })),
      warnings: strings,
      blocked: boolean,
    }),
  ),
  stagedDiff: string,
  log: string,
  createdAt: number,
};

const pushOperationSchema = object<PushOperation>({
  id: string,
  branch: nullable(string),
  head: nullable(string),
  status: literal('running', 'succeeded', 'failed'),
  startedAt: number,
  finishedAt: nullable(number),
  error: nullable(string),
  remotes: array(
    object<PushRemoteResult>({
      remote: string,
      status: literal('pending', 'running', 'succeeded', 'failed'),
      upstream: boolean,
      exitCode: nullable(number),
      output: string,
    }),
  ),
});

const workspaceMode = literal('isolated', 'shared', 'unknown');

export const workspaceContextSchema = object<WorkspaceContext>({ mode: workspaceMode, path: string });

const certainty = literal('workspace', 'uncertain');

const provenanceSchema = object<Provenance>({
  workspace: object<Workspace>({
    sessionId: string,
    projectId: optional(string),
    projectName: optional(string),
    projectRoot: optional(string),
    targetBranch: optional(nullable(string)),
    removedAt: optional(number),
    removedAutomatically: optional(boolean),
    mode: workspaceMode,
    path: string,
    root: string,
    source: string,
    base: nullable(string),
    branch: nullable(string),
    initialDirty: strings,
    baseline: record(string),
    startingCopy: optional(string),
    startingSnapshot: optional(string),
    sharedIgnored: optional(strings),
    reason: string,
    createdAt: number,
  }),
  changes: array(object<Provenance['changes'][number]>({ path: string, certainty, reason: string })),
  commits: array(object<Provenance['commits'][number]>({ hash: string, title: string, certainty })),
  warning: string,
});

export const parsePushOperation = parser(pushOperationSchema);
export const parseOptionalPushOperation = parser(nullable(pushOperationSchema));
export const parseGitSnapshot = parser(object<GitSnapshot>(gitSnapshotFields));
export const parseSessionGitSnapshot = parser(
  object<SessionGitSnapshot>({
    ...gitSnapshotFields,
    provenance: provenanceSchema,
    scopeNotice: string,
  }),
);
export const parseSessionGitContext = parser(
  object<SessionGitContext>({
    mode: literal('shared', 'isolated', 'removed'),
    projectId: string,
    projectName: string,
    path: string,
  }),
);
export const parseProvenance = parser(provenanceSchema);
export const parseOptionalWorkspaceContext = parser(nullable(workspaceContextSchema));
export const parsePreparedReview = parser(
  object<PreparedReview>({
    id: string,
    root: string,
    snapshotId: string,
    scope: literal('working', 'unpushed', 'last-commit', 'empty'),
    head: nullable(string),
    upstream: nullable(string),
    commits: strings,
    files: strings,
    context: string,
  }),
);

const commitsSchema: Schema<CommitResult['commits']> = array(
  object<CommitResult['commits'][number]>({ hash: string, title: string }),
);

export const parseAutomaticCommit = parser(
  object<AutomaticCommit>({
    id: string,
    scope: string,
    path: string,
    projectId: nullable(string),
    sessionId: nullable(string),
    settings: commitSettingsSchema,
    push: boolean,
    status: literal('running', 'succeeded', 'failed', 'blocked', 'cancelled', 'interrupted'),
    phase: literal('collecting', 'drafting', 'committing', 'pushing', 'finished'),
    files: strings,
    exclusions: array(object<AutomaticCommit['exclusions'][number]>({ path: string, reason: string })),
    commits: commitsSchema,
    pushOperation: nullable(pushOperationSchema),
    error: nullable(string),
    startedAt: number,
    finishedAt: nullable(number),
    needsProjectScope: boolean,
    reviewed: optional(object<NonNullable<AutomaticCommit['reviewed']>>({ snapshotId: string, paths: strings })),
  }),
);
