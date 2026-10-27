import { SLACK_ENABLED } from './config.ts';
import type { CouncilRuns } from './council-runner.ts';
import type { CerebroDatabase, Session } from './db.ts';
import { OperationResults } from './operation-results.ts';
import type { PeerSync } from './peers.ts';
import type { SessionEvent, SessionManager } from './sessions.ts';
import { SlackAlerts } from './slack-alerts.ts';
import { SlackClient, SlackTransport, type SlackMessage, type SlackResponse } from './slack-api.ts';
import { injectDmMessage, SlackDmCommands } from './slack-commands.ts';
import { SlackPoller } from './slack-polling.ts';
import {
  loadSettings,
  mergeSettings,
  saveSettings,
  SlackState,
  type ActiveThread,
  type SlackSettings,
} from './slack-state.ts';

export { councilSlackText, parseCouncilCommand } from './slack-format.ts';

const POLL_INTERVAL_MS = 5_000;

/**
 * Slack side of Cerebro, assembled from its modules: transport (`slack-api.ts`), saved state and settings
 * (`slack-state.ts`), outgoing alerts (`slack-alerts.ts`), polling of the DM and session threads
 * (`slack-polling.ts`) and DM commands (`slack-commands.ts`). Modules reach Slack through `slackApi` and report
 * through `logError`, called late so both can be replaced.
 */
export class SlackNotifier {
  readonly operations: OperationResults;
  /** Session threads whose replies are read and into which turn ends are relayed, by session id. */
  readonly threads: Map<string, ActiveThread>;
  // Branché par le serveur ; absent, `council:` répond que le council est indisponible.
  councils: CouncilRuns | null = null;
  private readonly sessions: SessionManager;
  private readonly transport = new SlackTransport();
  private readonly client: SlackClient;
  private readonly state: SlackState;
  private readonly alerts: SlackAlerts;
  private readonly poller: SlackPoller;
  private readonly commands: SlackDmCommands;
  private readonly unsubscribe: (() => void) | null;
  private readonly pollTimer: NodeJS.Timeout | null;
  private settings: SlackSettings = loadSettings();

  constructor(sessions: SessionManager, db: CerebroDatabase, peers: PeerSync) {
    this.sessions = sessions;
    this.client = new SlackClient(
      (method, body) => this.slackApi(method, body),
      (error) => this.logError(error),
    );
    this.state = new SlackState((error) => this.logError(error));
    this.threads = this.state.threads;
    this.alerts = new SlackAlerts(this.client, this.state, db, sessions, peers, () => this.settings);
    this.poller = new SlackPoller(
      this.client,
      this.state,
      db,
      sessions,
      peers,
      () => this.transport.rateLimited(),
      (channel, message) => this.handleDmMessage(channel, message),
    );
    this.commands = new SlackDmCommands(this.client, this.state, db, sessions, peers, {
      inject: (session, text) => this.injectDmMessage(session, text),
      councils: () => this.councils,
    });
    this.operations = new OperationResults(db);
    this.operations.delay = () => this.settings.delaySeconds * 1000;
    this.operations.wanted = (result) =>
      SLACK_ENABLED && !this.client.stopped && (result.ok ? this.settings.idle : this.settings.waiting);
    this.operations.onError = (cause) => this.logError(cause);
    this.operations.send = (result) => this.alerts.sendOperationResult(result, this.operations);
    if (!SLACK_ENABLED) {
      this.unsubscribe = null;
      this.pollTimer = null;
      return;
    }
    this.operations.restore();
    this.state.load(db);
    this.state.markDirty();
    this.state.save();
    this.unsubscribe = sessions.onEvent((event) => this.onSessionEvent(event));
    peers.setSlackPoster((text) => this.client.postToDm(text));
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  status(): { enabled: boolean } & SlackSettings {
    return { enabled: SLACK_ENABLED, ...this.settings };
  }

  agentMessagesAllowed(): boolean {
    return this.settings.agentMessages;
  }

  updateSettings(patch: Record<string, unknown>): SlackSettings | null {
    const next = mergeSettings(this.settings, patch);
    if (next === null) return null;
    saveSettings(next);
    this.settings = next;
    // Pending alerts may no longer be wanted: re-checked when their timer fires.
    return next;
  }

  async agentMessage(sessionId: string, kind: 'notify' | 'ask', text: string): Promise<void> {
    if (!SLACK_ENABLED) throw new Error("Slack n'est pas configuré");
    await this.alerts.agentMessage(sessionId, kind, text);
  }

  stop(): void {
    this.client.stopped = true;
    this.operations.close();
    this.unsubscribe?.();
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.alerts.clearTimers();
  }

  private onSessionEvent(event: SessionEvent): void {
    this.alerts.onSessionEvent(event);
  }

  private poll(): Promise<void> {
    return this.poller.poll();
  }

  private handleDmMessage(channel: string, message: SlackMessage): Promise<void> {
    return this.commands.handle(channel, message);
  }

  /** `? question` from the DM, answered in the thread `threadTs`. */
  private answerDmQuestion(channel: string, threadTs: string, question: string): Promise<void> {
    return this.commands.answerQuestion(channel, threadTs, question);
  }

  private injectDmMessage(session: Session, text: string): Promise<boolean> {
    return injectDmMessage(this.sessions, session, text);
  }

  private slackApi(method: string, body: Record<string, unknown>): Promise<SlackResponse> {
    return this.transport.call(method, body);
  }

  private logError(error: unknown): void {
    console.error('[slack]', error instanceof Error ? error.message : error);
  }
}
