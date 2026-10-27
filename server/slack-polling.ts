import { SLACK_USER } from './config.ts';
import type { CerebroDatabase } from './db.ts';
import type { PeerSync } from './peers.ts';
import { interpretAnswer } from './questions.ts';
import type { AgentQuestion } from './questions.ts';
import type { SessionManager } from './sessions.ts';
import { messageFrom, type SlackClient, type SlackMessage } from './slack-api.ts';
import { decodeSlackText, escapeMrkdwn, INACTIVE_SESSION_REPLY, isKeyShortcut, laterThan } from './slack-format.ts';
import { armReply, THREAD_MAX_AGE_MS, type ActiveThread, type MessageKind, type SlackState } from './slack-state.ts';

export const POLL_INTERVAL_MS = 5_000;
// conversations.replies is rate limited (~50/min): poll fresh threads often, older ones rarely.
const FRESH_THREAD_MS = 10 * 60 * 1_000;
const SLOW_POLL_INTERVAL_MS = 60_000;
// Read calls of the poll loop (DM history and thread replies) share this budget over a sliding minute,
// below Slack's Tier 3 limit: many fresh threads are polled in turn instead of triggering a 429.
export const POLL_CALLS_PER_MINUTE = 45;
const POLL_WINDOW_MS = 60_000;
// The DM is read once per tick; threads get the rest, so they never starve the commands it carries.
const THREAD_POLLS_PER_MINUTE = POLL_CALLS_PER_MINUTE - Math.ceil(POLL_WINDOW_MS / POLL_INTERVAL_MS);
// Read pages are followed (cursor) up to these bounds: after a long outage, older messages are not skipped.
const READ_PAGE_SIZE = 200;
const MAX_DM_PAGES = 10;
const MAX_THREAD_PAGES = 5;

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Types `text` then Enter into a session; an open question dialog is dismissed (Esc) first. */
export async function typeIntoSession(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  dismissDialog = false,
): Promise<boolean> {
  if (dismissDialog) {
    if (!sessions.writeInput(sessionId, '\x1b')) return false;
    sessions.setPendingQuestions(sessionId, null);
    await delay(800);
  }
  if (!sessions.writeInput(sessionId, text)) return false;
  await delay(150);
  return sessions.writeInput(sessionId, '\r');
}

function sameQuestions(left: AgentQuestion[] | null, right: AgentQuestion[]): boolean {
  return left === right || (left !== null && JSON.stringify(left) === JSON.stringify(right));
}

/**
 * Reads what the user writes in Slack: new DM messages, handed to `onDmMessage` as commands, and replies in
 * session threads, typed into their session.
 */
export class SlackPoller {
  private readonly client: SlackClient;
  private readonly state: SlackState;
  private readonly db: CerebroDatabase;
  private readonly sessions: SessionManager;
  private readonly peers: PeerSync;
  private readonly rateLimited: () => boolean;
  private readonly onDmMessage: (channel: string, message: SlackMessage) => Promise<void>;
  private readonly threadPolls: number[] = [];
  // Round-robin order of thread reads: a thread never read yet comes first.
  private readonly pollTurns = new WeakMap<ActiveThread, number>();
  private pollTurn = 0;

  constructor(
    client: SlackClient,
    state: SlackState,
    db: CerebroDatabase,
    sessions: SessionManager,
    peers: PeerSync,
    rateLimited: () => boolean,
    onDmMessage: (channel: string, message: SlackMessage) => Promise<void>,
  ) {
    this.client = client;
    this.state = state;
    this.db = db;
    this.sessions = sessions;
    this.peers = peers;
    this.rateLimited = rateLimited;
    this.onDmMessage = onDmMessage;
  }

  async poll(): Promise<void> {
    if (this.client.stopped || this.state.polling || this.rateLimited()) return;
    this.state.polling = true;
    try {
      try {
        await this.pollDm();
      } catch (error) {
        this.client.logError(error);
      }
      const due: [string, ActiveThread][] = [];
      for (const [sessionId, thread] of [...this.state.threads]) {
        if (!this.keepThread(sessionId, thread)) {
          this.state.threads.delete(sessionId);
          this.state.markDirty();
          continue;
        }
        const age = Date.now() - thread.createdAt;
        if (age > FRESH_THREAD_MS && Date.now() - thread.polledAt < SLOW_POLL_INTERVAL_MS) continue;
        due.push([sessionId, thread]);
      }
      // Round robin: the least recently polled threads use the remaining budget first.
      due.sort(([, left], [, right]) => (this.pollTurns.get(left) ?? -1) - (this.pollTurns.get(right) ?? -1));
      for (const [sessionId, thread] of due) {
        if (this.client.stopped || this.rateLimited() || !this.takeThreadPoll()) break;
        if (this.state.threads.get(sessionId) !== thread) continue;
        thread.polledAt = Date.now();
        this.pollTurns.set(thread, this.pollTurn++);
        try {
          await this.pollThread(sessionId, thread);
        } catch (error) {
          this.client.logError(error);
        }
      }
    } finally {
      this.state.save();
      this.state.polling = false;
    }
  }

  /** False for the thread of a session gone, exited or too old, or of a DM command another machine took over. */
  private keepThread(sessionId: string, thread: ActiveThread): boolean {
    const session = this.db.getSession(sessionId);
    if (session === null || session.status === 'exited' || Date.now() - thread.createdAt >= THREAD_MAX_AGE_MS)
      return false;
    // Another machine took the project over: its commands, and their threads, are now its own.
    const project = this.db.getProject(session.projectId);
    return !(thread.fromDm && project !== null && !this.peers.owns(project.name));
  }

  /**
   * Reserves one thread read in the poll budget; false once the minute's share is spent.
   * `force` records a read that cannot wait (DM catch-up pages): threads then yield the budget.
   */
  takeThreadPoll(force = false): boolean {
    const now = Date.now();
    while (this.threadPolls.length > 0 && now - this.threadPolls[0] >= POLL_WINDOW_MS) this.threadPolls.shift();
    if (!force && this.threadPolls.length >= THREAD_POLLS_PER_MINUTE) return false;
    this.threadPolls.push(now);
    return true;
  }

  /**
   * Reads every page of a history or replies call, as long as `nextPage` allows another call, and
   * returns the messages later than `after` in chronological order. `complete` is false when pages
   * were left unread.
   */
  private async readMessages(
    method: 'conversations.history' | 'conversations.replies',
    body: Record<string, unknown>,
    after: string,
    nextPage: (pages: number) => boolean,
  ): Promise<{ messages: SlackMessage[]; complete: boolean }> {
    const messages: SlackMessage[] = [];
    let cursor: string | null = null;
    for (let pages = 1; ; pages++) {
      const response = await this.client.call(method, {
        ...body,
        limit: READ_PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      });
      for (const value of response.messages ?? []) {
        const message = messageFrom(value);
        if (message !== null && laterThan(message.ts, after)) messages.push(message);
      }
      const next = response.response_metadata?.next_cursor;
      cursor = response.has_more !== false && typeof next === 'string' && next !== '' ? next : null;
      if (cursor === null || !nextPage(pages)) break;
    }
    messages.sort((left, right) => (laterThan(left.ts, right.ts) ? 1 : laterThan(right.ts, left.ts) ? -1 : 0));
    return { messages, complete: cursor === null };
  }

  async pollDm(): Promise<void> {
    const channel = await this.client.openDm();
    // History pages run from the newest message backwards: all of them are needed before handling any.
    const { messages, complete } = await this.readMessages(
      'conversations.history',
      { channel, oldest: this.state.dmCursor },
      this.state.dmCursor,
      (pages) => pages < MAX_DM_PAGES && this.takeThreadPoll(true),
    );
    if (!complete)
      this.client.logError(
        new Error(
          `Historique du DM Slack tronqué à ${MAX_DM_PAGES * READ_PAGE_SIZE} messages : les plus anciens sont ignorés`,
        ),
      );
    for (const message of messages) {
      this.state.dmCursor = message.ts;
      this.state.markDirty();
      if (
        message.user !== SLACK_USER ||
        message.bot_id !== undefined ||
        message.subtype !== undefined ||
        (message.thread_ts !== undefined && message.thread_ts !== message.ts)
      )
        continue;
      try {
        await this.onDmMessage(channel, message);
      } catch (error) {
        this.client.logError(error);
      }
    }
  }

  async pollThread(sessionId: string, thread: ActiveThread): Promise<void> {
    // Replies pages run forwards in time: the unread rest is picked up from lastTs on the next poll.
    const { messages } = await this.readMessages(
      'conversations.replies',
      { channel: thread.channel, ts: thread.ts, oldest: thread.lastTs },
      thread.lastTs,
      (pages) => pages < MAX_THREAD_PAGES && this.takeThreadPoll(),
    );
    for (const message of messages) {
      if (this.state.threads.get(sessionId) !== thread) return;
      thread.lastTs = message.ts;
      this.state.markDirty();
      if (message.user !== SLACK_USER || message.bot_id !== undefined || message.text === undefined) continue;
      const text = decodeSlackText(message.text);
      const queued = this.db.getSession(sessionId)?.status === 'running' && !isKeyShortcut(text);
      const transmitted =
        thread.questions !== null
          ? await this.answerQuestions(sessionId, thread, text)
          : await this.injectReply(sessionId, thread.kind, text);
      if (transmitted) {
        thread.answered = true;
        armReply(thread, queued);
        this.state.markDirty();
        await this.client.acknowledge(thread.channel, message.ts);
      } else {
        await this.client.postThreadReply(thread.channel, thread.ts, INACTIVE_SESSION_REPLY);
      }
    }
  }

  /**
   * The dialog is dismissed (Esc) and the answer typed as the next prompt: driving the multi-tab
   * dialog key by key would break as soon as its layout changes.
   */
  private async answerQuestions(sessionId: string, thread: ActiveThread, text: string): Promise<boolean> {
    const questions = thread.questions ?? [];
    if (isKeyShortcut(text)) return this.injectReply(sessionId, thread.kind, text);
    const session = this.db.getSession(sessionId);
    if (session === null || session.status === 'exited') return false;
    const interpreted = interpretAnswer(questions, text);
    const answer = (interpreted ?? text).replace(/\s*\n+\s*/g, ' ');
    // Answered or dismissed meanwhile (e.g. from the web UI): the answer becomes a plain message.
    const dialogOpen = sameQuestions(this.sessions.pendingQuestions(sessionId), questions);
    const prefix = dialogOpen
      ? '[Réponse Slack à tes questions, le dialogue a été fermé]'
      : '[Réponse Slack à tes questions]';
    if (!(await typeIntoSession(this.sessions, sessionId, `${prefix} ${answer}`, dialogOpen))) return false;
    // Later replies in this thread are ordinary messages.
    thread.questions = null;
    this.state.markDirty();
    if (interpreted !== null) {
      await this.client
        .postThreadReply(thread.channel, thread.ts, `Transmis : ${escapeMrkdwn(interpreted)}`)
        .catch((error: unknown) => this.client.logError(error));
    }
    return true;
  }

  private async injectReply(sessionId: string, kind: MessageKind, text: string): Promise<boolean> {
    const session = this.db.getSession(sessionId);
    if (session === null || session.status === 'exited') return false;
    const shortcut = text.toLocaleLowerCase('fr-FR');
    if (shortcut === 'entrée' || shortcut === 'enter') return this.sessions.writeInput(sessionId, '\r');
    if (shortcut === 'échap' || shortcut === 'esc') return this.sessions.writeInput(sessionId, '\x1b');
    // Single-key shortcut for menus/confirmations; a reply to a free-text question stays a message.
    if (session.status === 'waiting' && kind !== 'ask' && /^[0-9yYnN]$/.test(text)) {
      return this.sessions.writeInput(sessionId, text);
    }
    return typeIntoSession(this.sessions, sessionId, kind === 'ask' ? `[Réponse Slack] ${text}` : text);
  }
}
