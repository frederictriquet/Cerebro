// Contracts about the machine itself, read by the web UI: version and remote machines, Slack, agent usage and updates.
import { array, boolean, isRecord, literal, nullable, number, object, parser, string, type Parser } from './parse.ts';
import { AGENTS, type Agent } from './types.ts';

export interface VersionInfo {
  version: string;
  commit: string | null;
}

/** same : même version ; compatible : version différente, même majeure ; unknown : instance trop ancienne ou injoignable. */
export type Compatibility = 'same' | 'compatible' | 'incompatible' | 'unknown';
export const COMPATIBILITIES: readonly Compatibility[] = ['same', 'compatible', 'incompatible', 'unknown'];

/** Version d'une machine de remotes.json, vue lors du dernier échange. */
export interface RemoteVersionStatus {
  version: VersionInfo | null;
  compatibility: Compatibility;
  reachable: boolean;
  error: string | null;
  checkedAt: number;
}

export interface MachinesInfo {
  local: { name: string; version: VersionInfo | null };
  // status null : pas encore d'échange avec cette machine.
  remotes: { id: string; name: string; status: RemoteVersionStatus | null }[];
}

/** Machine qui traite les commandes Slack générales, quand plusieurs machines lisent le même DM. */
export interface GeneralSlackStatus {
  // Au moins une autre machine active : sinon la question ne se pose pas.
  shared: boolean;
  owner: 'local' | 'remote';
  ownerMachine: string;
  // Choisie par l'utilisateur (sinon : plus petit identifiant parmi les machines actives).
  manual: boolean;
}

/** Prise de main Slack d'un projet présent sur plusieurs machines. */
export interface ProjectSlackStatus {
  shared: boolean;
  conflict: boolean;
  peerMachine: string | null;
  owner: 'local' | 'remote' | null;
  ownerMachine: string | null;
}

export interface PeerNotice {
  id: string;
  at: number;
  projectName: string;
  text: string;
}

// Notification preferences editable from the web UI; env variables only provide the defaults.
export interface SlackSettings {
  waiting: boolean;
  idle: boolean;
  agentMessages: boolean;
  delaySeconds: number;
}

export type SlackStatus = { enabled: boolean } & SlackSettings;

export interface UsageWindow {
  label: string;
  /** 0-100 */
  percent: number;
  /** Window length, to show how much of it has elapsed. */
  minutes: number | null;
  /** ISO date, null when unknown. */
  resetsAt: string | null;
}

/** When the CLI's login lapses, read from its credentials file (no token leaves the server). */
export interface AgentAuth {
  /** Date a new login will be required (ISO), when the CLI records it: only Claude does. */
  loginExpiresAt: string | null;
  /** Access token expiry (ISO): the CLI renews it by itself the next time it runs. */
  accessExpiresAt: string | null;
  /** Last login or token renewal (ISO), when known. */
  renewedAt: string | null;
  error: string | null;
}

export interface AgentUsage {
  agent: Agent;
  windows: UsageWindow[];
  auth: AgentAuth | null;
  /** When the figures were measured (ISO); for Codex, the last time it ran. */
  updatedAt: string | null;
  error: string | null;
}

export interface TokenCounts {
  /** All input, including cache reads and writes. Cache fields are subsets. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
}

export interface SessionTokenUsage {
  sessionId: string;
  tokens: TokenCounts | null;
  /** Global Grok logs can rotate independently of session history. */
  partial: boolean;
}

export interface AgentUpdate {
  agent: Agent;
  installed: string | null;
  latest: string | null;
  available: boolean;
  auto: boolean;
  updating: boolean;
  /** Last check (ISO). */
  checkedAt: string | null;
  /** Outcome of the last `<cli> update`, kept until the next one. */
  lastRun: { at: string; ok: boolean; output: string } | null;
  error: string | null;
}

/** Sub-folders of a folder of the machine, to pick a project path. */
export interface DirListing {
  path: string;
  parent: string | null;
  home: string;
  dirs: string[];
}

const MACHINE_ID = /^[a-z0-9-]{1,32}$/;

function parseVersionInfo(value: unknown): VersionInfo | null {
  if (!isRecord(value) || typeof value.version !== 'string') return null;
  return { version: value.version, commit: typeof value.commit === 'string' ? value.commit : null };
}

function parseRemoteVersionStatus(value: unknown): RemoteVersionStatus | null {
  if (!isRecord(value)) return null;
  const compatibility = COMPATIBILITIES.find((candidate) => candidate === value.compatibility);
  if (compatibility === undefined || typeof value.checkedAt !== 'number') return null;
  return {
    version: parseVersionInfo(value.version),
    compatibility,
    reachable: value.reachable === true,
    error: typeof value.error === 'string' ? value.error : null,
    checkedAt: value.checkedAt,
  };
}

// Instances antérieures : version et statut inconnus ; machines mal nommées ignorées.
export const parseMachinesInfo: Parser<MachinesInfo> = (value) => {
  if (
    !isRecord(value) ||
    !isRecord(value.local) ||
    typeof value.local.name !== 'string' ||
    !Array.isArray(value.remotes)
  )
    return null;
  const remotes: MachinesInfo['remotes'] = [];
  for (const remote of value.remotes) {
    if (!isRecord(remote) || typeof remote.id !== 'string' || typeof remote.name !== 'string') continue;
    if (remote.id === 'local' || !MACHINE_ID.test(remote.id)) continue;
    remotes.push({ id: remote.id, name: remote.name, status: parseRemoteVersionStatus(remote.status) });
  }
  return { local: { name: value.local.name, version: parseVersionInfo(value.local.version) }, remotes };
};

const agent = literal(...AGENTS);
const nullableString = nullable(string);

export const parseSlackStatus = parser(
  object<SlackStatus>({
    enabled: boolean,
    waiting: boolean,
    idle: boolean,
    agentMessages: boolean,
    delaySeconds: number,
  }),
);
export const parseGeneralSlackStatus = parser(
  object<GeneralSlackStatus>({
    shared: boolean,
    owner: literal('local', 'remote'),
    ownerMachine: string,
    manual: boolean,
  }),
);
export const parseProjectSlackStatus = parser(
  object<ProjectSlackStatus>({
    shared: boolean,
    conflict: boolean,
    peerMachine: nullableString,
    owner: nullable(literal('local', 'remote')),
    ownerMachine: nullableString,
  }),
);
export const parsePeerNotices = parser(
  array(object<PeerNotice>({ id: string, at: number, projectName: string, text: string })),
);

export const parseAgentUsages = parser(
  array(
    object<AgentUsage>({
      agent,
      windows: array(
        object<UsageWindow>({ label: string, percent: number, minutes: nullable(number), resetsAt: nullableString }),
      ),
      auth: nullable(
        object<AgentAuth>({
          loginExpiresAt: nullableString,
          accessExpiresAt: nullableString,
          renewedAt: nullableString,
          error: nullableString,
        }),
      ),
      updatedAt: nullableString,
      error: nullableString,
    }),
  ),
);

export const parseSessionTokenUsages = parser(
  array(
    object<SessionTokenUsage>({
      sessionId: string,
      tokens: nullable(
        object<TokenCounts>({
          inputTokens: number,
          outputTokens: number,
          cachedInputTokens: number,
          cacheWriteInputTokens: number,
        }),
      ),
      partial: boolean,
    }),
  ),
);

const agentUpdate = object<AgentUpdate>({
  agent,
  installed: nullableString,
  latest: nullableString,
  available: boolean,
  auto: boolean,
  updating: boolean,
  checkedAt: nullableString,
  lastRun: nullable(object<NonNullable<AgentUpdate['lastRun']>>({ at: string, ok: boolean, output: string })),
  error: nullableString,
});
export const parseAgentUpdate = parser(agentUpdate);
export const parseAgentUpdates = parser(array(agentUpdate));

export const parseDirListing = parser(
  object<DirListing>({ path: string, parent: nullableString, home: string, dirs: array(string) }),
);
