import { SLACK_USER } from './config.ts';
import type { CerebroDatabase } from './db.ts';
import type { PeerSync } from './peers.ts';
import { interpretAnswer } from './questions.ts';
import type { AgentQuestion } from './questions.ts';
import type { SessionManager } from './sessions.ts';
import { messageFrom, type SlackClient, type SlackMessage } from './slack-api.ts';
import { decodeSlackText, escapeMrkdwn, isKeyShortcut, laterThan } from './slack-format.ts';
import { armReply, THREAD_MAX_AGE_MS, type ActiveThread, type MessageKind, type SlackState } from './slack-state.ts';

// conversations.replies is rate limited (~50/min): poll fresh threads often, older ones rarely.
const FRESH_THREAD_MS = 10 * 60 * 1_000;
const SLOW_POLL_INTERVAL_MS = 60_000;

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameQuestions(left: AgentQuestion[] | null, right: AgentQuestion[]): boolean {
  return left === right || (left !== null && JSON.stringify(left) === JSON.stringify(right));
}

/** Messages newer than `cursor`, oldest first. */
function newMessages(values: unknown[] | undefined, cursor: string): SlackMessage[] {
  return (values ?? [])
    .map(messageFrom)
    .filter((message): message is SlackMessage => message !== null && laterThan(message.ts, cursor))
    .sort((left, right) => (laterThan(left.ts, right.ts) ? 1 : laterThan(right.ts, left.ts) ? -1 : 0));
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
      for (const [sessionId, thread] of [...this.state.threads]) {
        if (this.client.stopped || this.rateLimited()) break;
        if (!this.keepThread(sessionId, thread)) {
          this.state.threads.delete(sessionId);
          this.state.markDirty();
          continue;
        }
        const age = Date.now() - thread.createdAt;
        if (age > FRESH_THREAD_MS && Date.now() - thread.polledAt < SLOW_POLL_INTERVAL_MS) continue;
        thread.polledAt = Date.now();
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

  private async pollDm(): Promise<void> {
    const channel = await this.client.openDm();
    const response = await this.client.call('conversations.history', {
      channel,
      oldest: this.state.dmCursor,
      limit: 50,
    });
    for (const message of newMessages(response.messages, this.state.dmCursor)) {
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

  private async pollThread(sessionId: string, thread: ActiveThread): Promise<void> {
    const response = await this.client.call('conversations.replies', {
      channel: thread.channel,
      ts: thread.ts,
      oldest: thread.lastTs,
      limit: 50,
    });
    for (const message of newMessages(response.messages, thread.lastTs)) {
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
        try {
          await this.client.call('reactions.add', {
            channel: thread.channel,
            timestamp: message.ts,
            name: 'white_check_mark',
          });
        } catch (error) {
          this.client.logError(error);
        }
      } else {
        await this.client.postThreadReply(thread.channel, thread.ts, 'Session inactive : message non transmis.');
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
    if (dialogOpen) {
      if (!this.sessions.writeInput(sessionId, '\x1b')) return false;
      this.sessions.setPendingQuestions(sessionId, null);
      await delay(800);
    }
    const prefix = dialogOpen
      ? '[Réponse Slack à tes questions, le dialogue a été fermé]'
      : '[Réponse Slack à tes questions]';
    if (!this.sessions.writeInput(sessionId, `${prefix} ${answer}`)) return false;
    await delay(150);
    if (!this.sessions.writeInput(sessionId, '\r')) return false;
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
    const message = kind === 'ask' ? `[Réponse Slack] ${text}` : text;
    if (!this.sessions.writeInput(sessionId, message)) return false;
    await delay(150);
    return this.sessions.writeInput(sessionId, '\r');
  }
}
