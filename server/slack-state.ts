import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, SLACK_ALERTS, SLACK_DELAY_MS } from './config.ts';
import type { CerebroDatabase } from './db.ts';
import type { AgentQuestion } from './questions.ts';
import { isRecord } from './slack-api.ts';
import { slackTimestampNow } from './slack-format.ts';

export type MessageKind = 'alert' | 'notify' | 'ask';

// Notification preferences editable from the web UI; env variables only provide the defaults.
export interface SlackSettings {
  waiting: boolean;
  idle: boolean;
  agentMessages: boolean;
  delaySeconds: number;
}

const SETTINGS_FILE = join(DATA_DIR, 'slack.json');
const STATE_FILE = join(DATA_DIR, 'slack-state.json');
const MAX_DELAY_SECONDS = 3_600;
export const THREAD_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function defaultSettings(): SlackSettings {
  const delaySeconds = SLACK_DELAY_MS / 1_000;
  return {
    waiting: SLACK_ALERTS !== 'off',
    idle: SLACK_ALERTS === 'all',
    agentMessages: true,
    delaySeconds: Number.isFinite(delaySeconds) && delaySeconds >= 0 ? delaySeconds : 30,
  };
}

function validDelay(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DELAY_SECONDS;
}

// Applies the valid fields of an untrusted patch; returns null when a present field is invalid.
export function mergeSettings(base: SlackSettings, patch: Record<string, unknown>): SlackSettings | null {
  const next = { ...base };
  for (const key of ['waiting', 'idle', 'agentMessages'] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (typeof value !== 'boolean') return null;
    next[key] = value;
  }
  if ('delaySeconds' in patch) {
    if (!validDelay(patch.delaySeconds)) return null;
    next.delaySeconds = Math.round(patch.delaySeconds);
  }
  return next;
}

export function loadSettings(): SlackSettings {
  const defaults = defaultSettings();
  if (!existsSync(SETTINGS_FILE)) return defaults;
  try {
    const value: unknown = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    if (!isRecord(value)) return defaults;
    // Ignore individually invalid fields rather than the whole file.
    let settings = defaults;
    for (const [key, field] of Object.entries(value)) {
      settings = mergeSettings(settings, { [key]: field }) ?? settings;
    }
    return settings;
  } catch (error) {
    console.error('[slack] réglages illisibles :', error instanceof Error ? error.message : error);
    return defaults;
  }
}

export function saveSettings(settings: SlackSettings): void {
  writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

export interface ActiveThread {
  channel: string;
  ts: string;
  lastTs: string;
  kind: MessageKind;
  createdAt: number;
  polledAt: number;
  answered: boolean;
  // A message was sent from this thread: the end of the agent's turn is posted back into it.
  awaitingReply: boolean;
  // The message was queued behind a running turn unrelated to Slack: that turn's end is not the reply.
  skipTurnEnd: boolean;
  // Another message was queued while a reply was awaited: keep awaiting after relaying the next turn end.
  moreTurns: boolean;
  // Questions of the AskUserQuestion dialog this message shows: numeric replies are mapped onto them.
  questions: AgentQuestion[] | null;
  // Thread of a DM command: dropped when another machine takes the project over.
  fromDm: boolean;
}

function isAgentQuestion(value: unknown): value is AgentQuestion {
  if (!isRecord(value) || typeof value.question !== 'string') return false;
  if (value.header !== null && typeof value.header !== 'string') return false;
  if (typeof value.multiSelect !== 'boolean' || !Array.isArray(value.options)) return false;
  return value.options.every(
    (option) =>
      isRecord(option) &&
      typeof option.label === 'string' &&
      (option.description === null || typeof option.description === 'string') &&
      (option.preview === null || typeof option.preview === 'string'),
  );
}

function isSlackTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
}

function activeThreadFrom(value: unknown): ActiveThread | null {
  if (
    !isRecord(value) ||
    typeof value.channel !== 'string' ||
    value.channel === '' ||
    !isSlackTimestamp(value.ts) ||
    !isSlackTimestamp(value.lastTs) ||
    !['alert', 'notify', 'ask'].includes(typeof value.kind === 'string' ? value.kind : '') ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    typeof value.polledAt !== 'number' ||
    !Number.isFinite(value.polledAt) ||
    typeof value.answered !== 'boolean'
  )
    return null;
  const questions = value.questions === undefined ? null : value.questions;
  if (questions !== null && (!Array.isArray(questions) || !questions.every(isAgentQuestion))) return null;
  return {
    channel: value.channel,
    ts: value.ts,
    lastTs: value.lastTs,
    kind: value.kind as MessageKind,
    createdAt: value.createdAt,
    polledAt: value.polledAt,
    answered: value.answered,
    awaitingReply: value.awaitingReply === true,
    skipTurnEnd: value.skipTurnEnd === true,
    moreTurns: value.moreTurns === true,
    questions,
    fromDm: value.fromDm === true,
  };
}

/** A message typed during a running turn is queued: only the turn it starts carries the reply. */
export function armReply(thread: ActiveThread, queued: boolean): void {
  if (!queued) {
    thread.awaitingReply = true;
    thread.skipTurnEnd = false;
    thread.moreTurns = false;
  } else if (!thread.awaitingReply) {
    thread.awaitingReply = true;
    thread.skipTurnEnd = true;
  } else if (!thread.skipTurnEnd) {
    thread.moreTurns = true;
  }
}

/** Session threads and DM cursor, kept in a file so a restart resumes reading Slack where it stopped. */
export class SlackState {
  readonly threads = new Map<string, ActiveThread>();
  dmCursor = slackTimestampNow();
  /** While a poll runs, changes are only saved at its end. */
  polling = false;
  private dirty = false;
  private readonly logError: (error: unknown) => void;

  constructor(logError: (error: unknown) => void) {
    this.logError = logError;
  }

  /** Restores the saved state, except threads of sessions gone, exited or too old. */
  load(db: CerebroDatabase): void {
    if (!existsSync(STATE_FILE)) return;
    try {
      const value: unknown = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      if (!isRecord(value)) {
        this.logError('état Slack invalide : objet attendu');
        return;
      }
      if (isSlackTimestamp(value.dmCursor)) {
        this.dmCursor = value.dmCursor;
      } else {
        this.logError('état Slack invalide : curseur DM ignoré');
      }
      if (!isRecord(value.threads)) {
        if (value.threads !== undefined) this.logError('état Slack invalide : fils ignorés');
        return;
      }
      for (const [sessionId, rawThread] of Object.entries(value.threads)) {
        const thread = activeThreadFrom(rawThread);
        if (thread === null) {
          this.logError(`état Slack invalide : fil ${sessionId} ignoré`);
          continue;
        }
        const session = db.getSession(sessionId);
        if (session === null || session.status === 'exited' || Date.now() - thread.createdAt >= THREAD_MAX_AGE_MS)
          continue;
        this.threads.set(sessionId, thread);
      }
    } catch (error) {
      this.logError(error);
    }
  }

  /** The state changed: saved at the end of the running poll, if any. */
  markDirty(): void {
    this.dirty = true;
  }

  /** The state changed: saved at once, unless a poll is running. */
  changed(): void {
    this.dirty = true;
    if (!this.polling) this.save();
  }

  save(): void {
    if (!this.dirty) return;
    try {
      writeFileSync(
        STATE_FILE,
        `${JSON.stringify(
          {
            dmCursor: this.dmCursor,
            threads: Object.fromEntries(this.threads),
          },
          null,
          2,
        )}\n`,
      );
      this.dirty = false;
    } catch (error) {
      this.logError(error);
    }
  }
}
