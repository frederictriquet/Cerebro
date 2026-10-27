import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SlackSettings } from '../shared/machine.ts';
import { DATA_DIR, SLACK_ALERTS, SLACK_DELAY_MS } from './config.ts';
import type { CerebroDatabase } from './db.ts';
import type { AgentQuestion } from './questions.ts';
import { slackTimestampNow } from './slack-format.ts';
import { isRecord } from './util.ts';

export type { SlackSettings };

export type MessageKind = 'alert' | 'notify' | 'ask';

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

/**
 * Notification preferences: read from disk on first use only, so a disabled Slack never touches the file. An
 * update applies at once; the file is written asynchronously, writes serialized and coalesced so a burst ends
 * with the last value on disk. A failed write restores the last persisted settings unless a newer update is
 * still queued.
 */
export class SlackSettingsStore {
  private loaded: SlackSettings | null = null;
  // Last value known to be on disk: restored when a write fails, so memory never outlives a failed save.
  private persisted: SlackSettings | null = null;
  // Settings waiting for the queued write; later updates replace them before it runs.
  private pending: SlackSettings | null = null;
  private write: Promise<void> = Promise.resolve();
  private readonly logError: (error: unknown) => void;

  constructor(logError: (error: unknown) => void) {
    this.logError = logError;
  }

  get current(): SlackSettings {
    if (this.loaded === null) this.loaded = this.persisted = loadSettings();
    return this.loaded;
  }

  update(patch: Record<string, unknown>): SlackSettings | null {
    const next = mergeSettings(this.current, patch);
    if (next === null) return null;
    this.loaded = next;
    this.queueWrite(next);
    return next;
  }

  /** Resolves once the latest settings are on disk; rejects if that write failed. */
  saved(): Promise<void> {
    return this.write;
  }

  private queueWrite(settings: SlackSettings): void {
    const queued = this.pending !== null;
    this.pending = settings;
    if (queued) return;
    const write = this.write
      .catch(() => undefined)
      .then(async () => {
        const value = this.pending;
        this.pending = null;
        if (value === null) return;
        try {
          await writeFile(SETTINGS_FILE, `${JSON.stringify(value, null, 2)}\n`);
          this.persisted = value;
        } catch (error) {
          if (this.pending === null && this.loaded === value) this.loaded = this.persisted;
          throw error;
        }
      });
    write.catch((error: unknown) => this.logError(error));
    this.write = write;
  }
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

/** A new session thread, with the defaults of a thread nothing was sent from yet. */
export function newThread(
  fields: Pick<ActiveThread, 'channel' | 'ts' | 'lastTs' | 'kind'> & Partial<ActiveThread>,
): ActiveThread {
  const now = Date.now();
  return {
    createdAt: now,
    polledAt: now,
    answered: false,
    awaitingReply: false,
    skipTurnEnd: false,
    moreTurns: false,
    questions: null,
    fromDm: false,
    ...fields,
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
