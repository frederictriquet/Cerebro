import type { ProjectSlackSettings, Session } from '../shared/types.ts';
import type { SlackStatus, SlackWatchList } from '../shared/machine.ts';
import { SLACK_ENABLED, SLACK_WATCH_ENABLED, SLACK_WATCH_UNCONFIGURED } from './config.ts';
import type { CouncilRuns } from './council-runner.ts';
import type { CerebroDatabase } from './db.ts';
import { OperationResults } from './operation-results.ts';
import type { PeerSync } from './peers.ts';
import type { SessionEvent, SessionManager } from './sessions.ts';
import { SlackAlerts } from './slack-alerts.ts';
import { postedWatchRequest } from './slack-auto-watch.ts';
import { SlackClient, SlackTransport, slackUserTransport, type SlackMessage, type SlackResponse } from './slack-api.ts';
import { injectDmMessage, SlackDmCommands } from './slack-commands.ts';
import { POLL_INTERVAL_MS, SlackPoller } from './slack-polling.ts';
import { laterThan } from './slack-format.ts';
import {
  DAY_MS,
  newWatch,
  SlackSettingsStore,
  SlackState,
  projectSettings,
  type ActiveThread,
  type SlackSettings,
  type SlackWatch,
  type WatchDelivery,
  type WatchRequest,
} from './slack-state.ts';
import { SlackWatcher, type BotIdentity } from './slack-watches.ts';

export { councilSlackText, decodeSlackText, parseCouncilCommand } from './slack-format.ts';
export { POLL_CALLS_PER_MINUTE } from './slack-polling.ts';

// Each watch costs reads of the user token's budget: past this, a session removes some first.
export const MAX_WATCHES_PER_SESSION = 50;

/** A watch request refused, with its HTTP status (503 without the user token). */
export class WatchError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Slack side of Cerebro, assembled from its modules: transport (`slack-api.ts`), saved state and settings
 * (`slack-state.ts`), outgoing alerts (`slack-alerts.ts`), polling of the DM and session threads
 * (`slack-polling.ts`), DM commands (`slack-commands.ts`) and watched threads and channels, read with the user token
 * (`slack-watches.ts`). Modules reach Slack through `slackApi` and report
 * through `logError`, called late so both can be replaced.
 */
export class SlackNotifier {
  readonly operations: OperationResults;
  /** Session threads whose replies are read and into which turn ends are relayed, by session id. */
  readonly threads: Map<string, ActiveThread>;
  // Branché par le serveur ; absent, `council:` répond que le council est indisponible.
  councils: CouncilRuns | null = null;
  private readonly sessions: SessionManager;
  private readonly db: CerebroDatabase;
  private readonly transport = new SlackTransport();
  private readonly client: SlackClient;
  // User token, read methods only: watched threads and channels are read as the user, on their own rate limit.
  private readonly userTransport = slackUserTransport();
  private readonly reader: SlackClient;
  private readonly state: SlackState;
  private readonly alerts: SlackAlerts;
  private readonly poller: SlackPoller;
  private readonly watcher: SlackWatcher;
  private botIdentity: Promise<BotIdentity> | null = null;
  private readonly commands: SlackDmCommands;
  private readonly unsubscribe: (() => void) | null;
  private readonly pollTimer: NodeJS.Timeout | null;
  private readonly settingsStore = new SlackSettingsStore((error) => this.logError(error));
  // Called when watches are added, removed, read further or expire: the web UI reloads its list.
  private readonly onWatchesChange: () => void;
  // Last watches reported through onWatchesChange.
  private watchesSignature = '';

  constructor(sessions: SessionManager, db: CerebroDatabase, peers: PeerSync, onWatchesChange: () => void = () => {}) {
    this.sessions = sessions;
    this.db = db;
    this.onWatchesChange = onWatchesChange;
    this.client = new SlackClient(
      (method, body) => this.slackApi(method, body),
      (error) => this.logError(error),
    );
    this.reader = new SlackClient(
      (method, body) => this.userTransport.call(method, body),
      (error) => this.logError(error),
    );
    this.state = new SlackState((error) => this.logError(error));
    this.threads = this.state.threads;
    this.alerts = new SlackAlerts(
      this.client,
      this.state,
      db,
      sessions,
      peers,
      (projectId) => this.settingsFor(projectId),
      this.transport,
    );
    this.poller = new SlackPoller(
      this.client,
      this.state,
      db,
      sessions,
      peers,
      () => this.transport.rateLimited(),
      (channel, message) => this.handleDmMessage(channel, message),
    );
    this.watcher = new SlackWatcher(
      this.reader,
      this.state,
      db,
      sessions,
      (sessionId) => this.settingsFor(sessionId === undefined ? null : this.projectOf(sessionId)),
      () => this.userTransport.rateLimited(),
      {
        posting: (sessionId) => this.projectSlack(this.projectOf(sessionId))?.mode !== 'off',
        post: (sessionId, mode, text) => this.alerts.watchMessage(sessionId, mode, text),
        cerebroBot: () => this.cerebroBot(),
      },
    );
    this.commands = new SlackDmCommands(this.client, this.state, db, sessions, peers, {
      inject: (session, text) => this.injectDmMessage(session, text),
      councils: () => this.councils,
    });
    this.operations = new OperationResults(db);
    this.operations.delay = () => this.settings.delaySeconds * 1000;
    this.operations.wanted = (result) => {
      const settings = this.settingsFor(result.projectId);
      return SLACK_ENABLED && !this.client.stopped && (result.ok ? settings.idle : settings.waiting);
    };
    this.operations.onError = (cause) => this.logError(cause);
    this.operations.send = (result) => this.alerts.sendOperationResult(result, this.operations);
    if (!SLACK_ENABLED && !SLACK_WATCH_ENABLED) {
      this.unsubscribe = null;
      this.pollTimer = null;
      return;
    }
    this.state.load(db);
    this.state.markDirty();
    this.state.save();
    if (SLACK_ENABLED) {
      this.operations.restore();
      this.unsubscribe = sessions.onEvent((event) => this.onSessionEvent(event));
      peers.setSlackPoster((text) => this.client.postToDm(text));
    } else {
      // Watches without a bot token: messages can only be typed into their sessions.
      this.unsubscribe = null;
    }
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  private get settings(): SlackSettings {
    return this.settingsStore.current;
  }

  status(): SlackStatus {
    return { enabled: SLACK_ENABLED, watchEnabled: SLACK_WATCH_ENABLED, ...this.settings };
  }

  /** The machine's Slack settings as they apply to a project (its own Slack settings); null: outside any project. */
  settingsFor(projectId: string | null): SlackSettings {
    return projectSettings(this.settings, this.projectSlack(projectId));
  }

  private projectSlack(projectId: string | null): ProjectSlackSettings | null {
    return projectId === null ? null : (this.db.getProject(projectId)?.slackSettings ?? null);
  }

  private projectOf(sessionId: string): string | null {
    return this.db.getSession(sessionId)?.projectId ?? null;
  }

  /** null when the session's agent messages may be posted, otherwise why not. */
  agentMessagesRefusal(sessionId: string): string | null {
    const projectId = this.projectOf(sessionId);
    if (this.settingsFor(projectId).agentMessages) return null;
    return this.projectSlack(projectId) !== null
      ? 'Messages des agents désactivés pour ce projet dans ses réglages Slack'
      : 'Messages des agents désactivés dans les réglages Slack de Cerebro';
  }

  // Applies immediately; the file is written asynchronously (see settingsSaved).
  updateSettings(patch: Record<string, unknown>): SlackSettings | null {
    // Pending alerts may no longer be wanted: re-checked when their timer fires.
    const settings = this.settingsStore.update(patch);
    // The web UI shows the default delivery next to each watch.
    if (settings !== null) this.reportWatches();
    return settings;
  }

  // Resolves once the latest settings are on disk; rejects if that write failed.
  settingsSaved(): Promise<void> {
    return this.settingsStore.saved();
  }

  // 'queued': Slack is rate limited, the message is posted as soon as the window is over.
  async agentMessage(sessionId: string, kind: 'notify' | 'ask', text: string): Promise<'sent' | 'queued'> {
    if (!SLACK_ENABLED) throw new Error("Slack n'est pas configuré");
    return this.alerts.agentMessage(sessionId, kind, text);
  }

  /** Watches of every session, for the web UI: an empty list without the user token. */
  allWatches(): SlackWatchList {
    return {
      enabled: SLACK_WATCH_ENABLED,
      defaultDeliver: this.settings.watchDeliveryLive,
      botEnabled: SLACK_ENABLED,
      watches: [...this.state.watches.values()].flat(),
    };
  }

  /** Watches of the session, oldest first. */
  watchesFor(sessionId: string): SlackWatch[] {
    this.requireWatches();
    return [...(this.state.watches.get(sessionId) ?? [])];
  }

  /**
   * Watches a thread (or the top level of a channel) for the session, from now or `since`. Asked again, the same
   * watch is renewed: its lifetime starts over, a new label or delivery replaces the old one, and an earlier
   * `since` reads again from there.
   */
  addWatch(sessionId: string, request: WatchRequest): { watch: SlackWatch; renewed: boolean } {
    this.requireWatches();
    const { since, ...fields } = request;
    const watches = this.state.watches.get(sessionId) ?? [];
    const expiresAt = Date.now() + this.settings.watchTtlDays * DAY_MS;
    const existing = watches.find((watch) => watch.channel === fields.channel && watch.threadTs === fields.threadTs);
    if (existing !== undefined) {
      existing.expiresAt = expiresAt;
      if (fields.label !== undefined) existing.label = fields.label;
      if (fields.deliver !== undefined) existing.deliver = fields.deliver;
      if (since !== undefined && laterThan(existing.lastTs, since)) existing.lastTs = since;
      this.state.changed();
      this.reportWatches();
      return { watch: existing, renewed: true };
    }
    if (watches.length >= MAX_WATCHES_PER_SESSION)
      throw new WatchError(409, `Au plus ${MAX_WATCHES_PER_SESSION} surveillances par session : retire-en d'abord`);
    const watch = newWatch(
      { sessionId, ...fields, ...(since === undefined ? {} : { lastTs: since }) },
      this.settings.watchTtlDays,
    );
    this.state.watches.set(sessionId, [...watches, watch]);
    this.state.changed();
    this.reportWatches();
    return { watch, renewed: false };
  }

  /** Removes the session's watches named by `ref`: their id, thread timestamp, or channel for a top level. */
  removeWatches(sessionId: string, ref: string): SlackWatch[] {
    this.requireWatches();
    const watches = this.state.watches.get(sessionId) ?? [];
    const removed = watches.filter(
      (watch) => watch.id === ref || watch.threadTs === ref || (watch.threadTs === null && watch.channel === ref),
    );
    if (removed.length === 0) return [];
    const kept = watches.filter((watch) => !removed.includes(watch));
    if (kept.length === 0) this.state.watches.delete(sessionId);
    else this.state.watches.set(sessionId, kept);
    this.state.changed();
    this.reportWatches();
    return removed;
  }

  /** Sets the delivery of one watch, or (null) makes it follow the settings again; null when there is no such watch. */
  setWatchDelivery(sessionId: string, watchId: string, deliver: WatchDelivery[] | null): SlackWatch | null {
    this.requireWatches();
    const watch = this.state.watches.get(sessionId)?.find((candidate) => candidate.id === watchId);
    if (watch === undefined) return null;
    if (deliver === null) delete watch.deliver;
    else watch.deliver = deliver;
    this.state.changed();
    this.reportWatches();
    return watch;
  }

  /**
   * After the session posted through the Slack connector (PostToolUse), watches that thread so replies reach it
   * without a polling loop (`watchAutoOnPost`). A payload of an unexpected shape is only logged.
   */
  watchAfterPost(sessionId: string, payload: Record<string, unknown>): void {
    if (!SLACK_WATCH_ENABLED || !this.settings.watchAutoOnPost) return;
    const request = postedWatchRequest(payload);
    if (request === null) return;
    if (typeof request === 'string') {
      console.warn(`[slack] surveillance automatique ignorée : ${request}`);
      return;
    }
    try {
      this.addWatch(sessionId, request);
    } catch (error) {
      console.warn('[slack] surveillance automatique refusée :', error instanceof Error ? error.message : error);
    }
  }

  /** Throws the 503 of watches when the user token is missing. */
  requireWatches(): void {
    if (!SLACK_WATCH_ENABLED) throw new WatchError(503, SLACK_WATCH_UNCONFIGURED);
  }

  stop(): void {
    this.client.stopped = true;
    this.reader.stopped = true;
    this.operations.close();
    this.unsubscribe?.();
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.alerts.clearTimers();
  }

  private onSessionEvent(event: SessionEvent): void {
    this.alerts.onSessionEvent(event);
  }

  // Each token reads on its own budget and rate limit: the bot's poll and the watches run side by side.
  private async poll(): Promise<void> {
    await Promise.all([
      SLACK_ENABLED ? this.poller.poll() : undefined,
      SLACK_WATCH_ENABLED ? this.watcher.poll().finally(() => this.reportWatches()) : undefined,
    ]);
  }

  // Polls change watches in place (last message read, expiry): only a real change is reported.
  private reportWatches(): void {
    const signature = JSON.stringify(this.allWatches());
    if (signature === this.watchesSignature) return;
    this.watchesSignature = signature;
    this.onWatchesChange();
  }

  /** Cerebro's bot, asked once to Slack (auth.test), so watches skip its messages. */
  private cerebroBot(): Promise<BotIdentity | null> {
    if (!SLACK_ENABLED) return Promise.resolve(null);
    this.botIdentity ??= this.client.call('auth.test', {}).then(
      (response) => {
        const fields = response as Record<string, unknown>;
        return {
          userId: typeof fields.user_id === 'string' ? fields.user_id : null,
          botId: typeof fields.bot_id === 'string' ? fields.bot_id : null,
        };
      },
      (error: unknown) => {
        this.botIdentity = null;
        throw error;
      },
    );
    return this.botIdentity;
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
