// Contrat des données échangées entre le serveur, l'UI web et les autres machines : une seule définition
// des deux côtés, et les parseurs qui valident ce qui arrive d'un autre processus.
import { asNullableNumber, asNullableString, asNumber, asString, isRecord, parseItems } from './parse.ts';
import type { CommandRun, EpicRun } from './backlog.ts';

export type Agent = 'claude' | 'codex' | 'grok';
// « default » (agent configuration) remains a stored mode: sessions launched before its removal keep it.
export type Mode = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypass';
export type Status = 'starting' | 'running' | 'waiting' | 'idle' | 'exited';
export type TaskExecution =
  { type: 'llm' } | { type: 'command'; commandId: string; completion: 'manual' | 'exit-zero' };
export type TaskStatus = 'todo' | 'started' | 'done';
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type WorkspaceMode = 'isolated' | 'shared';

export const AGENTS: readonly Agent[] = ['claude', 'codex', 'grok'];
export const MODES: readonly Mode[] = ['auto', 'default', 'acceptEdits', 'plan', 'bypass'];
// Modes offered by the widgets and sent for new launches: « default » is not a choice any more.
export type ModeChoice = Exclude<Mode, 'default'>;
export const MODE_CHOICES: readonly ModeChoice[] = ['auto', 'acceptEdits', 'plan', 'bypass'];

// A stored « default » is shown and launched as the default mode, « auto ».
export function normalizeMode(mode: Mode): ModeChoice {
  return mode === 'default' ? 'auto' : mode;
}
// Saved settings are normalized at read, so the widgets only ever receive a ModeChoice.
function parseMode(v: unknown): ModeChoice | null {
  return isMode(v) ? normalizeMode(v) : null;
}
export const EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// Réglages de lancement d'une session : ce que le formulaire envoie, et ce que le projet mémorise.
export interface SessionDefaults {
  agent: Agent;
  mode: Mode;
  // null: model / effort Cerebro default, resolved by the server (parseTuning).
  model: string | null;
  effort: Effort | null;
  prompt: string;
}

export const DEFAULT_SESSION_DEFAULTS: Readonly<SessionDefaults> = {
  agent: 'claude',
  mode: 'auto',
  model: null,
  effort: null,
  prompt: '',
};

export interface CommitSettings {
  agent: Agent;
  model: string | null;
  effort: Effort | null;
  strategy: 'single' | 'atomic';
}
export const DEFAULT_COMMIT_SETTINGS: Readonly<CommitSettings> = {
  agent: 'claude',
  model: null,
  effort: null,
  strategy: 'single',
};

/** Session launched to separate the starting content of a copy from the conversation's work, file by file. */
export type ResolutionSettings = Pick<SessionDefaults, 'agent' | 'mode' | 'model' | 'effort'>;
export const DEFAULT_RESOLUTION_SETTINGS: Readonly<ResolutionSettings> = {
  agent: 'claude',
  mode: 'auto',
  model: null,
  effort: null,
};

// Agent, model and effort (null: Cerebro default, resolved by parseTuning).
export interface Llm {
  agent: Agent;
  model: string | null;
  effort: Effort | null;
}

// Une persona du catalogue de la machine : un angle de réflexion, indépendant de l'agent qui la joue.
export interface Persona {
  id: string;
  name: string;
  description: string;
  prompt: string;
  // Fournie par Cerebro : modifiable et supprimable comme les autres, jamais réinsérée.
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
}

export type PersonaInput = Pick<Persona, 'name' | 'description' | 'prompt'>;

// Un participant à un council : une persona jouée par un agent.
export interface Participant extends Llm {
  personaId: string;
}

export interface CouncilSettings {
  // Agent, modèle et effort proposés par défaut pour chaque persona (clé : personaId).
  assignments: Record<string, Llm>;
  // Participants cochés par défaut au lancement.
  defaultPersonaIds: string[];
  chairman: Llm;
  // Valeur proposée par défaut pour « laisser les conseillers lire le projet ».
  readProject: boolean;
}

// Limites de l'API des personas.
export const MAX_PERSONA_NAME_LENGTH = 80;
export const MAX_PERSONA_DESCRIPTION_LENGTH = 300;
export const MAX_PERSONA_PROMPT_LENGTH = 4000;
export const MIN_PERSONAS = 2;
// Nombre de conseillers d'un council.
export const MIN_ADVISORS = 2;
export const MAX_ADVISORS = 8;
export const MAX_COUNCIL_IMAGES = 10;

// Copie figée dans un run : un rapport reste lisible si la persona est modifiée ou supprimée ensuite.
export interface Advisor extends Participant, PersonaInput {}

export type CouncilStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type CouncilPhase = 'answering' | 'reviewing' | 'synthesizing' | 'finished';

// advisorId : personaId du conseiller, unique dans un run.
export interface CouncilAnswer {
  advisorId: string;
  text: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface CouncilRanking {
  letter: string;
  reason: string;
}

export interface CouncilReview {
  advisorId: string;
  ranking: CouncilRanking[];
  blindSpot: string | null;
  missed: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface CouncilSynthesis {
  agreements: string;
  disagreements: string;
  blindSpots: string;
  recommendation: string;
  firstAction: string;
}

// Image jointe au lancement : `n` est le numéro du jeton « [Image #n] » placé dans la question ou le contexte,
// `path` le fichier enregistré sous le dossier des pièces jointes du serveur.
export interface CouncilImage {
  n: number;
  path: string;
}

export interface CouncilRun {
  id: string;
  projectId: string | null;
  origin: 'web' | 'slack';
  question: string;
  // Contexte collé par l'utilisateur.
  context: string;
  // Images jointes, transmises à chaque appel (réponses, relectures, synthèse).
  images: CouncilImage[];
  readProject: boolean;
  // Copies figées au lancement.
  settings: CouncilSettings;
  advisors: Advisor[];
  status: CouncilStatus;
  phase: CouncilPhase;
  // advisorId -> 'A', 'B'… tirées au hasard pour chaque run.
  letters: Record<string, string>;
  answers: CouncilAnswer[];
  reviews: CouncilReview[];
  synthesis: CouncilSynthesis | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface AggregatedRank {
  letter: string;
  advisorId: string;
  // Rang moyen (1 = meilleur) sur les relectures réussies ; null si aucune ne l'a classée.
  averageRank: number | null;
  votes: number;
}

/** How a message read in a watched Slack thread or channel reaches its session. */
export const WATCH_DELIVERIES = ['inject', 'dm', 'notify'] as const;
export type WatchDelivery = (typeof WATCH_DELIVERIES)[number];
/** Once the session has ended, nothing can be typed into it. */
export const WATCH_ENDED_DELIVERIES = ['dm', 'notify'] as const;
export type WatchEndedDelivery = (typeof WATCH_ENDED_DELIVERIES)[number];

/**
 * What Cerebro posts to Slack about one project, in place of the machine's Slack settings. `off`: nothing (alerts,
 * agent messages, operation results, watched messages are only typed into the session); `custom`: these values.
 * Replies to a command sent from Slack still answer in its thread.
 */
export interface ProjectSlackSettings {
  mode: 'off' | 'custom';
  waiting: boolean;
  idle: boolean;
  agentMessages: boolean;
  /** Never empty. */
  watchDeliveryLive: WatchDelivery[];
  /** Empty drops the message. */
  watchDeliveryEnded: WatchEndedDelivery[];
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string | null;
  sessionDefaults: SessionDefaults;
  commitSettings: CommitSettings;
  // null : le projet suit les réglages globaux du council.
  councilSettings: CouncilSettings | null;
  // null : le projet suit les réglages Slack de la machine.
  slackSettings: ProjectSlackSettings | null;
  resolutionSettings: ResolutionSettings;
  workspaceMode: WorkspaceMode;
  /**
   * Ignored paths of a copy, relative to its root, that a build or an install recreates (e.g. `web/dist`): removing
   * the copy deletes them like the regenerable folders at its root.
   */
  regenerablePaths: string[];
  createdAt: number;
}

export interface Session {
  id: string;
  projectId: string;
  agent: Agent;
  // Peut valoir « default » pour une session lancée avant son retrait (voir normalizeMode).
  mode: Mode;
  // null: model / effort Cerebro default, resolved by parseTuning.
  model: string | null;
  effort: Effort | null;
  prompt: string;
  title: string;
  status: Status;
  attention: boolean;
  protected: boolean;
  // Une seule par projet : ouvrir le projet redirige vers elle.
  pinned: boolean;
  attentionReason: string | null;
  agentSessionId: string | null;
  exitCode: number | null;
  createdAt: number;
  updatedAt: number;
  // Copie de travail isolée de la conversation ; null quand elle travaille dans le dossier du projet.
  worktree: SessionWorktree | null;
  // Origine conservée même après nettoyage du backlog.
  epic: SessionEpic | null;
  // Findings publiés qui n’ont pas encore été importés dans le backlog.
  pendingFindings: number;
}

export interface SessionEpic {
  id: string;
  title: string;
}

export interface SessionWorktree {
  name: string;
  path: string;
  branch: string | null;
  removed: boolean;
  removedAt: number | null;
  /** Removed by the automatic cleanup once the conversation was over. */
  removedAutomatically: boolean;
}

// Élément du backlog d'un projet : un texte à confier plus tard à une session.
export interface Task {
  id: string;
  projectId: string;
  text: string;
  status: TaskStatus;
  sessionId: string | null;
  sourceSessionId: string | null;
  // Tâches du même projet à terminer avant de pouvoir lancer celle-ci.
  dependsOn: string[];
  execution: TaskExecution;
  // Epic du même projet qui regroupe la tâche, ou null.
  epicId: string | null;
  createdAt: number;
  updatedAt: number;
}

// Regroupement de tâches liées à un même sujet, traitable d'un bloc par une seule session.
export interface Epic {
  id: string;
  projectId: string;
  title: string;
  description: string;
  sourceSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ModelChoice {
  value: string;
  label: string;
  description: string;
  efforts: Effort[];
}

// Catalogue découvert par le serveur ; `efforts` : ceux du modèle par défaut de l'agent.
export interface AgentInfo {
  agent: Agent;
  available: boolean;
  models: ModelChoice[];
  efforts: Effort[];
  // Model used when none is chosen; null when the server does not send one (older remote machines).
  defaultModel: string | null;
}

export interface GitInfo {
  // False only outside any Git work tree; `error` reports a repository whose state could not be read.
  repository: boolean;
  error?: string;
  branch: string | null;
  dirty: number;
  ahead: number | null;
  hasCommits: boolean;
  hasUpstream: boolean;
  pendingCommits?: {
    upstream: string;
    commits: { hash: string; subject: string; author: string }[];
    truncated: boolean;
  };
  pendingCommitsError?: string;
}

export type EventsMessage =
  // runEvents : l'instance diffuse epic-run et command-run (absent sur une instance antérieure).
  | { type: 'snapshot'; projects: Project[]; sessions: Session[]; tasks: Task[]; epics: Epic[]; runEvents: boolean }
  | { type: 'session'; session: Session }
  | { type: 'session-deleted'; id: string }
  | { type: 'task'; task: Task }
  | { type: 'task-deleted'; id: string }
  | { type: 'epic'; epic: Epic }
  | { type: 'epic-deleted'; id: string }
  | { type: 'projects'; projects: Project[] }
  | { type: 'alert'; session: Session }
  | { type: 'findings-available'; session: Session }
  | { type: 'peers' }
  | { type: 'slack-watches' }
  | { type: 'epic-run'; run: EpicRun }
  | { type: 'command-run'; run: Omit<CommandRun, 'output'> };

export type TermClientMessage = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };

export type TermServerMessage =
  | { type: 'snapshot'; data: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number | null }
  // Size of the shared PTY: every client renders at exactly this size, whatever its window.
  | { type: 'size'; cols: number; rows: number };

export function isAgent(v: unknown): v is Agent {
  return v === 'claude' || v === 'codex' || v === 'grok';
}

export function isMode(v: unknown): v is Mode {
  return (MODES as readonly unknown[]).includes(v);
}

export function isEffort(v: unknown): v is Effort {
  return (EFFORTS as readonly unknown[]).includes(v);
}

export function isStatus(v: unknown): v is Status {
  return v === 'starting' || v === 'running' || v === 'waiting' || v === 'idle' || v === 'exited';
}

function parseLlm(v: unknown): Llm | null {
  if (!isRecord(v) || !isAgent(v.agent)) return null;
  return {
    agent: v.agent,
    model: typeof v.model === 'string' ? v.model : null,
    effort: isEffort(v.effort) ? v.effort : null,
  };
}

// Modes known to this version, in their canonical order.
function modesOf<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  return Array.isArray(v) ? allowed.filter((mode) => v.includes(mode)) : [];
}

export function parseProjectSlackSettings(v: unknown): ProjectSlackSettings | null {
  if (!isRecord(v) || (v.mode !== 'off' && v.mode !== 'custom')) return null;
  const live = modesOf(v.watchDeliveryLive, WATCH_DELIVERIES);
  return {
    mode: v.mode,
    waiting: v.waiting === true,
    idle: v.idle === true,
    agentMessages: v.agentMessages === true,
    watchDeliveryLive: live.length > 0 ? live : ['inject'],
    watchDeliveryEnded: modesOf(v.watchDeliveryEnded, WATCH_ENDED_DELIVERIES),
  };
}

export function parseCouncilSettings(v: unknown): CouncilSettings | null {
  if (!isRecord(v) || !isRecord(v.assignments) || !Array.isArray(v.defaultPersonaIds)) return null;
  const chairman = parseLlm(v.chairman);
  if (chairman === null) return null;
  const assignments: Record<string, Llm> = {};
  for (const [personaId, raw] of Object.entries(v.assignments)) {
    const llm = parseLlm(raw);
    if (llm !== null) assignments[personaId] = llm;
  }
  const defaultPersonaIds = v.defaultPersonaIds.filter((id): id is string => typeof id === 'string');
  return { assignments, defaultPersonaIds, chairman, readProject: v.readProject !== false };
}

export function parsePersona(v: unknown): Persona | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const name = asString(v.name);
  const prompt = asString(v.prompt);
  if (id === null || name === null || prompt === null) return null;
  const createdAt = asNumber(v.createdAt) ?? 0;
  return {
    id,
    name,
    prompt,
    description: asString(v.description) ?? '',
    builtin: v.builtin === true,
    createdAt,
    updatedAt: asNumber(v.updatedAt) ?? createdAt,
  };
}

export function parsePersonaList(v: unknown): Persona[] {
  return parseItems(v, parsePersona);
}

const COUNCIL_STATUSES: readonly CouncilStatus[] = ['running', 'succeeded', 'failed', 'cancelled', 'interrupted'];
const COUNCIL_PHASES: readonly CouncilPhase[] = ['answering', 'reviewing', 'synthesizing', 'finished'];

function parseAdvisor(v: unknown): Advisor | null {
  if (!isRecord(v)) return null;
  const llm = parseLlm(v);
  const personaId = asString(v.personaId);
  const name = asString(v.name);
  if (llm === null || personaId === null || name === null) return null;
  return { ...llm, personaId, name, description: asString(v.description) ?? '', prompt: asString(v.prompt) ?? '' };
}

function parseCouncilAnswer(v: unknown): CouncilAnswer | null {
  if (!isRecord(v)) return null;
  const advisorId = asString(v.advisorId);
  if (advisorId === null) return null;
  return {
    advisorId,
    text: asString(v.text),
    error: asString(v.error),
    startedAt: asNumber(v.startedAt) ?? 0,
    finishedAt: asNumber(v.finishedAt),
  };
}

function parseCouncilReview(v: unknown): CouncilReview | null {
  if (!isRecord(v)) return null;
  const advisorId = asString(v.advisorId);
  if (advisorId === null) return null;
  const ranking = Array.isArray(v.ranking)
    ? v.ranking.flatMap((r) =>
        isRecord(r) && typeof r.letter === 'string' ? [{ letter: r.letter, reason: asString(r.reason) ?? '' }] : [],
      )
    : [];
  return {
    advisorId,
    ranking,
    blindSpot: asString(v.blindSpot),
    missed: asString(v.missed),
    error: asString(v.error),
    startedAt: asNumber(v.startedAt) ?? 0,
    finishedAt: asNumber(v.finishedAt),
  };
}

function parseCouncilImage(v: unknown): CouncilImage | null {
  if (!isRecord(v)) return null;
  const n = asNumber(v.n);
  const path = asString(v.path);
  return n === null || path === null ? null : { n, path };
}

function parseCouncilSynthesis(v: unknown): CouncilSynthesis | null {
  if (!isRecord(v)) return null;
  return {
    agreements: asString(v.agreements) ?? '',
    disagreements: asString(v.disagreements) ?? '',
    blindSpots: asString(v.blindSpots) ?? '',
    recommendation: asString(v.recommendation) ?? '',
    firstAction: asString(v.firstAction) ?? '',
  };
}

export function parseCouncilRun(v: unknown): CouncilRun | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const question = asString(v.question);
  const settings = parseCouncilSettings(v.settings);
  const status = COUNCIL_STATUSES.find((s) => s === v.status);
  const phase = COUNCIL_PHASES.find((p) => p === v.phase);
  const startedAt = asNumber(v.startedAt);
  if (
    id === null ||
    question === null ||
    settings === null ||
    status === undefined ||
    phase === undefined ||
    startedAt === null
  )
    return null;
  const letters: Record<string, string> = {};
  if (isRecord(v.letters)) {
    for (const [advisorId, letter] of Object.entries(v.letters))
      if (typeof letter === 'string') letters[advisorId] = letter;
  }
  return {
    id,
    projectId: asString(v.projectId),
    origin: v.origin === 'slack' ? 'slack' : 'web',
    question,
    context: asString(v.context) ?? '',
    images: parseItems(v.images, parseCouncilImage),
    readProject: v.readProject === true,
    settings,
    advisors: parseItems(v.advisors, parseAdvisor),
    status,
    phase,
    letters,
    answers: parseItems(v.answers, parseCouncilAnswer),
    reviews: parseItems(v.reviews, parseCouncilReview),
    synthesis: parseCouncilSynthesis(v.synthesis),
    error: asString(v.error),
    startedAt,
    finishedAt: asNumber(v.finishedAt),
  };
}

export function parseCouncilRunList(v: unknown): CouncilRun[] {
  return parseItems(v, parseCouncilRun);
}

export function parseProject(v: unknown): Project | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const name = asString(v.name);
  const path = asString(v.path);
  const createdAt = asNumber(v.createdAt);
  if (id === null || name === null || path === null || createdAt === null) return null;
  const color = typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color) ? v.color : null;
  // Compatibilité avec les machines qui ne mémorisent pas encore les réglages de lancement.
  const saved = isRecord(v.sessionDefaults) ? v.sessionDefaults : {};
  const sessionDefaults: SessionDefaults = {
    agent: isAgent(saved.agent) ? saved.agent : DEFAULT_SESSION_DEFAULTS.agent,
    mode: parseMode(saved.mode) ?? DEFAULT_SESSION_DEFAULTS.mode,
    model: typeof saved.model === 'string' ? saved.model : null,
    effort: isEffort(saved.effort) ? saved.effort : null,
    prompt: typeof saved.prompt === 'string' ? saved.prompt : '',
  };
  const commit = isRecord(v.commitSettings) ? v.commitSettings : {};
  const commitSettings: CommitSettings = {
    agent: isAgent(commit.agent) ? commit.agent : sessionDefaults.agent,
    model: typeof commit.model === 'string' ? commit.model : null,
    effort: isEffort(commit.effort) ? commit.effort : null,
    strategy: commit.strategy === 'atomic' ? 'atomic' : 'single',
  };
  // Absent des serveurs antérieurs à la résolution des fichiers par une session.
  const resolution = isRecord(v.resolutionSettings) ? v.resolutionSettings : {};
  const resolutionSettings: ResolutionSettings = {
    agent: isAgent(resolution.agent) ? resolution.agent : 'claude',
    mode: parseMode(resolution.mode) ?? 'auto',
    model: typeof resolution.model === 'string' ? resolution.model : null,
    effort: isEffort(resolution.effort) ? resolution.effort : null,
  };
  const workspaceMode: WorkspaceMode = v.workspaceMode === 'shared' ? 'shared' : 'isolated';
  const councilSettings = parseCouncilSettings(v.councilSettings);
  // Absent des serveurs antérieurs aux réglages Slack par projet.
  const slackSettings = parseProjectSlackSettings(v.slackSettings);
  // Absent des serveurs antérieurs aux chemins régénérables déclarés.
  const regenerablePaths = Array.isArray(v.regenerablePaths)
    ? v.regenerablePaths.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    id,
    name,
    path,
    color,
    sessionDefaults,
    commitSettings,
    resolutionSettings,
    councilSettings,
    slackSettings,
    workspaceMode,
    regenerablePaths,
    createdAt,
  };
}

export function parseSession(v: unknown): Session | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const projectId = asString(v.projectId);
  const title = asString(v.title);
  const prompt = asString(v.prompt);
  const createdAt = asNumber(v.createdAt);
  const updatedAt = asNumber(v.updatedAt);
  if (
    id === null ||
    projectId === null ||
    title === null ||
    prompt === null ||
    createdAt === null ||
    updatedAt === null ||
    !isAgent(v.agent) ||
    !isMode(v.mode) ||
    !isStatus(v.status) ||
    typeof v.attention !== 'boolean'
  ) {
    return null;
  }
  const attentionReason = asNullableString(v.attentionReason);
  const agentSessionId = asNullableString(v.agentSessionId);
  const exitCode = asNullableNumber(v.exitCode);
  if (attentionReason === undefined || agentSessionId === undefined || exitCode === undefined) {
    return null;
  }
  // Absents des serveurs antérieurs (machines distantes) : défaut de l'agent.
  const model = typeof v.model === 'string' ? v.model : null;
  const effort = isEffort(v.effort) ? v.effort : null;
  const worktree = parseSessionWorktree(v.worktree);
  return {
    id,
    projectId,
    agent: v.agent,
    mode: v.mode,
    model,
    effort,
    prompt,
    title,
    status: v.status,
    attention: v.attention,
    protected: v.protected === true,
    pinned: v.pinned === true,
    attentionReason,
    agentSessionId,
    exitCode,
    createdAt,
    updatedAt,
    worktree,
    // Serveurs antérieurs : le lien peut encore être retrouvé par les tâches.
    epic:
      isRecord(v.epic) && typeof v.epic.id === 'string' && typeof v.epic.title === 'string'
        ? { id: v.epic.id, title: v.epic.title }
        : null,
    pendingFindings:
      typeof v.pendingFindings === 'number' && Number.isSafeInteger(v.pendingFindings) && v.pendingFindings >= 0
        ? v.pendingFindings
        : 0,
  };
}

// Absent des serveurs antérieurs : la session s'affiche sans worktree.
function parseSessionWorktree(v: unknown): SessionWorktree | null {
  if (!isRecord(v)) return null;
  const name = asString(v.name);
  const path = asString(v.path);
  if (name === null || path === null) return null;
  return {
    name,
    path,
    branch: typeof v.branch === 'string' ? v.branch : null,
    removed: v.removed === true,
    removedAt: typeof v.removedAt === 'number' ? v.removedAt : null,
    removedAutomatically: v.removedAutomatically === true,
  };
}

export function parseTask(v: unknown): Task | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const projectId = asString(v.projectId);
  const text = asString(v.text);
  const createdAt = asNumber(v.createdAt);
  const updatedAt = asNumber(v.updatedAt);
  const sessionId = asNullableString(v.sessionId);
  const sourceSessionId = asNullableString(v.sourceSessionId);
  const dependsOn = Array.isArray(v.dependsOn) ? v.dependsOn.filter((d): d is string => typeof d === 'string') : [];
  // Serveur antérieur aux epics (machine distante) : aucune.
  const epicId = typeof v.epicId === 'string' ? v.epicId : null;
  if (
    id === null ||
    projectId === null ||
    text === null ||
    createdAt === null ||
    updatedAt === null ||
    sessionId === undefined ||
    sourceSessionId === undefined ||
    (v.status !== 'todo' && v.status !== 'started' && v.status !== 'done')
  ) {
    return null;
  }
  const execution: TaskExecution =
    isRecord(v.execution) && v.execution.type === 'command' && typeof v.execution.commandId === 'string'
      ? {
          type: 'command',
          commandId: v.execution.commandId,
          completion: v.execution.completion === 'exit-zero' ? 'exit-zero' : 'manual',
        }
      : { type: 'llm' };
  return {
    id,
    projectId,
    text,
    execution,
    status: v.status,
    sessionId,
    sourceSessionId,
    dependsOn,
    epicId,
    createdAt,
    updatedAt,
  };
}

export function parseEpic(v: unknown): Epic | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const projectId = asString(v.projectId);
  const title = asString(v.title);
  const description = typeof v.description === 'string' ? v.description : '';
  const sourceSessionId = asNullableString(v.sourceSessionId);
  const createdAt = asNumber(v.createdAt);
  const updatedAt = asNumber(v.updatedAt);
  if (
    id === null ||
    projectId === null ||
    title === null ||
    sourceSessionId === undefined ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  return { id, projectId, title, description, sourceSessionId, createdAt, updatedAt };
}

export function parseEpicList(v: unknown): Epic[] {
  return parseItems(v, parseEpic);
}

export function parseTaskList(v: unknown): Task[] {
  return parseItems(v, parseTask);
}

export function parseProjectList(v: unknown): Project[] {
  return parseItems(v, parseProject);
}

export function parseSessionList(v: unknown): Session[] {
  return parseItems(v, parseSession);
}

export function parseGitInfo(v: unknown): GitInfo | null {
  if (!isRecord(v)) return null;
  let branch: string | null;
  if (v.branch === null) branch = null;
  else if (typeof v.branch === 'string') branch = v.branch;
  else return null;
  if (typeof v.dirty !== 'number' || !Number.isFinite(v.dirty)) return null;
  let ahead: number | null;
  if (v.ahead === null) ahead = null;
  else if (typeof v.ahead === 'number' && Number.isFinite(v.ahead)) ahead = v.ahead;
  else return null;
  // Serveurs antérieurs : ne pas déduire de ahead=null qu'il y a des commits à publier.
  if (v.hasCommits !== undefined && typeof v.hasCommits !== 'boolean') return null;
  if (v.hasUpstream !== undefined && typeof v.hasUpstream !== 'boolean') return null;
  const hasCommits = v.hasCommits ?? ahead !== null;
  const hasUpstream = v.hasUpstream ?? ahead !== null;
  if (v.repository !== undefined && typeof v.repository !== 'boolean') return null;
  // Serveurs antérieurs : seul le dépôt absent renvoyait une branche nulle.
  const repository = v.repository ?? branch !== null;
  const error = typeof v.error === 'string' ? v.error : undefined;
  let pendingCommits: GitInfo['pendingCommits'];
  const preview = v.pendingCommits;
  if (
    isRecord(preview) &&
    typeof preview.upstream === 'string' &&
    typeof preview.truncated === 'boolean' &&
    Array.isArray(preview.commits)
  ) {
    const commits: NonNullable<GitInfo['pendingCommits']>['commits'] = [];
    for (const commit of preview.commits) {
      if (
        !isRecord(commit) ||
        typeof commit.hash !== 'string' ||
        typeof commit.subject !== 'string' ||
        typeof commit.author !== 'string'
      )
        return null;
      commits.push({ hash: commit.hash, subject: commit.subject, author: commit.author });
    }
    pendingCommits = { upstream: preview.upstream, truncated: preview.truncated, commits };
  }
  const pendingCommitsError = typeof v.pendingCommitsError === 'string' ? v.pendingCommitsError : undefined;
  return {
    repository,
    ...(error ? { error } : {}),
    branch,
    dirty: v.dirty,
    ahead,
    hasCommits,
    hasUpstream,
    ...(pendingCommits ? { pendingCommits } : {}),
    ...(pendingCommitsError ? { pendingCommitsError } : {}),
  };
}

// Raison affichée sur le bouton Push désactivé ; null quand un push peut aboutir.
// Une HEAD détachée n'a ni branche ni upstream, et startPush la refuse toujours.
export function pushBlockedReason(git: GitInfo): string | null {
  if (git.branch === null) return 'HEAD détachée : choisissez une branche pour pousser';
  return (git.ahead ?? 0) > 0 || (git.hasCommits && !git.hasUpstream) ? null : 'Rien à pousser';
}

export function parseScreenLines(v: unknown): string[] | null {
  if (!isRecord(v) || !Array.isArray(v.lines)) return null;
  const lines: string[] = [];
  for (const line of v.lines) {
    if (typeof line !== 'string') return null;
    lines.push(line);
  }
  return lines;
}

function parseEfforts(v: unknown): Effort[] {
  return Array.isArray(v) ? v.filter(isEffort) : [];
}

function parseModelChoices(v: unknown): ModelChoice[] {
  if (!Array.isArray(v)) return [];
  const out: ModelChoice[] = [];
  for (const item of v) {
    if (!isRecord(item) || typeof item.value !== 'string' || typeof item.label !== 'string') continue;
    const description = typeof item.description === 'string' ? item.description : '';
    out.push({ value: item.value, label: item.label, description, efforts: parseEfforts(item.efforts) });
  }
  return out;
}

export function parseAgentInfoList(v: unknown): AgentInfo[] {
  if (!Array.isArray(v)) return [];
  const out: AgentInfo[] = [];
  for (const item of v) {
    if (!isRecord(item) || !isAgent(item.agent) || typeof item.available !== 'boolean') continue;
    out.push({
      agent: item.agent,
      available: item.available,
      models: parseModelChoices(item.models),
      efforts: parseEfforts(item.efforts),
      defaultModel: typeof item.defaultModel === 'string' ? item.defaultModel : null,
    });
  }
  return out;
}

export function parseEventsMessage(v: unknown): EventsMessage | null {
  if (!isRecord(v) || typeof v.type !== 'string') return null;
  switch (v.type) {
    case 'snapshot':
      return {
        type: 'snapshot',
        projects: parseProjectList(v.projects),
        sessions: parseSessionList(v.sessions),
        tasks: parseTaskList(v.tasks),
        epics: parseEpicList(v.epics),
        runEvents: v.runEvents === true,
      };
    case 'session': {
      const session = parseSession(v.session);
      return session ? { type: 'session', session } : null;
    }
    case 'session-deleted': {
      const id = asString(v.id);
      return id ? { type: 'session-deleted', id } : null;
    }
    case 'task': {
      const task = parseTask(v.task);
      return task ? { type: 'task', task } : null;
    }
    case 'task-deleted': {
      const id = asString(v.id);
      return id ? { type: 'task-deleted', id } : null;
    }
    case 'epic': {
      const epic = parseEpic(v.epic);
      return epic ? { type: 'epic', epic } : null;
    }
    case 'epic-deleted': {
      const id = asString(v.id);
      return id ? { type: 'epic-deleted', id } : null;
    }
    case 'projects':
      return { type: 'projects', projects: parseProjectList(v.projects) };
    case 'alert':
    case 'findings-available': {
      const session = parseSession(v.session);
      return session ? { type: v.type, session } : null;
    }
    case 'peers':
      return { type: 'peers' };
    case 'slack-watches':
      return { type: 'slack-watches' };
    // Runs d'epic et de commande : le serveur et cette interface partagent leur type.
    case 'epic-run':
      return isRecord(v.run) &&
        typeof v.run.id === 'string' &&
        typeof v.run.epicId === 'string' &&
        typeof v.run.startedAt === 'number'
        ? { type: 'epic-run', run: v.run as unknown as EpicRun }
        : null;
    case 'command-run':
      return isRecord(v.run) &&
        typeof v.run.id === 'string' &&
        typeof v.run.taskId === 'string' &&
        typeof v.run.status === 'string'
        ? { type: 'command-run', run: v.run as unknown as Omit<CommandRun, 'output'> }
        : null;
    default:
      return null;
  }
}

export function parseTermServerMessage(v: unknown): TermServerMessage | null {
  if (!isRecord(v) || typeof v.type !== 'string') return null;
  if (v.type === 'snapshot' || v.type === 'output') {
    const data = asString(v.data);
    if (data === null) return null;
    return { type: v.type, data };
  }
  if (v.type === 'size') {
    const { cols, rows } = v;
    if (typeof cols !== 'number' || typeof rows !== 'number') return null;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
    return { type: 'size', cols, rows };
  }
  if (v.type === 'exit') {
    if (!('exitCode' in v) || v.exitCode === undefined) return { type: 'exit', exitCode: null };
    const exitCode = asNullableNumber(v.exitCode);
    if (exitCode === undefined) return { type: 'exit', exitCode: null };
    return { type: 'exit', exitCode };
  }
  return null;
}
