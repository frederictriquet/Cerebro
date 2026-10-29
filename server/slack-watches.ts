import type { WatchDelivery } from '../shared/machine.ts';
import { SLACK_USER } from './config.ts';
import type { CerebroDatabase } from './db.ts';
import type { SessionManager } from './sessions.ts';
import type { SlackClient, SlackMessage } from './slack-api.ts';
import { decodeSlackText, escapeMrkdwn } from './slack-format.ts';
import { readMessages, typeIntoSession } from './slack-polling.ts';
import type { SlackSettings, SlackState, SlackWatch } from './slack-state.ts';
import { isRecord } from './util.ts';

// Reads of the user token (history and replies pages) over a sliding minute: below Slack's Tier 3 limit, and
// apart from the bot's POLL_CALLS_PER_MINUTE, since each token has its own limits.
export const WATCH_CALLS_PER_MINUTE = 40;
const WATCH_WINDOW_MS = 60_000;
const MAX_WATCH_PAGES = 5;
// Kinds of messages someone wrote; joins, edits, deletions and the like are not delivered.
const DELIVERED_SUBTYPES = new Set(['bot_message', 'thread_broadcast', 'file_share', 'me_message']);
// Each message delivered is cut to this length: the permalink leads to the rest.
const MESSAGE_MAX_CHARS = 3_000;

/** Cerebro's own bot: its messages are never delivered back. */
export interface BotIdentity {
  userId: string | null;
  botId: string | null;
}

export interface WatchHooks {
  /** Posts the delivery of a watch in Slack with the bot token (`SlackAlerts.watchMessage`). */
  post: (sessionId: string, mode: 'dm' | 'notify', text: string) => Promise<void>;
  /** Cerebro's bot, or null without a bot token. */
  cerebroBot: () => Promise<BotIdentity | null>;
  /** False when the session's project posts nothing to Slack: its watches' own delivery is ignored too. */
  posting: (sessionId: string) => boolean;
}

interface WatchedMessage {
  watch: SlackWatch;
  message: SlackMessage;
  author: string;
  permalink: string | null;
}

// A message waiting to be typed into its session, and the modes it already went through.
interface PendingInjection {
  item: WatchedMessage;
  done: WatchDelivery[];
}

function truncated(text: string): string {
  return text.length > MESSAGE_MAX_CHARS ? `${text.slice(0, MESSAGE_MAX_CHARS)}…` : text;
}

function place(watch: SlackWatch): string {
  const thread = watch.threadTs === null ? '' : ` · thread ${watch.threadTs}`;
  const label = watch.label === undefined ? '' : ` · ${watch.label}`;
  return `#${watch.channel}${thread}${label}`;
}

/** Plain text typed into the session: one line per message, followed by its permalink. */
export function injectionText(items: WatchedMessage[]): string {
  return items
    .map(({ watch, message, author, permalink }) => {
      const text = truncated(decodeSlackText(message.text ?? '').trim() || '(message sans texte)').replaceAll('\r', '');
      return `[Slack ${place(watch)}] ${author} : ${text}${permalink === null ? '' : `\n${permalink}`}`;
    })
    .join('\n');
}

/** Slack mrkdwn posted with the bot: the message quoted under its author and place. */
function slackText(items: WatchedMessage[]): string {
  return items
    .map(({ watch, message, author, permalink }) => {
      const quoted = truncated(message.text?.trim() || '_(message sans texte)_')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      const link = permalink === null ? '' : ` · <${permalink}|Voir dans Slack>`;
      return `*${escapeMrkdwn(author)}* dans ${escapeMrkdwn(place(watch))}${link}\n${quoted}`;
    })
    .join('\n\n');
}

/**
 * Reads the Slack threads and channels watched for sessions, with the user token and no model, and delivers what
 * others post there: typed into the session while it runs, posted in the DM or as a notification, as configured.
 * A watch outlives its session, delivered as configured for ended sessions, until it expires.
 */
export class SlackWatcher {
  private readonly reader: SlackClient;
  private readonly state: SlackState;
  private readonly db: CerebroDatabase;
  private readonly sessions: SessionManager;
  // The machine's Slack settings, or (with a session) as they apply to its project.
  private readonly settings: (sessionId?: string) => SlackSettings;
  private readonly rateLimited: () => boolean;
  private readonly hooks: WatchHooks;
  private readonly reads: number[] = [];
  // Last read of each watch, by id: a restart reads them all once.
  private readonly polledAt = new Map<string, number>();
  private readonly authors = new Map<string, string>();
  // By session: messages to type once its question or permission dialog is closed.
  private readonly pending = new Map<string, PendingInjection[]>();
  private running = false;

  constructor(
    reader: SlackClient,
    state: SlackState,
    db: CerebroDatabase,
    sessions: SessionManager,
    settings: (sessionId?: string) => SlackSettings,
    rateLimited: () => boolean,
    hooks: WatchHooks,
  ) {
    this.reader = reader;
    this.state = state;
    this.db = db;
    this.sessions = sessions;
    this.settings = settings;
    this.rateLimited = rateLimited;
    this.hooks = hooks;
  }

  async poll(): Promise<void> {
    if (this.reader.stopped || this.running) return;
    this.running = true;
    let changed = false;
    try {
      changed = this.dropExpired();
      await this.flushPending();
      if (this.rateLimited()) return;
      const now = Date.now();
      const interval = this.settings().watchIntervalSec * 1_000;
      const due = [...this.state.watches.values()]
        .flat()
        .filter((watch) => now - (this.polledAt.get(watch.id) ?? -Infinity) >= interval)
        // Round robin: the least recently read watches use the budget first.
        .sort((left, right) => (this.polledAt.get(left.id) ?? -Infinity) - (this.polledAt.get(right.id) ?? -Infinity));
      if (due.length === 0) return;
      const bot = await this.hooks.cerebroBot();
      const received = new Map<string, WatchedMessage[]>();
      for (const watch of due) {
        if (this.reader.stopped || this.rateLimited() || !this.takeRead()) break;
        this.polledAt.set(watch.id, Date.now());
        try {
          const before = watch.lastTs;
          const items = await this.read(watch, bot);
          if (watch.lastTs !== before) changed = true;
          if (items.length > 0) received.set(watch.sessionId, [...(received.get(watch.sessionId) ?? []), ...items]);
        } catch (error) {
          this.reader.logError(error);
        }
      }
      // Messages of one cycle reach a session together: a single injection, a single post per mode.
      for (const [sessionId, items] of received) {
        try {
          await this.deliver(sessionId, items);
        } catch (error) {
          this.reader.logError(error);
        }
      }
    } catch (error) {
      this.reader.logError(error);
    } finally {
      if (changed) this.state.changed();
      this.running = false;
    }
  }

  /** Reserves one read in the user token's budget; false once the minute's share is spent. */
  takeRead(): boolean {
    const now = Date.now();
    while (this.reads.length > 0 && now - this.reads[0] >= WATCH_WINDOW_MS) this.reads.shift();
    if (this.reads.length >= WATCH_CALLS_PER_MINUTE) return false;
    this.reads.push(now);
    return true;
  }

  /** Drops expired watches and those of deleted sessions; true when one was dropped. */
  private dropExpired(): boolean {
    let dropped = false;
    const now = Date.now();
    for (const [sessionId, watches] of [...this.state.watches]) {
      const kept = this.db.getSession(sessionId) === null ? [] : watches.filter((watch) => watch.expiresAt > now);
      if (kept.length === watches.length) continue;
      dropped = true;
      for (const watch of watches) if (!kept.includes(watch)) this.polledAt.delete(watch.id);
      if (kept.length === 0) this.state.watches.delete(sessionId);
      else this.state.watches.set(sessionId, kept);
    }
    for (const sessionId of [...this.pending.keys()]) {
      if (this.db.getSession(sessionId) === null) this.pending.delete(sessionId);
    }
    return dropped;
  }

  private watched(watch: SlackWatch): boolean {
    return this.state.watches.get(watch.sessionId)?.includes(watch) === true;
  }

  /** New messages of a watch from others; its cursor moves past every message read, delivered or not. */
  private async read(watch: SlackWatch, bot: BotIdentity | null): Promise<WatchedMessage[]> {
    const topLevel = watch.threadTs === null;
    // Replies pages run forwards in time, history pages backwards: an unread rest of replies comes next time.
    const { messages, complete } = await readMessages(
      this.reader,
      topLevel ? 'conversations.history' : 'conversations.replies',
      topLevel
        ? { channel: watch.channel, oldest: watch.lastTs }
        : { channel: watch.channel, ts: watch.threadTs, oldest: watch.lastTs },
      watch.lastTs,
      (pages) => pages < MAX_WATCH_PAGES && this.takeRead(),
    );
    if (topLevel && !complete)
      this.reader.logError(
        new Error(
          `Canal Slack ${watch.channel} : plus de ${MAX_WATCH_PAGES} pages de nouveaux messages, les plus anciens sont ignorés`,
        ),
      );
    const items: WatchedMessage[] = [];
    for (const message of messages) {
      if (!this.watched(watch)) return [];
      watch.lastTs = message.ts;
      // Top level of a channel: thread replies belong to their threads.
      if (topLevel && message.thread_ts !== undefined && message.thread_ts !== message.ts) continue;
      if (!this.wanted(message, bot)) continue;
      items.push({
        watch,
        message,
        author: await this.author(message),
        permalink: await this.permalink(watch.channel, message.ts),
      });
    }
    return items;
  }

  /** Messages of others, bots included; not the user's own posts (their sessions' ones) nor Cerebro's bot. */
  private wanted(message: SlackMessage, bot: BotIdentity | null): boolean {
    if (message.subtype !== undefined && !DELIVERED_SUBTYPES.has(message.subtype)) return false;
    if (bot !== null) {
      if (bot.botId !== null && message.bot_id === bot.botId) return false;
      if (bot.userId !== null && message.user === bot.userId) return false;
    }
    if (message.bot_id === undefined && message.user === SLACK_USER && !this.settings().watchIncludeSelf) return false;
    return true;
  }

  private async author(message: SlackMessage): Promise<string> {
    if (message.botName !== undefined) return message.botName;
    const userId = message.user;
    if (userId === undefined) return 'Inconnu';
    const known = this.authors.get(userId);
    if (known !== undefined) return known;
    // During a 429 window, the id stands in for the name rather than extending the window.
    if (this.rateLimited()) return userId;
    try {
      const response = await this.reader.call('users.info', { user: userId });
      const user = isRecord(response.user) ? response.user : {};
      const profile = isRecord(user.profile) ? user.profile : {};
      const name = [profile.display_name, profile.real_name, user.real_name, user.name].find(
        (value): value is string => typeof value === 'string' && value.trim() !== '',
      );
      if (name === undefined) return userId;
      this.authors.set(userId, name);
      return name;
    } catch (error) {
      this.reader.logError(error);
      return userId;
    }
  }

  private async permalink(channel: string, ts: string): Promise<string | null> {
    if (this.rateLimited()) return null;
    try {
      const response = await this.reader.call('chat.getPermalink', { channel, message_ts: ts });
      return typeof response.permalink === 'string' ? response.permalink : null;
    } catch (error) {
      this.reader.logError(error);
      return null;
    }
  }

  private async deliver(sessionId: string, items: WatchedMessage[]): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (session === null) return;
    const settings = this.settings(sessionId);
    const posting = this.hooks.posting(sessionId);
    const live = session.status !== 'exited';
    const byMode = new Map<WatchDelivery, WatchedMessage[]>();
    for (const item of items) {
      const modes: readonly WatchDelivery[] = live
        ? ((posting ? item.watch.deliver : undefined) ?? settings.watchDeliveryLive)
        : settings.watchDeliveryEnded;
      for (const mode of modes) byMode.set(mode, [...(byMode.get(mode) ?? []), item]);
    }
    for (const mode of ['dm', 'notify'] as const) {
      const posted = byMode.get(mode);
      if (posted !== undefined) this.post(sessionId, mode, posted);
    }
    const injected = byMode.get('inject');
    if (injected === undefined) return;
    const queue = this.pending.get(sessionId) ?? [];
    for (const item of injected) {
      const done = (['dm', 'notify'] as const).filter((mode) => byMode.get(mode)?.includes(item) === true);
      queue.push({ item, done });
    }
    this.pending.set(sessionId, queue);
    await this.flush(sessionId);
  }

  // Posted in the background: a Slack 429 window delays the post, not the next reads.
  private post(sessionId: string, mode: 'dm' | 'notify', items: WatchedMessage[]): void {
    void this.hooks.post(sessionId, mode, slackText(items)).catch((error: unknown) => this.reader.logError(error));
  }

  private async flushPending(): Promise<void> {
    for (const sessionId of [...this.pending.keys()]) {
      try {
        await this.flush(sessionId);
      } catch (error) {
        this.reader.logError(error);
      }
    }
  }

  /**
   * Types the session's pending messages as one prompt; while the session runs, the agent queues it for after its
   * turn. A dialog waiting for an answer is never dismissed for them: they wait for it to close. Once the session
   * has ended, or if typing fails, they go through the ended delivery instead.
   */
  private async flush(sessionId: string): Promise<void> {
    const queue = this.pending.get(sessionId);
    if (queue === undefined || queue.length === 0) {
      this.pending.delete(sessionId);
      return;
    }
    const status = this.db.getSession(sessionId)?.status;
    if (status === undefined) {
      this.pending.delete(sessionId);
      return;
    }
    if (status === 'starting' || status === 'waiting') return;
    this.pending.delete(sessionId);
    if (
      status !== 'exited' &&
      (await typeIntoSession(this.sessions, sessionId, injectionText(queue.map(({ item }) => item))))
    )
      return;
    for (const mode of this.settings(sessionId).watchDeliveryEnded) {
      const items = queue.filter(({ done }) => !done.includes(mode)).map(({ item }) => item);
      if (items.length > 0) this.post(sessionId, mode, items);
    }
  }
}
