import {
  SLACK_API_URL,
  SLACK_ENABLED,
  SLACK_TOKEN,
  SLACK_USER,
  SLACK_USER_TOKEN,
  SLACK_WATCH_UNCONFIGURED,
} from './config.ts';
import { isRecord } from './util.ts';

export interface SlackResponse {
  ok?: boolean;
  error?: string;
  channel?: { id?: string } | string;
  ts?: string;
  messages?: unknown[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
  // users.info
  user?: unknown;
  // chat.getPermalink
  permalink?: string;
}

export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  // Display name of a bot author (bot_profile.name, or username of legacy bot messages).
  botName?: string;
  // Posted by an app on the user's behalf (the claude.ai connector: `app_id`, or its « Envoyé avec @Claude »
  // context block on scheduled messages), not typed by them in Slack.
  viaApp?: true;
}

// Slack clients send rich_text blocks only; a context block comes from an app.
function postedByApp(value: Record<string, unknown>): boolean {
  if (typeof value.app_id === 'string') return true;
  return Array.isArray(value.blocks) && value.blocks.some((block) => isRecord(block) && block.type === 'context');
}

export type SlackCall = (method: string, body: Record<string, unknown>) => Promise<SlackResponse>;

export function messageFrom(value: unknown): SlackMessage | null {
  if (!isRecord(value) || typeof value.ts !== 'string') return null;
  const profileName = isRecord(value.bot_profile) ? value.bot_profile.name : undefined;
  const botName =
    typeof profileName === 'string' && profileName !== ''
      ? profileName
      : typeof value.username === 'string' && value.username !== ''
        ? value.username
        : undefined;
  return {
    ts: value.ts,
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(typeof value.user === 'string' ? { user: value.user } : {}),
    ...(typeof value.bot_id === 'string' ? { bot_id: value.bot_id } : {}),
    ...(typeof value.subtype === 'string' ? { subtype: value.subtype } : {}),
    ...(typeof value.thread_ts === 'string' ? { thread_ts: value.thread_ts } : {}),
    ...(botName === undefined ? {} : { botName }),
    ...(postedByApp(value) ? { viaApp: true as const } : {}),
  };
}

// Slack 429 window: deferred sends retry once it is over, plus this margin.
const RATE_LIMIT_MARGIN_MS = 500;

/** Thrown while Slack asks to slow down: the caller may retry once `SlackTransport.rateLimitWait()` is over. */
export class SlackRateLimitError extends Error {}

/** Methods the user token may call: it reads what the user sees and never acts on their behalf. */
export const SLACK_USER_READ_METHODS: ReadonlySet<string> = new Set([
  'conversations.replies',
  'conversations.history',
  'users.info',
  'chat.getPermalink',
]);

interface TransportOptions {
  /** Error message while no token is configured. */
  unconfigured: string;
  /** When set, any other method is refused before reaching Slack. */
  methods?: ReadonlySet<string>;
}

/**
 * Calls the Slack Web API, and stops calling it while Slack asks to slow down. Built with the bot token by
 * default; each token gets its own transport, so its 429 window only pauses its own calls.
 */
export class SlackTransport {
  rateLimitedUntil = 0;
  private readonly token: string | undefined;
  private readonly options: TransportOptions;

  constructor(
    token: string | undefined = SLACK_ENABLED ? SLACK_TOKEN : undefined,
    options: TransportOptions = { unconfigured: "Slack n'est pas configuré" },
  ) {
    this.token = token;
    this.options = options;
  }

  rateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  /** Time left before a deferred send may retry. */
  rateLimitWait(): number {
    return Math.max(0, this.rateLimitedUntil - Date.now()) + RATE_LIMIT_MARGIN_MS;
  }

  async call(method: string, body: Record<string, unknown>): Promise<SlackResponse> {
    if (this.token === undefined) throw new Error(this.options.unconfigured);
    if (this.options.methods !== undefined && !this.options.methods.has(method)) {
      throw new Error(`Méthode Slack non autorisée pour ce jeton : ${method}`);
    }
    if (this.rateLimited()) throw new SlackRateLimitError('Limite de débit Slack active');
    const response = await fetch(`${SLACK_API_URL}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        // Form encoding: read methods such as conversations.replies ignore JSON bodies.
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after') ?? 1);
      this.rateLimitedUntil = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1_000;
      throw new SlackRateLimitError('Limite de débit Slack atteinte');
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error(`Réponse Slack invalide (HTTP ${response.status})`);
    }
    if (!isRecord(value)) throw new Error('Réponse Slack invalide');
    const result = value as SlackResponse;
    if (!response.ok || result.ok !== true) {
      throw new Error(typeof result.error === 'string' ? result.error : `Erreur Slack HTTP ${response.status}`);
    }
    return result;
  }
}

/**
 * What every Slack module shares: API calls, the DM with the user, ordered sends and error logging. `call` and
 * `logError` are given by the notifier, which keeps them replaceable.
 */
export class SlackClient {
  readonly call: SlackCall;
  readonly logError: (error: unknown) => void;
  /** Set when the server stops: pending work posts nothing more. */
  stopped = false;
  private dmChannel: string | null = null;
  private dmChannelPromise: Promise<string> | null = null;
  private outgoing = new Map<string, Promise<void>>();

  constructor(call: SlackCall, logError: (error: unknown) => void) {
    this.call = call;
    this.logError = logError;
  }

  async openDm(): Promise<string> {
    if (this.dmChannel !== null) return this.dmChannel;
    if (this.dmChannelPromise !== null) return this.dmChannelPromise;
    this.dmChannelPromise = (async () => {
      const response = await this.call('conversations.open', { users: SLACK_USER });
      if (!isRecord(response.channel) || typeof response.channel.id !== 'string') {
        throw new Error('Réponse conversations.open sans canal');
      }
      this.dmChannel = response.channel.id;
      return this.dmChannel;
    })();
    try {
      return await this.dmChannelPromise;
    } finally {
      this.dmChannelPromise = null;
    }
  }

  async postToDm(text: string): Promise<void> {
    await this.call('chat.postMessage', { channel: await this.openDm(), text, unfurl_links: false });
  }

  async postThreadReply(channel: string, threadTs: string, text: string): Promise<void> {
    await this.call('chat.postMessage', {
      channel,
      thread_ts: threadTs,
      text,
      unfurl_links: false,
    });
  }

  /** Marks a forwarded message as transmitted. */
  async acknowledge(channel: string, timestamp: string): Promise<void> {
    await this.call('reactions.add', { channel, timestamp, name: 'white_check_mark' }).catch((error: unknown) =>
      this.logError(error),
    );
  }

  /** Sends for one id run one after another, each after the previous one settled. */
  serial(id: string, send: () => Promise<void>): Promise<void> {
    const previous = this.outgoing.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(send);
    this.outgoing.set(id, next);
    void next
      .finally(() => {
        if (this.outgoing.get(id) === next) this.outgoing.delete(id);
      })
      .catch(() => {});
    return next;
  }
}

/** Transport of the user token (CEREBRO_SLACK_USER_TOKEN), restricted to SLACK_USER_READ_METHODS. */
export function slackUserTransport(token: string | undefined = SLACK_USER_TOKEN): SlackTransport {
  return new SlackTransport(token, { unconfigured: SLACK_WATCH_UNCONFIGURED, methods: SLACK_USER_READ_METHODS });
}
