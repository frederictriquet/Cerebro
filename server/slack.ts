import {
  PUBLIC_URL,
  SLACK_ALERTS,
  SLACK_API_URL,
  SLACK_DELAY_MS,
  SLACK_ENABLED,
  SLACK_TOKEN,
  SLACK_USER,
} from './config.ts';
import type { CerebroDatabase, Session } from './db.ts';
import type { SessionEvent, SessionManager } from './sessions.ts';

type MessageKind = 'alert' | 'notify' | 'ask';

interface ActiveThread {
  channel: string;
  ts: string;
  lastTs: string;
  kind: MessageKind;
  createdAt: number;
  polledAt: number;
  answered: boolean;
}

interface SlackResponse {
  ok?: boolean;
  error?: string;
  channel?: { id?: string } | string;
  ts?: string;
  messages?: unknown[];
}

interface SlackMessage {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
}

const POLL_INTERVAL_MS = 5_000;
const THREAD_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
// conversations.replies is rate limited (~50/min): poll fresh threads often, older ones rarely.
const FRESH_THREAD_MS = 10 * 60 * 1_000;
const SLOW_POLL_INTERVAL_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageFrom(value: unknown): SlackMessage | null {
  if (!isRecord(value) || typeof value.ts !== 'string' || typeof value.text !== 'string') return null;
  return {
    ts: value.ts,
    text: value.text,
    ...(typeof value.user === 'string' ? { user: value.user } : {}),
    ...(typeof value.bot_id === 'string' ? { bot_id: value.bot_id } : {}),
  };
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function decodeSlackText(value: string): string {
  return value.replace(/&(amp|lt|gt);/g, (entity, name: string) => {
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    return entity;
  }).trim();
}

function safeCodeBlock(value: string): string {
  return value.replaceAll('```', '``\u200b`');
}

function laterThan(left: string, right: string): boolean {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber > rightNumber;
  return left > right;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class SlackNotifier {
  private readonly sessions: SessionManager;
  private readonly db: CerebroDatabase;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly threads = new Map<string, ActiveThread>();
  private readonly unsubscribe: (() => void) | null;
  private readonly pollTimer: NodeJS.Timeout | null;
  private dmChannel: string | null = null;
  private dmChannelPromise: Promise<string> | null = null;
  private polling = false;
  private stopped = false;
  private rateLimitedUntil = 0;

  constructor(sessions: SessionManager, db: CerebroDatabase) {
    this.sessions = sessions;
    this.db = db;
    if (!SLACK_ENABLED) {
      this.unsubscribe = null;
      this.pollTimer = null;
      return;
    }
    this.unsubscribe = sessions.onEvent((event) => this.onSessionEvent(event));
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  status(): { enabled: boolean; alerts: string } {
    return { enabled: SLACK_ENABLED, alerts: SLACK_ALERTS };
  }

  async agentMessage(sessionId: string, kind: 'notify' | 'ask', text: string): Promise<void> {
    if (!SLACK_ENABLED) throw new Error("Slack n'est pas configuré");
    const session = this.db.getSession(sessionId);
    if (session === null) throw new Error('Session introuvable');
    const header = this.header(session);
    const suffix = kind === 'ask'
      ? `\n${this.sessionLink(session.id)}\n_Réponds dans le fil : ta réponse sera envoyée à l'agent._`
      : `\n${this.sessionLink(session.id)}`;
    const message = `${kind === 'ask' ? ':question:' : ':bell:'} ${header}\n${text}${suffix}`;
    await this.postSessionMessage(session.id, kind, message);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.threads.clear();
  }

  private onSessionEvent(event: SessionEvent): void {
    if (event.type === 'session-deleted') {
      const timer = this.timers.get(event.id);
      if (timer !== undefined) clearTimeout(timer);
      this.timers.delete(event.id);
      this.threads.delete(event.id);
      return;
    }
    if (event.type !== 'alert' || SLACK_ALERTS === 'off') return;
    if (SLACK_ALERTS === 'waiting' && event.session.status !== 'waiting') return;
    const previous = this.timers.get(event.session.id);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(event.session.id);
      void this.sendAutomaticAlert(event.session.id).catch((error: unknown) => this.logError(error));
    }, Number.isFinite(SLACK_DELAY_MS) && SLACK_DELAY_MS >= 0 ? SLACK_DELAY_MS : 30_000);
    timer.unref();
    this.timers.set(event.session.id, timer);
  }

  private async sendAutomaticAlert(sessionId: string): Promise<void> {
    if (this.stopped) return;
    const session = this.db.getSession(sessionId);
    if (session === null || !session.attention || (session.status !== 'waiting' && session.status !== 'idle')) return;
    if (SLACK_ALERTS === 'off' || (SLACK_ALERTS === 'waiting' && session.status !== 'waiting')) return;
    // The agent just asked a question and ended its turn: keep its thread as the one to answer.
    const thread = this.threads.get(sessionId);
    if (thread?.kind === 'ask' && !thread.answered) return;
    const icon = session.status === 'waiting' ? ':raised_hand:' : ':white_check_mark:';
    const label = session.status === 'waiting' ? 'En attente' : 'Tour terminé';
    const reason = escapeMrkdwn(session.attentionReason ?? (session.status === 'waiting' ? 'Confirmation requise' : 'Tour terminé'));
    const screen = safeCodeBlock((this.sessions.screenText(session.id, 15) ?? []).join('\n').slice(-2_500));
    const message = `${icon} ${this.header(session)}\n*${label} :* ${reason}\n\`\`\`\n${screen}\n\`\`\`\n${this.sessionLink(session.id)} · réponds dans le fil pour écrire dans la session`;
    await this.postSessionMessage(session.id, 'alert', message);
  }

  private header(session: Session): string {
    const project = this.db.getProject(session.projectId);
    return `*${escapeMrkdwn(project?.name ?? 'Projet inconnu')}* · ${escapeMrkdwn(session.title)} (${session.agent})`;
  }

  private sessionLink(sessionId: string): string {
    const base = PUBLIC_URL.replace(/\/+$/, '');
    return `<${base}/#/s/${encodeURIComponent(sessionId)}|Ouvrir dans Cerebro>`;
  }

  private async postSessionMessage(sessionId: string, kind: MessageKind, text: string): Promise<void> {
    const channel = await this.openDm();
    const response = await this.slackApi('chat.postMessage', { channel, text, unfurl_links: false });
    const responseChannel = typeof response.channel === 'string' ? response.channel : channel;
    if (typeof response.ts !== 'string') throw new Error('Réponse chat.postMessage sans timestamp');
    this.threads.set(sessionId, {
      channel: responseChannel,
      ts: response.ts,
      lastTs: response.ts,
      kind,
      createdAt: Date.now(),
      polledAt: Date.now(),
      answered: false,
    });
  }

  private async openDm(): Promise<string> {
    if (this.dmChannel !== null) return this.dmChannel;
    if (this.dmChannelPromise !== null) return this.dmChannelPromise;
    this.dmChannelPromise = (async () => {
      const response = await this.slackApi('conversations.open', { users: SLACK_USER });
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

  private async slackApi(method: string, body: Record<string, unknown>): Promise<SlackResponse> {
    if (!SLACK_ENABLED || SLACK_TOKEN === undefined) throw new Error("Slack n'est pas configuré");
    if (Date.now() < this.rateLimitedUntil) throw new Error('Limite de débit Slack active');
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
      throw new Error('Limite de débit Slack atteinte');
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

  private async poll(): Promise<void> {
    if (this.stopped || this.polling || this.threads.size === 0 || Date.now() < this.rateLimitedUntil) return;
    this.polling = true;
    try {
      for (const [sessionId, thread] of [...this.threads]) {
        if (this.stopped || Date.now() < this.rateLimitedUntil) break;
        const session = this.db.getSession(sessionId);
        if (session === null || session.status === 'exited' || Date.now() - thread.createdAt >= THREAD_MAX_AGE_MS) {
          this.threads.delete(sessionId);
          continue;
        }
        const age = Date.now() - thread.createdAt;
        if (age > FRESH_THREAD_MS && Date.now() - thread.polledAt < SLOW_POLL_INTERVAL_MS) continue;
        thread.polledAt = Date.now();
        try {
          await this.pollThread(sessionId, thread);
        } catch (error) {
          this.logError(error);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollThread(sessionId: string, thread: ActiveThread): Promise<void> {
    const response = await this.slackApi('conversations.replies', {
      channel: thread.channel,
      ts: thread.ts,
      oldest: thread.lastTs,
      limit: 50,
    });
    const messages = (response.messages ?? [])
      .map(messageFrom)
      .filter((message): message is SlackMessage => message !== null && laterThan(message.ts, thread.lastTs))
      .sort((left, right) => laterThan(left.ts, right.ts) ? 1 : laterThan(right.ts, left.ts) ? -1 : 0);
    for (const message of messages) {
      if (this.threads.get(sessionId) !== thread) return;
      thread.lastTs = message.ts;
      if (message.user !== SLACK_USER || message.bot_id !== undefined) continue;
      const transmitted = await this.injectReply(sessionId, thread.kind, decodeSlackText(message.text));
      if (transmitted) {
        thread.answered = true;
        try {
          await this.slackApi('reactions.add', {
            channel: thread.channel,
            timestamp: message.ts,
            name: 'white_check_mark',
          });
        } catch (error) {
          this.logError(error);
        }
      } else {
        await this.slackApi('chat.postMessage', {
          channel: thread.channel,
          thread_ts: thread.ts,
          text: 'Session inactive : message non transmis.',
          unfurl_links: false,
        });
      }
    }
  }

  private async injectReply(sessionId: string, kind: MessageKind, text: string): Promise<boolean> {
    const session = this.db.getSession(sessionId);
    if (session === null || session.status === 'exited') return false;
    const shortcut = text.toLocaleLowerCase('fr-FR');
    if (shortcut === 'entrée' || shortcut === 'enter') return this.sessions.writeInput(sessionId, '\r');
    if (shortcut === 'échap' || shortcut === 'esc') return this.sessions.writeInput(sessionId, '\x1b');
    if (session.status === 'waiting' && /^[0-9yYnN]$/.test(text)) return this.sessions.writeInput(sessionId, text);
    const message = kind === 'ask' ? `[Réponse Slack] ${text}` : text;
    if (!this.sessions.writeInput(sessionId, message)) return false;
    await delay(150);
    return this.sessions.writeInput(sessionId, '\r');
  }

  private logError(error: unknown): void {
    console.error('[slack]', error instanceof Error ? error.message : error);
  }
}
