import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DATA_DIR,
  PUBLIC_URL,
  SLACK_ALERTS,
  SLACK_API_URL,
  SLACK_DELAY_MS,
  SLACK_ENABLED,
  SLACK_TOKEN,
  SLACK_USER,
} from './config.ts';
import type { Agent, CerebroDatabase, Session } from './db.ts';
import { formatQuestions, interpretAnswer } from './questions.ts';
import type { AgentQuestion } from './questions.ts';
import type { SessionEvent, SessionManager } from './sessions.ts';

type MessageKind = 'alert' | 'notify' | 'ask';

// Notification preferences editable from the web UI; env variables only provide the defaults.
export interface SlackSettings {
  waiting: boolean;
  idle: boolean;
  agentMessages: boolean;
  delaySeconds: number;
}

const SETTINGS_FILE = join(DATA_DIR, 'slack.json');
const STATE_FILE = join(DATA_DIR, 'slack-state.json');
const MAX_DELAY_SECONDS = 3_600;

function defaultSettings(): SlackSettings {
  const delaySeconds = SLACK_DELAY_MS / 1_000;
  return {
    waiting: SLACK_ALERTS !== 'off',
    idle: SLACK_ALERTS === 'all',
    agentMessages: true,
    delaySeconds: Number.isFinite(delaySeconds) && delaySeconds >= 0 ? delaySeconds : 30,
  };
}

function validDelay(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DELAY_SECONDS;
}

// Applies the valid fields of an untrusted patch; returns null when a present field is invalid.
export function mergeSettings(base: SlackSettings, patch: Record<string, unknown>): SlackSettings | null {
  const next = { ...base };
  for (const key of ['waiting', 'idle', 'agentMessages'] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (typeof value !== 'boolean') return null;
    next[key] = value;
  }
  if ('delaySeconds' in patch) {
    if (!validDelay(patch.delaySeconds)) return null;
    next.delaySeconds = Math.round(patch.delaySeconds);
  }
  return next;
}

function loadSettings(): SlackSettings {
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

interface ActiveThread {
  channel: string;
  ts: string;
  lastTs: string;
  kind: MessageKind;
  createdAt: number;
  polledAt: number;
  answered: boolean;
  // Questions of the AskUserQuestion dialog this message shows: numeric replies are mapped onto them.
  questions: AgentQuestion[] | null;
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
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
}

interface DmCommand {
  projectName: string;
  agent: Agent | null;
  forceNew: boolean;
  text: string;
}

const POLL_INTERVAL_MS = 5_000;
const THREAD_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
// conversations.replies is rate limited (~50/min): poll fresh threads often, older ones rarely.
const FRESH_THREAD_MS = 10 * 60 * 1_000;
const SLOW_POLL_INTERVAL_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentQuestion(value: unknown): value is AgentQuestion {
  if (!isRecord(value) || typeof value.question !== 'string') return false;
  if (value.header !== null && typeof value.header !== 'string') return false;
  if (typeof value.multiSelect !== 'boolean' || !Array.isArray(value.options)) return false;
  return value.options.every((option) => isRecord(option)
    && typeof option.label === 'string'
    && (option.description === null || typeof option.description === 'string')
    && (option.preview === null || typeof option.preview === 'string'));
}

function isSlackTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
}

function activeThreadFrom(value: unknown): ActiveThread | null {
  if (!isRecord(value)
    || typeof value.channel !== 'string'
    || value.channel === ''
    || !isSlackTimestamp(value.ts)
    || !isSlackTimestamp(value.lastTs)
    || !['alert', 'notify', 'ask'].includes(typeof value.kind === 'string' ? value.kind : '')
    || typeof value.createdAt !== 'number'
    || !Number.isFinite(value.createdAt)
    || typeof value.polledAt !== 'number'
    || !Number.isFinite(value.polledAt)
    || typeof value.answered !== 'boolean') return null;
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
    questions,
  };
}

function messageFrom(value: unknown): SlackMessage | null {
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

function parseDmCommand(text: string): DmCommand | null {
  const match = text.match(/^([^\s:/+]+(?:[ \-_.][^\s:/+]+)*?)\s*(?:\/(claude|codex|grok))?\s*(\+)?\s*:\s*([\s\S]+)$/);
  if (match === null) return null;
  const projectName = match[1]?.trim() ?? '';
  const agent = match[2];
  const prompt = match[4]?.trim() ?? '';
  if (projectName === '' || prompt === '') return null;
  return {
    projectName,
    agent: agent === 'claude' || agent === 'codex' || agent === 'grok' ? agent : null,
    forceNew: match[3] !== undefined,
    text: prompt,
  };
}

function normalizeProjectName(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLocaleLowerCase('fr-FR');
}

function slackTimestampNow(): string {
  return (Date.now() / 1_000).toFixed(6);
}

function sameQuestions(left: AgentQuestion[] | null, right: AgentQuestion[]): boolean {
  return left === right || (left !== null && JSON.stringify(left) === JSON.stringify(right));
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
  private dmCursor = slackTimestampNow();
  private stateDirty = false;
  private settings: SlackSettings = loadSettings();

  constructor(sessions: SessionManager, db: CerebroDatabase) {
    this.sessions = sessions;
    this.db = db;
    if (!SLACK_ENABLED) {
      this.unsubscribe = null;
      this.pollTimer = null;
      return;
    }
    this.loadState();
    this.stateDirty = true;
    this.saveState();
    this.unsubscribe = sessions.onEvent((event) => this.onSessionEvent(event));
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
    writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
    this.settings = next;
    // Pending alerts may no longer be wanted: re-checked when their timer fires.
    return next;
  }

  private alertWanted(status: Session['status']): boolean {
    return status === 'waiting' ? this.settings.waiting : status === 'idle' && this.settings.idle;
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
  }

  private onSessionEvent(event: SessionEvent): void {
    if (event.type === 'session-deleted') {
      const timer = this.timers.get(event.id);
      if (timer !== undefined) clearTimeout(timer);
      this.timers.delete(event.id);
      if (this.threads.delete(event.id)) this.stateChanged();
      return;
    }
    if (event.type !== 'alert' || !this.alertWanted(event.session.status)) return;
    const previous = this.timers.get(event.session.id);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(event.session.id);
      void this.sendAutomaticAlert(event.session.id).catch((error: unknown) => this.logError(error));
    }, this.settings.delaySeconds * 1_000);
    timer.unref();
    this.timers.set(event.session.id, timer);
  }

  private async sendAutomaticAlert(sessionId: string): Promise<void> {
    if (this.stopped) return;
    const session = this.db.getSession(sessionId);
    if (session === null || !session.attention || (session.status !== 'waiting' && session.status !== 'idle')) return;
    if (!this.alertWanted(session.status)) return;
    // The agent just asked a question and ended its turn: keep its thread as the one to answer.
    const thread = this.threads.get(sessionId);
    if (thread?.kind === 'ask' && !thread.answered) return;
    const questions = session.status === 'waiting' ? this.sessions.pendingQuestions(session.id) : null;
    if (questions !== null) {
      const message = `:question: ${this.header(session)}\n${formatQuestions(questions)}\n${this.sessionLink(session.id)}`;
      await this.postSessionMessage(session.id, 'alert', message, questions);
      return;
    }
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

  private async postSessionMessage(
    sessionId: string,
    kind: MessageKind,
    text: string,
    questions: AgentQuestion[] | null = null,
  ): Promise<void> {
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
      questions,
    });
    this.stateChanged();
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
    if (this.stopped || this.polling || Date.now() < this.rateLimitedUntil) return;
    this.polling = true;
    try {
      try {
        await this.pollDm();
      } catch (error) {
        this.logError(error);
      }
      for (const [sessionId, thread] of [...this.threads]) {
        if (this.stopped || Date.now() < this.rateLimitedUntil) break;
        const session = this.db.getSession(sessionId);
        if (session === null || session.status === 'exited' || Date.now() - thread.createdAt >= THREAD_MAX_AGE_MS) {
          this.threads.delete(sessionId);
          this.stateDirty = true;
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
      this.saveState();
      this.polling = false;
    }
  }

  private async pollDm(): Promise<void> {
    const channel = await this.openDm();
    const response = await this.slackApi('conversations.history', {
      channel,
      oldest: this.dmCursor,
      limit: 50,
    });
    const messages = (response.messages ?? [])
      .map(messageFrom)
      .filter((message): message is SlackMessage => message !== null && laterThan(message.ts, this.dmCursor))
      .sort((left, right) => laterThan(left.ts, right.ts) ? 1 : laterThan(right.ts, left.ts) ? -1 : 0);
    for (const message of messages) {
      this.dmCursor = message.ts;
      this.stateDirty = true;
      if (message.user !== SLACK_USER
        || message.bot_id !== undefined
        || message.subtype !== undefined
        || (message.thread_ts !== undefined && message.thread_ts !== message.ts)) continue;
      try {
        await this.handleDmMessage(channel, message);
      } catch (error) {
        this.logError(error);
      }
    }
  }

  private async handleDmMessage(channel: string, message: SlackMessage): Promise<void> {
    const text = decodeSlackText(message.text ?? '');
    const shortcut = text.toLocaleLowerCase('fr-FR');
    if (shortcut === 'help' || shortcut === 'aide' || shortcut === '?') {
      await this.postThreadReply(channel, message.ts, this.helpText());
      return;
    }
    const command = parseDmCommand(text);
    if (command === null) {
      await this.postThreadReply(channel, message.ts, this.helpText('Message non reconnu.'));
      return;
    }
    const projects = this.db.listProjects();
    const normalizedName = normalizeProjectName(command.projectName);
    const exact = projects.filter((project) => normalizeProjectName(project.name) === normalizedName);
    const matches = exact.length > 0
      ? exact
      : projects.filter((project) => normalizeProjectName(project.name).startsWith(normalizedName));
    if (matches.length !== 1) {
      const error = matches.length === 0
        ? `Projet introuvable : « ${command.projectName} ».`
        : `Nom de projet ambigu : « ${command.projectName} ».`;
      await this.postThreadReply(channel, message.ts, this.helpText(error));
      return;
    }
    const project = matches[0];
    if (project === undefined) return;
    let session = command.forceNew ? undefined : this.db.listProjectSessions(project.id)
      .find((candidate) => candidate.status !== 'exited'
        && (command.agent === null || candidate.agent === command.agent));
    const created = session === undefined;
    if (session === undefined) {
      try {
        session = await this.sessions.create(project, command.agent ?? 'claude', 'auto', command.text);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.postThreadReply(channel, message.ts, `:x: Impossible de créer la session : ${escapeMrkdwn(reason)}`);
        return;
      }
    } else if (!await this.injectDmMessage(session, command.text)) {
      await this.postThreadReply(channel, message.ts, 'Session inactive : message non transmis.');
      return;
    }
    const response = await this.slackApi('chat.postMessage', {
      channel,
      thread_ts: message.ts,
      text: `:arrow_right: ${this.header(session)} — ${created ? 'nouvelle session' : 'session existante'}\n${this.sessionLink(session.id)}`,
      unfurl_links: false,
    });
    if (typeof response.ts !== 'string') throw new Error('Réponse chat.postMessage sans timestamp');
    this.threads.set(session.id, {
      channel,
      ts: message.ts,
      lastTs: response.ts,
      kind: 'notify',
      createdAt: Date.now(),
      polledAt: Date.now(),
      answered: false,
      questions: null,
    });
    this.stateDirty = true;
    try {
      await this.slackApi('reactions.add', {
        channel,
        timestamp: message.ts,
        name: 'white_check_mark',
      });
    } catch (error) {
      this.logError(error);
    }
  }

  private async postThreadReply(channel: string, threadTs: string, text: string): Promise<void> {
    await this.slackApi('chat.postMessage', {
      channel,
      thread_ts: threadTs,
      text,
      unfurl_links: false,
    });
  }

  private helpText(error?: string): string {
    const projects = this.db.listProjects();
    const projectLines = projects.map((project) => {
      const active = this.db.listProjectSessions(project.id).find((session) => session.status !== 'exited');
      const detail = active === undefined
        ? '_aucune session active_'
        : `${escapeMrkdwn(active.title)} (${active.agent}, statut : ${active.status})`;
      return `• *${escapeMrkdwn(project.name)}* — ${detail}`;
    });
    return [
      ...(error === undefined ? [] : [`:warning: ${escapeMrkdwn(error)}`, '']),
      '*Piloter Cerebro depuis Slack*',
      '`projet: instruction` — reprendre la session active, ou en créer une',
      '`projet+: instruction` — toujours créer une nouvelle session',
      '`projet/agent: instruction` — choisir `claude`, `codex` ou `grok`',
      '`projet/agent+: instruction` — choisir l’agent et créer une nouvelle session',
      '',
      '*Projets connus*',
      ...(projectLines.length > 0 ? projectLines : ['_Aucun projet configuré._']),
      '',
      '*Répondre dans un fil de session*',
      'Le texte libre est injecté dans la session. `entrée`/`enter` envoie Entrée ; `échap`/`esc` envoie Échap.',
      'Pendant une confirmation, réponds avec un chiffre, `y` ou `n`. Pour les questions à options : `1`, `1 3` ou `1,3`.',
      '',
      '_Les sessions créées depuis Slack utilisent le mode auto._',
    ].join('\n');
  }

  private async injectDmMessage(session: Session, text: string): Promise<boolean> {
    if (session.status === 'exited') return false;
    const questions = session.status === 'waiting' ? this.sessions.pendingQuestions(session.id) : null;
    if (questions !== null) {
      if (!this.sessions.writeInput(session.id, '\x1b')) return false;
      this.sessions.setPendingQuestions(session.id, null);
      await delay(800);
    }
    if (!this.sessions.writeInput(session.id, `[Message Slack] ${text}`)) return false;
    await delay(150);
    return this.sessions.writeInput(session.id, '\r');
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
      this.stateDirty = true;
      if (message.user !== SLACK_USER || message.bot_id !== undefined || message.text === undefined) continue;
      const text = decodeSlackText(message.text);
      const transmitted = thread.questions !== null
        ? await this.answerQuestions(sessionId, thread, text)
        : await this.injectReply(sessionId, thread.kind, text);
      if (transmitted) {
        thread.answered = true;
        this.stateDirty = true;
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

  /**
   * The dialog is dismissed (Esc) and the answer typed as the next prompt: driving the multi-tab
   * dialog key by key would break as soon as its layout changes.
   */
  private async answerQuestions(sessionId: string, thread: ActiveThread, text: string): Promise<boolean> {
    const questions = thread.questions ?? [];
    const shortcut = text.toLocaleLowerCase('fr-FR');
    if (['entrée', 'enter', 'échap', 'esc'].includes(shortcut)) return this.injectReply(sessionId, thread.kind, text);
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
    const prefix = dialogOpen ? '[Réponse Slack à tes questions, le dialogue a été fermé]' : '[Réponse Slack à tes questions]';
    if (!this.sessions.writeInput(sessionId, `${prefix} ${answer}`)) return false;
    await delay(150);
    if (!this.sessions.writeInput(sessionId, '\r')) return false;
    // Later replies in this thread are ordinary messages.
    thread.questions = null;
    this.stateDirty = true;
    if (interpreted !== null) {
      await this.slackApi('chat.postMessage', {
        channel: thread.channel,
        thread_ts: thread.ts,
        text: `Transmis : ${escapeMrkdwn(interpreted)}`,
        unfurl_links: false,
      }).catch((error: unknown) => this.logError(error));
    }
    return true;
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

  private loadState(): void {
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
      if (!isRecord(value.threads)) {
        if (value.threads !== undefined) this.logError('état Slack invalide : fils ignorés');
        return;
      }
      for (const [sessionId, rawThread] of Object.entries(value.threads)) {
        const thread = activeThreadFrom(rawThread);
        if (thread === null) {
          this.logError(`état Slack invalide : fil ${sessionId} ignoré`);
          continue;
        }
        const session = this.db.getSession(sessionId);
        if (session === null || session.status === 'exited' || Date.now() - thread.createdAt >= THREAD_MAX_AGE_MS) continue;
        this.threads.set(sessionId, thread);
      }
    } catch (error) {
      this.logError(error);
    }
  }

  private stateChanged(): void {
    this.stateDirty = true;
    if (!this.polling) this.saveState();
  }

  private saveState(): void {
    if (!this.stateDirty) return;
    try {
      writeFileSync(STATE_FILE, `${JSON.stringify({
        dmCursor: this.dmCursor,
        threads: Object.fromEntries(this.threads),
      }, null, 2)}\n`);
      this.stateDirty = false;
    } catch (error) {
      this.logError(error);
    }
  }

  private logError(error: unknown): void {
    console.error('[slack]', error instanceof Error ? error.message : error);
  }
}
