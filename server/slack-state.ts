import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WATCH_DELIVERIES, WATCH_ENDED_DELIVERIES, type SlackSettings, type WatchDelivery } from '../shared/machine.ts';
import type { ProjectSlackSettings } from '../shared/types.ts';
import { DATA_DIR, SLACK_ALERTS, SLACK_DELAY_MS } from './config.ts';
import type { CerebroDatabase } from './db.ts';
import type { AgentQuestion } from './questions.ts';
import { slackTimestampNow } from './slack-format.ts';
import { isRecord } from './util.ts';

export type { SlackSettings, WatchDelivery };

export type MessageKind = 'alert' | 'notify' | 'ask';

const SETTINGS_FILE = join(DATA_DIR, 'slack.json');
const STATE_FILE = join(DATA_DIR, 'slack-state.json');
const MAX_DELAY_SECONDS = 3_600;
// Below the 5 s poll, a shorter interval would not read more often anyway.
const WATCH_INTERVAL_SECONDS = { min: 5, max: 3_600 };
const WATCH_TTL_DAYS = { min: 1, max: 365 };
export const DAY_MS = 24 * 60 * 60 * 1_000;
export const THREAD_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function defaultSettings(): SlackSettings {
  const delaySeconds = SLACK_DELAY_MS / 1_000;
  return {
    waiting: SLACK_ALERTS !== 'off',
    idle: SLACK_ALERTS === 'all',
    agentMessages: true,
    delaySeconds: Number.isFinite(delaySeconds) && delaySeconds >= 0 ? delaySeconds : 30,
    watchDeliveryLive: ['inject'],
    watchDeliveryEnded: ['dm'],
    watchIntervalSec: 30,
    watchTtlDays: 7,
    watchIncludeSelf: false,
    watchAutoOnPost: true,
  };
}

function validDelay(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DELAY_SECONDS;
}

function validInteger(value: unknown, range: { min: number; max: number }): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;
}

/**
 * A subset of `allowed`, in its order and without repeats; null when the value is not an array of allowed
 * modes, or is empty while `allowEmpty` is false.
 */
export function deliveryModes<T extends string>(
  value: unknown,
  allowed: readonly T[],
  allowEmpty: boolean,
): T[] | null {
  if (!Array.isArray(value) || value.some((mode) => !allowed.includes(mode as T))) return null;
  if (value.length === 0 && !allowEmpty) return null;
  return allowed.filter((mode) => value.includes(mode));
}

// Applies the valid fields of an untrusted patch; returns null when a present field is invalid.
export function mergeSettings(base: SlackSettings, patch: Record<string, unknown>): SlackSettings | null {
  const next = { ...base };
  for (const key of ['waiting', 'idle', 'agentMessages', 'watchIncludeSelf', 'watchAutoOnPost'] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (typeof value !== 'boolean') return null;
    next[key] = value;
  }
  if ('delaySeconds' in patch) {
    if (!validDelay(patch.delaySeconds)) return null;
    next.delaySeconds = Math.round(patch.delaySeconds);
  }
  if ('watchDeliveryLive' in patch) {
    const modes = deliveryModes(patch.watchDeliveryLive, WATCH_DELIVERIES, false);
    if (modes === null) return null;
    next.watchDeliveryLive = modes;
  }
  if ('watchDeliveryEnded' in patch) {
    const modes = deliveryModes(patch.watchDeliveryEnded, WATCH_ENDED_DELIVERIES, true);
    if (modes === null) return null;
    next.watchDeliveryEnded = modes;
  }
  if ('watchIntervalSec' in patch) {
    if (!validInteger(patch.watchIntervalSec, WATCH_INTERVAL_SECONDS)) return null;
    next.watchIntervalSec = patch.watchIntervalSec;
  }
  if ('watchTtlDays' in patch) {
    if (!validInteger(patch.watchTtlDays, WATCH_TTL_DAYS)) return null;
    next.watchTtlDays = patch.watchTtlDays;
  }
  return next;
}

/** A project's Slack settings from an untrusted body; null when a field is missing or invalid. */
export function projectSlackSettingsFrom(value: unknown): ProjectSlackSettings | null {
  if (!isRecord(value) || (value.mode !== 'off' && value.mode !== 'custom')) return null;
  const { waiting, idle, agentMessages } = value;
  if (typeof waiting !== 'boolean' || typeof idle !== 'boolean' || typeof agentMessages !== 'boolean') return null;
  const watchDeliveryLive = deliveryModes(value.watchDeliveryLive, WATCH_DELIVERIES, false);
  const watchDeliveryEnded = deliveryModes(value.watchDeliveryEnded, WATCH_ENDED_DELIVERIES, true);
  if (watchDeliveryLive === null || watchDeliveryEnded === null) return null;
  return { mode: value.mode, waiting, idle, agentMessages, watchDeliveryLive, watchDeliveryEnded };
}

/**
 * The machine's settings as they apply to one project: its own posting choices replace the machine's, and `off`
 * posts nothing (watched messages are only typed into the session). Reading settings (interval, lifetime, own
 * messages, watch after a post) and the alert delay stay the machine's.
 */
export function projectSettings(machine: SlackSettings, own: ProjectSlackSettings | null): SlackSettings {
  if (own === null) return machine;
  if (own.mode === 'off')
    return {
      ...machine,
      waiting: false,
      idle: false,
      agentMessages: false,
      watchDeliveryLive: ['inject'],
      watchDeliveryEnded: [],
    };
  const { mode: _mode, ...posting } = own;
  return { ...machine, ...posting };
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

export function isSlackTimestamp(value: unknown): value is string {
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

/**
 * A Slack thread, or the top level of a channel, read for a session with the user token: messages posted there
 * by others are delivered to the session. Kept after the session ends, until it expires, so no reply is lost.
 */
export interface SlackWatch {
  id: string;
  sessionId: string;
  channel: string;
  // null: the top level of the channel.
  threadTs: string | null;
  // Latest message already read: only later ones are delivered.
  lastTs: string;
  createdAt: number;
  expiresAt: number;
  // Replaces the delivery settings for this watch.
  deliver?: WatchDelivery[];
  label?: string;
}

const WATCH_LABEL_MAX = 200;

export function slackWatchFrom(value: unknown): SlackWatch | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id === '' ||
    typeof value.sessionId !== 'string' ||
    value.sessionId === '' ||
    typeof value.channel !== 'string' ||
    value.channel === '' ||
    (value.threadTs !== null && !isSlackTimestamp(value.threadTs)) ||
    !isSlackTimestamp(value.lastTs) ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt)
  )
    return null;
  const deliver = value.deliver === undefined ? undefined : deliveryModes(value.deliver, WATCH_DELIVERIES, false);
  if (deliver === null) return null;
  if (value.label !== undefined && (typeof value.label !== 'string' || value.label.length > WATCH_LABEL_MAX))
    return null;
  return {
    id: value.id,
    sessionId: value.sessionId,
    channel: value.channel,
    threadTs: value.threadTs,
    lastTs: value.lastTs,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ...(deliver === undefined ? {} : { deliver }),
    ...(value.label === undefined || value.label === '' ? {} : { label: value.label }),
  };
}

// Channel, private group or DM ids: names are not resolved, a permalink gives the id.
const SLACK_CHANNEL_ID = /^[CDG][A-Z0-9]{2,}$/;

/** A watch asked by a session (`POST /api/slack-watch/:id`). */
export interface WatchRequest {
  channel: string;
  threadTs: string | null;
  label?: string;
  deliver?: WatchDelivery[];
  // Earlier start than now, to deliver messages already posted since.
  since?: string;
}

/** The watch asked in an untrusted body, or the reason it is invalid. */
export function watchRequestFrom(body: Record<string, unknown>): WatchRequest | string {
  if (typeof body.channel !== 'string' || !SLACK_CHANNEL_ID.test(body.channel))
    return 'Canal Slack invalide : identifiant attendu (C…, G… ou D…)';
  if (body.threadTs !== undefined && body.threadTs !== null && !isSlackTimestamp(body.threadTs))
    return 'threadTs invalide : horodatage Slack attendu (1700000000.000100)';
  if (body.since !== undefined && !isSlackTimestamp(body.since))
    return 'since invalide : horodatage Slack attendu (1700000000.000100)';
  if (body.label !== undefined && (typeof body.label !== 'string' || body.label.trim().length > WATCH_LABEL_MAX))
    return `Libellé invalide : ${WATCH_LABEL_MAX} caractères au plus`;
  const deliver = body.deliver === undefined ? undefined : deliveryModes(body.deliver, WATCH_DELIVERIES, false);
  if (deliver === null) return `deliver invalide : un ou plusieurs modes parmi ${WATCH_DELIVERIES.join(', ')}`;
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  return {
    channel: body.channel,
    threadTs: typeof body.threadTs === 'string' ? body.threadTs : null,
    ...(label === '' ? {} : { label }),
    ...(deliver === undefined ? {} : { deliver }),
    ...(typeof body.since === 'string' ? { since: body.since } : {}),
  };
}

/** A new watch, reading what is posted after `lastTs` (now by default) for `ttlDays`. */
export function newWatch(
  fields: Pick<SlackWatch, 'sessionId' | 'channel' | 'threadTs'> & Partial<SlackWatch>,
  ttlDays: number,
): SlackWatch {
  const now = Date.now();
  return {
    id: randomUUID().slice(0, 8),
    lastTs: slackTimestampNow(),
    createdAt: now,
    expiresAt: now + ttlDays * DAY_MS,
    ...fields,
  };
}

/** Session threads, watches and DM cursor, kept in a file so a restart resumes reading Slack where it stopped. */
export class SlackState {
  readonly threads = new Map<string, ActiveThread>();
  /** Watched threads and channels, by session id: several per session, unlike `threads`. */
  readonly watches = new Map<string, SlackWatch[]>();
  dmCursor = slackTimestampNow();
  /** While a poll runs, changes are only saved at its end. */
  polling = false;
  private dirty = false;
  private readonly logError: (error: unknown) => void;

  constructor(logError: (error: unknown) => void) {
    this.logError = logError;
  }

  /** Restores the saved state, except threads of sessions gone, exited or too old, and watches gone or expired. */
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
      if (isRecord(value.threads)) {
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
      } else if (value.threads !== undefined) {
        this.logError('état Slack invalide : fils ignorés');
      }
      this.loadWatches(value.watches, db);
    } catch (error) {
      this.logError(error);
    }
  }

  // Watches of an exited session are kept: they switch to the ended delivery until they expire.
  private loadWatches(value: unknown, db: CerebroDatabase): void {
    if (value === undefined) return;
    if (!isRecord(value)) {
      this.logError('état Slack invalide : surveillances ignorées');
      return;
    }
    const ids = new Set<string>();
    const now = Date.now();
    for (const [sessionId, rawWatches] of Object.entries(value)) {
      if (!Array.isArray(rawWatches)) {
        this.logError(`état Slack invalide : surveillances de ${sessionId} ignorées`);
        continue;
      }
      if (db.getSession(sessionId) === null) continue;
      const watches: SlackWatch[] = [];
      for (const rawWatch of rawWatches) {
        const watch = slackWatchFrom(rawWatch);
        if (watch === null || watch.sessionId !== sessionId || ids.has(watch.id)) {
          this.logError(`état Slack invalide : surveillance de ${sessionId} ignorée`);
          continue;
        }
        if (watch.expiresAt <= now) continue;
        ids.add(watch.id);
        watches.push(watch);
      }
      if (watches.length > 0) this.watches.set(sessionId, watches);
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
            watches: Object.fromEntries([...this.watches].filter(([, watches]) => watches.length > 0)),
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
