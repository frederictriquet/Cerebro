import { PUBLIC_URL } from './config.ts';
import type { CerebroDatabase, Session } from './db.ts';
import type { OperationResult, OperationResults } from './operation-results.ts';
import type { PeerSync } from './peers.ts';
import { formatQuestions } from './questions.ts';
import type { AgentQuestion } from './questions.ts';
import type { SessionEvent, SessionManager } from './sessions.ts';
import type { SlackClient } from './slack-api.ts';
import {
  escapeMrkdwn,
  safeCodeBlock,
  sessionHeader,
  sessionLink,
  slackMarkdown,
  splitMessage,
} from './slack-format.ts';
import type { MessageKind, SlackSettings, SlackState } from './slack-state.ts';

interface NotificationTurn {
  started_at: number;
  ended_at: number | null;
  custom_at: number | null;
  relayed_at: number | null;
  automatic_at: number | null;
}

/**
 * Messages Cerebro sends on its own: alerts at the end of a turn, deferred by the configured delay, the agent's
 * own messages, turn ends relayed into the thread that started them, and operation results. Each turn records
 * which of them was sent, so a later one does not repeat it.
 */
export class SlackAlerts {
  private readonly client: SlackClient;
  private readonly state: SlackState;
  private readonly db: CerebroDatabase;
  private readonly sessions: SessionManager;
  private readonly peers: PeerSync;
  private readonly settings: () => SlackSettings;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    client: SlackClient,
    state: SlackState,
    db: CerebroDatabase,
    sessions: SessionManager,
    peers: PeerSync,
    settings: () => SlackSettings,
  ) {
    this.client = client;
    this.state = state;
    this.db = db;
    this.sessions = sessions;
    this.peers = peers;
    this.settings = settings;
  }

  private turn(sessionId: string): NotificationTurn | null {
    return (
      (this.db.connection.prepare('SELECT * FROM notification_turns WHERE session_id=?').get(sessionId) as
        NotificationTurn | undefined) ?? null
    );
  }

  private markTurn(sessionId: string, column: 'custom_at' | 'relayed_at' | 'automatic_at'): void {
    const session = this.db.getSession(sessionId);
    if (!session) return;
    this.db.connection
      .prepare('INSERT OR IGNORE INTO notification_turns (session_id,started_at) VALUES (?,?)')
      .run(sessionId, session.createdAt);
    this.db.connection
      .prepare(`UPDATE notification_turns SET ${column}=? WHERE session_id=?`)
      .run(Date.now(), sessionId);
  }

  private alertWanted(status: Session['status']): boolean {
    return status === 'waiting' ? this.settings().waiting : status === 'idle' && this.settings().idle;
  }

  private cancelAlert(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async agentMessage(sessionId: string, kind: 'notify' | 'ask', text: string): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (session === null) throw new Error('Session introuvable');
    this.markTurn(sessionId, 'custom_at');
    this.cancelAlert(sessionId);
    const header = sessionHeader(this.db, session);
    const suffix =
      kind === 'ask'
        ? `\n${sessionLink(session.id)}\n_Réponds dans le fil : ta réponse sera envoyée à l'agent._`
        : `\n${sessionLink(session.id)}`;
    const message = `${kind === 'ask' ? ':question:' : ':bell:'} ${header}\n${text}${suffix}`;
    await this.client.serial(session.id, async () => {
      if (this.client.stopped) return;
      const thread = this.state.threads.get(session.id);
      if (
        kind === 'notify' &&
        thread &&
        (this.turn(session.id)?.automatic_at || (thread.kind === 'ask' && !thread.answered))
      )
        await this.client.postThreadReply(thread.channel, thread.ts, message);
      else await this.postSessionMessage(session.id, kind, message);
    });
  }

  onSessionEvent(event: SessionEvent): void {
    if (event.type === 'session') {
      const session = event.session;
      const turn = this.turn(session.id);
      if (session.status === 'running' && (!turn || turn.ended_at !== null))
        this.db.connection
          .prepare(
            'INSERT INTO notification_turns (session_id,started_at) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET started_at=excluded.started_at,ended_at=NULL,custom_at=NULL,relayed_at=NULL,automatic_at=NULL',
          )
          .run(session.id, session.updatedAt);
      if (session.status === 'idle' && turn && turn.ended_at === null)
        this.db.connection
          .prepare('UPDATE notification_turns SET ended_at=? WHERE session_id=?')
          .run(Date.now(), session.id);
    }
    if (event.type === 'session-deleted') {
      this.cancelAlert(event.id);
      if (this.state.threads.delete(event.id)) this.state.changed();
      return;
    }
    if (event.type === 'turn-complete') {
      this.db.connection
        .prepare('UPDATE notification_turns SET ended_at=COALESCE(ended_at,?) WHERE session_id=?')
        .run(Date.now(), event.id);
      this.relayTurnEnd(event.id, event.message);
      return;
    }
    if (event.type !== 'alert' || !this.alertWanted(event.session.status)) return;
    const previous = this.timers.get(event.session.id);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(event.session.id);
      void this.client
        .serial(event.session.id, () => this.deliverAutomaticAlert(event.session.id))
        .catch((error: unknown) => this.client.logError(error));
    }, this.settings().delaySeconds * 1_000);
    timer.unref();
    this.timers.set(event.session.id, timer);
  }

  private relayTurnEnd(sessionId: string, message: string | null): void {
    const thread = this.state.threads.get(sessionId);
    if (thread === undefined || !thread.awaitingReply) return;
    if (thread.skipTurnEnd) {
      thread.skipTurnEnd = false;
      this.state.changed();
      return;
    }
    if (thread.moreTurns) thread.moreTurns = false;
    else thread.awaitingReply = false;
    this.markTurn(sessionId, 'relayed_at');
    this.state.changed();
    // The answer itself lands in the thread: the "turn complete" alert would only repeat it.
    this.cancelAlert(sessionId);
    const text =
      message !== null && message.trim() !== ''
        ? slackMarkdown(message)
        : `\`\`\`\n${safeCodeBlock((this.sessions.screenText(sessionId, 30) ?? []).join('\n').slice(-3_000))}\n\`\`\``;
    void this.client
      .serial(sessionId, async () => {
        for (const chunk of splitMessage(text)) await this.client.postThreadReply(thread.channel, thread.ts, chunk);
      })
      .catch((error: unknown) => this.client.logError(error));
  }

  private async deliverAutomaticAlert(sessionId: string): Promise<void> {
    if (this.client.stopped) return;
    const session = this.db.getSession(sessionId);
    if (session === null || !session.attention || (session.status !== 'waiting' && session.status !== 'idle')) return;
    if (!this.alertWanted(session.status)) return;
    const turn = this.turn(sessionId);
    if (
      turn &&
      (turn.automatic_at !== null ||
        (session.status === 'idle' && (turn.custom_at !== null || turn.relayed_at !== null)))
    )
      return;
    // The agent just asked a question and ended its turn: keep its thread as the one to answer.
    const thread = this.state.threads.get(sessionId);
    if (thread?.kind === 'ask' && !thread.answered) return;
    const header = sessionHeader(this.db, session);
    const questions = session.status === 'waiting' ? this.sessions.pendingQuestions(session.id) : null;
    if (questions !== null) {
      const message = `:question: ${header}\n${formatQuestions(questions)}\n${sessionLink(session.id)}`;
      await this.postSessionMessage(session.id, 'alert', message, questions);
      this.markTurn(sessionId, 'automatic_at');
      return;
    }
    const icon = session.status === 'waiting' ? ':raised_hand:' : ':white_check_mark:';
    const label = session.status === 'waiting' ? 'En attente' : 'Tour terminé';
    const reason = escapeMrkdwn(
      session.attentionReason ?? (session.status === 'waiting' ? 'Confirmation requise' : 'Tour terminé'),
    );
    const screen = safeCodeBlock((this.sessions.screenText(session.id, 15) ?? []).join('\n').slice(-2_500));
    const duration = turn
      ? ` · durée du tour : ${Math.max(0, Math.round(((turn.ended_at ?? Date.now()) - turn.started_at) / 1000))} s`
      : '';
    const message = `${icon} ${header}${duration}\n*${label} :* ${reason}\n\`\`\`\n${screen}\n\`\`\`\n${sessionLink(session.id)} · réponds dans le fil pour écrire dans la session`;
    await this.postSessionMessage(session.id, 'alert', message);
    this.markTurn(sessionId, 'automatic_at');
  }

  /** Posts a new DM message for the session: its thread becomes the one replies are read from. */
  private async postSessionMessage(
    sessionId: string,
    kind: MessageKind,
    text: string,
    questions: AgentQuestion[] | null = null,
  ): Promise<void> {
    const channel = await this.client.openDm();
    const response = await this.client.call('chat.postMessage', { channel, text, unfurl_links: false });
    const responseChannel = typeof response.channel === 'string' ? response.channel : channel;
    if (typeof response.ts !== 'string') throw new Error('Réponse chat.postMessage sans timestamp');
    this.state.threads.set(sessionId, {
      channel: responseChannel,
      ts: response.ts,
      lastTs: response.ts,
      kind,
      createdAt: Date.now(),
      polledAt: Date.now(),
      answered: false,
      awaitingReply: false,
      skipTurnEnd: false,
      moreTurns: false,
      questions,
      fromDm: false,
    });
    this.state.changed();
  }

  /**
   * Posts an operation result in its session's thread, or in the DM. False when nothing was posted: the result
   * belongs to another machine, was seen meanwhile, or is no longer wanted.
   */
  async sendOperationResult(result: OperationResult, operations: OperationResults): Promise<boolean> {
    await this.peers.ready;
    if (this.client.stopped) return false;
    // Les résultats hors projet restent locaux : leur machine d’origine les notifie.
    // L’élection du répondeur général ne déduplique que les commandes entrantes.
    const project = result.projectId === null ? null : this.db.getProject(result.projectId);
    if (result.projectId !== null && (!project || !this.peers.owns(project.name))) return false;
    const councilId = result.kind === 'council' ? result.id.replace(/^council:/, '') : null;
    const link =
      councilId !== null
        ? `#/c/${encodeURIComponent(councilId)}`
        : project
          ? `#/p/${encodeURIComponent(project.id)}`
          : '#/';
    const text = `${result.ok ? ':white_check_mark:' : ':x:'} *${escapeMrkdwn(project?.name ?? 'Hors projet')}* — ${result.kind} : ${escapeMrkdwn(result.summary)}\nDurée : ${Math.max(0, Math.round((result.finishedAt - result.startedAt) / 1000))} s\n<${PUBLIC_URL.replace(/\/+$/, '')}/${link}|Ouvrir dans Cerebro>`;
    let sent = false;
    await this.client.serial(result.sessionId ?? `operation:${result.id}`, async () => {
      // Recheck after peer coordination and any pending send in this session.
      if (this.client.stopped) return;
      const current = operations.get(result.id);
      if (this.client.stopped || current?.seenAt || current?.notifiedAt || !operations.wanted(result)) return;
      const thread = result.sessionId ? this.state.threads.get(result.sessionId) : undefined;
      if (thread) await this.client.postThreadReply(thread.channel, thread.ts, text);
      else await this.client.postToDm(text);
      sent = true;
    });
    return sent;
  }
}
