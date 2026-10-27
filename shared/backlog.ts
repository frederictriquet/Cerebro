// Backlog contracts read by the web UI: epic runs and their copy, review findings, project commands, session tasks.
import { array, boolean, literal, nullable, number, object, optional, parser, record, string } from './parse.ts';
import { AGENTS, EFFORTS, MODES, type SessionDefaults } from './types.ts';
import { workspaceContextSchema, type WorkspaceContext } from './git.ts';

export interface EpicRun {
  id:string;epicId:string;projectId:string;status:'running'|'waiting-validation'|'blocked'|'failed'|'stopped'|'succeeded';
  order:string[];members:string[];versions:Record<string,string>;results:Record<string,string>;
  currentTaskId:string|null;sessionId:string|null;commandRunId:string|null;stepStartedAt:number;
  contextRoot:string;options:SessionDefaults;error:string|null;startedAt:number;updatedAt:number;
  // When the step's session was first seen waiting; null once it is no longer waiting.
  waitingSince?:number|null;
  // Explicit criteria reported by the current step, retained through blocking and replanning.
  validationReason?:string|null;
  autoValidate?:boolean;
  // Why a blocked run is blocked: 'session-waiting' clears by itself once the step's session stops waiting or its task is done; any other block needs an explicit resume.
  blockReason?:'session-waiting'|null;
  // HEAD of the project folder when the run started: base of the epic review when work is not isolated in a worktree.
  baseHead?:string|null;
  workspace?:WorkspaceContext|null;
  workspaceConflict?:boolean;
  // Why the epic's folder cannot be resolved from its history (computed when listed, never stored); start/resume fail on it.
  workspaceError?:string|null;
}

// Exécutions qui occupent encore l'epic : en cours, en attente de validation ou bloquées.
export const ACTIVE_RUN_STATUSES: readonly EpicRun['status'][] = ['running', 'waiting-validation', 'blocked'];
export const isActiveRun = (run: Pick<EpicRun, 'status'>): boolean => ACTIVE_RUN_STATUSES.includes(run.status);

export interface EpicWorkspaceChoice extends WorkspaceContext {
  branch: string | null;
  head: string | null;
  changes: string[] | null;
  unavailableReason: string | null;
  sessions: {id: string; title: string}[];
}
export interface EpicWorkspaceOptions {
  conflict: boolean;
  selected: WorkspaceContext | null;
  choices: EpicWorkspaceChoice[];
}

export interface Finding { id:string; title:string; severity:'critical'|'high'|'medium'|'low'; file:string; line:number; problem:string; scenario:string; expectedFix:string; dependsOn:string[]; taskDependencies:string[] }
export interface FindingReport { title:string; findings:Finding[] }
export interface SavedReport extends FindingReport { id:string; sessionId:string; createdAt:number; epicId:string|null; imported:Record<string,string> }

export interface ProjectCommand {id:string;projectId:string;name:string;executable:string;args:string[];cwd:string;timeoutSeconds:number}
export interface CommandRun {id:string;taskId:string;pid:number|null;command:ProjectCommand;cwd:string;status:'running'|'succeeded'|'failed'|'stopped'|'interrupted';output:string;startedAt:number;finishedAt:number|null;exitCode:number|null;error:string|null}

/** Done tasks and epics deleted from a project's backlog. */
export interface CompletedBacklogDeletion { taskIds: string[]; epicIds: string[] }

export const SESSION_TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export type SessionTaskStatus = (typeof SESSION_TASK_STATUSES)[number];
export interface SessionTask {
  id: string;
  sessionId: string;
  title: string;
  status: SessionTaskStatus;
  note: string;
  createdAt: number;
  updatedAt: number;
}

const strings = array(string);

const epicRun = object<EpicRun>({
  id: string, epicId: string, projectId: string,
  status: literal('running', 'waiting-validation', 'blocked', 'failed', 'stopped', 'succeeded'),
  order: strings, members: strings, versions: record(string), results: record(string),
  currentTaskId: nullable(string), sessionId: nullable(string), commandRunId: nullable(string), stepStartedAt: number,
  contextRoot: string,
  options: object<SessionDefaults>({
    agent: literal(...AGENTS), mode: literal(...MODES), model: nullable(string), effort: nullable(literal(...EFFORTS)), prompt: string,
  }),
  error: nullable(string), startedAt: number, updatedAt: number,
  waitingSince: optional(nullable(number)), validationReason: optional(nullable(string)), autoValidate: optional(boolean),
  blockReason: optional(nullable(literal('session-waiting'))), baseHead: optional(nullable(string)),
  workspace: optional(nullable(workspaceContextSchema)), workspaceConflict: optional(boolean), workspaceError: optional(nullable(string)),
});

export const parseEpicRun = parser(epicRun);
export const parseEpicRunList = parser(array(epicRun));

export const parseEpicWorkspaceOptions = parser(object<EpicWorkspaceOptions>({
  conflict: boolean,
  selected: nullable(workspaceContextSchema),
  choices: array(object<EpicWorkspaceChoice>({
    mode: literal('isolated', 'shared', 'unknown'), path: string, branch: nullable(string), head: nullable(string),
    changes: nullable(strings), unavailableReason: nullable(string),
    sessions: array(object<EpicWorkspaceChoice['sessions'][number]>({ id: string, title: string })),
  })),
}));

export const parseSavedReports = parser(array(object<SavedReport>({
  title: string,
  findings: array(object<Finding>({
    id: string, title: string, severity: literal('critical', 'high', 'medium', 'low'), file: string, line: number,
    problem: string, scenario: string, expectedFix: string, dependsOn: strings, taskDependencies: strings,
  })),
  id: string, sessionId: string, createdAt: number, epicId: nullable(string), imported: record(string),
})));

const projectCommand = object<ProjectCommand>({
  id: string, projectId: string, name: string, executable: string, args: strings, cwd: string, timeoutSeconds: number,
});

export const parseProjectCommand = parser(projectCommand);
export const parseProjectCommands = parser(array(projectCommand));
export const parseCommandRuns = parser(array(object<CommandRun>({
  id: string, taskId: string, pid: nullable(number), command: projectCommand, cwd: string,
  status: literal('running', 'succeeded', 'failed', 'stopped', 'interrupted'), output: string, startedAt: number,
  finishedAt: nullable(number), exitCode: nullable(number), error: nullable(string),
})));

export const parseCompletedBacklogDeletion = parser(object<CompletedBacklogDeletion>({ taskIds: strings, epicIds: strings }));

export const parseSessionTasks = parser(array(object<SessionTask>({
  id: string, sessionId: string, title: string, status: literal(...SESSION_TASK_STATUSES), note: string,
  createdAt: number, updatedAt: number,
})));
