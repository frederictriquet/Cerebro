import { SLACK_API_URL, SLACK_ENABLED, SLACK_TOKEN, SLACK_USER } from './config.ts';
import { isRecord } from './util.ts';

export interface SlackResponse {
  ok?: boolean;
  error?: string;
  channel?: { id?: string } | string;
  ts?: string;
  messages?: unknown[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
}

export type SlackCall = (method: string, body: Record<string, unknown>) => Promise<SlackResponse>;

export function messageFrom(value: unknown): SlackMessage | null {
  if (!isRecord(value) || typeof value.ts !== 'string') return null;
  return {
    ts: value.ts,
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(typeof value.user === 'string' ? { user: value.user } : {}),
    ...(typeof value.bot_id === 'string' ? { bot_id: value.bot_id } : {}),
    ...(typeof value.subtype === 'string' ? { subtype: value.subtype } : {}),
    ...(typeof value.thread_ts === 'string' ? { thread_ts: value.thread_ts } : {}),
  };
}

// Slack 429 window: deferred sends retry once it is over, plus this margin.
const RATE_LIMIT_MARGIN_MS = 500;

/** Thrown while Slack asks to slow down: the caller may retry once `SlackTransport.rateLimitWait()` is over. */
export class SlackRateLimitError extends Error {}

/** Calls the Slack Web API, and stops calling it while Slack asks to slow down. */
export class SlackTransport {
  rateLimitedUntil = 0;

  rateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  /** Time left before a deferred send may retry. */
  rateLimitWait(): number {
    return Math.max(0, this.rateLimitedUntil - Date.now()) + RATE_LIMIT_MARGIN_MS;
  }

  async call(method: string, body: Record<string, unknown>): Promise<SlackResponse> {
    if (!SLACK_ENABLED || SLACK_TOKEN === undefined) throw new Error("Slack n'est pas configuré");
    if (this.rateLimited()) throw new SlackRateLimitError('Limite de débit Slack active');
    const response = await fetch(`${SLACK_API_URL}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SLACK_TOKEN}`,
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
