import { randomUUID } from 'node:crypto';
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
import { OperationResults } from './operation-results.ts';
import { answerFactQuestion, FACT_HELP } from './facts.ts';
import { answerQuestion } from './ask.ts';
import type { CouncilRun } from './council.ts';
import type { CouncilRuns } from './council-runner.ts';
import type { Agent, CerebroDatabase, Project, Session } from './db.ts';
import { normalizeProjectName, type PeerSync } from './peers.ts';
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

// Le fil Slack reprend la session active la plus récemment touchée, pas la plus récemment créée.
function latestActive(sessions: Session[], agent: Agent | null = null): Session | undefined {
  return sessions
    .filter((session) => session.status !== 'exited' && (agent === null || session.agent === agent))
    .reduce<Session | undefined>(
      (best, session) => (best === undefined || session.updatedAt > best.updatedAt ? session : best),
      undefined,
    );
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
  // A message was sent from this thread: the end of the agent's turn is posted back into it.
  awaitingReply: boolean;
  // The message was queued behind a running turn unrelated to Slack: that turn's end is not the reply.
  skipTurnEnd: boolean;
  // Another message was queued while a reply was awaited: keep awaiting after relaying the next turn end.
  moreTurns: boolean;
  // Questions of the AskUserQuestion dialog this message shows: numeric replies are mapped onto them.
  questions: AgentQuestion[] | null;
  // Thread of a DM command: dropped when another machine takes the project over.
  fromDm: boolean;
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
    awaitingReply: value.awaitingReply === true,
    skipTurnEnd: value.skipTurnEnd === true,
    moreTurns: value.moreTurns === true,
    questions,
    fromDm: value.fromDm === true,
  };
}

function isKeyShortcut(text: string): boolean {
  return ['entrée', 'enter', 'échap', 'esc'].includes(text.toLocaleLowerCase('fr-FR'));
}

/** A message typed during a running turn is queued: only the turn it starts carries the reply. */
function armReply(thread: ActiveThread, queued: boolean): void {
  if (!queued) {
    thread.awaitingReply = true;
    thread.skipTurnEnd = false;
    thread.moreTurns = false;
  } else if (!thread.awaitingReply) {
    thread.awaitingReply = true;
    thread.skipTurnEnd = true;
  } else if (!thread.skipTurnEnd) {
    thread.moreTurns = true;
  }
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

export interface CouncilCommand {
  // null : council hors projet.
  projectName: string | null;
  question: string;
}

// `council: question` ou `projet/council: question` ; le mot-clé prime sur un projet nommé « council ».
export function parseCouncilCommand(text: string): CouncilCommand | null {
  const match = text.trim().match(/^(?:([^\s:/+]+(?:[ \-_.][^\s:/+]+)*?)\s*\/\s*)?council\s*:\s*([\s\S]+)$/i);
  if (match === null) return null;
  const projectName = match[1]?.trim();
  const question = match[2]?.trim() ?? '';
  if (question === '' || projectName === '') return null;
  return { projectName: projectName ?? null, question };
}

const COUNCIL_FAILURES: Record<CouncilRun['status'], string> = {
  running: 'en cours',
  succeeded: 'sans synthèse',
  failed: 'en échec',
  cancelled: 'annulé',
  interrupted: 'interrompu',
};

// Réponse du fil Slack : l'essentiel de la synthèse, le détail reste sur la page du run.
export function councilSlackText(run: CouncilRun, projectName: string | null): string {
  const link = `<${PUBLIC_URL.replace(/\/+$/, '')}/#/c/${encodeURIComponent(run.id)}|Ouvrir le rapport dans Cerebro>`;
  const scope = projectName === null ? 'hors projet' : `*${escapeMrkdwn(projectName)}*`;
  const synthesis = run.synthesis;
  if (run.status !== 'succeeded' || synthesis === null) {
    return `:x: Council ${scope} ${COUNCIL_FAILURES[run.status]} : ${escapeMrkdwn(run.error ?? 'aucune synthèse produite.')}\n${link}`;
  }
  return [
    `:busts_in_silhouette: Council ${scope}`,
    '',
    '*Recommandation*',
    slackMarkdown(synthesis.recommendation),
    '',
    '*Première action*',
    slackMarkdown(synthesis.firstAction),
    '',
    '*Accords*',
    slackMarkdown(synthesis.agreements),
    '',
    '*Désaccords*',
    slackMarkdown(synthesis.disagreements),
    '',
    link,
  ].join('\n');
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

// Converts the agent's Markdown to Slack mrkdwn; code spans and blocks are only escaped.
export function slackMarkdown(markdown: string): string {
  return markdown.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/).map((part, index) => {
    // Slack shows a fence's language tag as text, and requires entities even inside code.
    if (index % 2 === 1) return escapeMrkdwn(part.replace(/^```[\w+#.-]*\n/, '```\n'));
    return escapeMrkdwn(part)
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
      .replace(/^(\s*)[-*]\s+/gm, '$1• ');
  }).join('');
}

const SLACK_CHUNK = 3_500;

// Cuts an over-long line, preferring whitespace and never inside an entity or a `<url|text>` link.
function hardSplit(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > SLACK_CHUNK) {
    const window = rest.slice(0, SLACK_CHUNK);
    const space = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'));
    let cut = space >= SLACK_CHUNK / 2 ? space + 1 : SLACK_CHUNK;
    const head = rest.slice(0, cut);
    const openLink = head.lastIndexOf('<');
    if (openLink > head.lastIndexOf('>')) cut = openLink;
    else {
      const entity = /&[a-z]{0,3}$/.exec(head);
      if (entity) cut = entity.index;
    }
    // A single link longer than a chunk cannot stay whole: fall back to a plain cut.
    if (cut === 0) cut = SLACK_CHUNK;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}

// Slack truncates long messages: split on line breaks, keeping code blocks balanced.
export function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current === '' ? line : `${current}\n${line}`;
    if (candidate.length <= SLACK_CHUNK || current === '') {
      current = candidate;
      continue;
    }
    chunks.push(current);
    current = line;
  }
  if (current !== '') chunks.push(current);
  const balanced: string[] = [];
  let open = false;
  for (const chunk of chunks.flatMap(hardSplit)) {
    const prefix = open ? '```\n' : '';
    if (((chunk.match(/```/g) ?? []).length % 2) === 1) open = !open;
    balanced.push(`${prefix}${chunk}${open ? '\n```' : ''}`);
  }
  return balanced;
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

interface NotificationTurn {started_at:number;ended_at:number|null;custom_at:number|null;relayed_at:number|null;automatic_at:number|null;automatic_status:string|null}

export class SlackNotifier {
  readonly operations:OperationResults;
  private outgoing=new Map<string,Promise<void>>();
  private turn(sessionId:string):NotificationTurn|null{return this.db.connection.prepare('SELECT * FROM notification_turns WHERE session_id=?').get(sessionId) as NotificationTurn|undefined??null;}
  private markTurn(sessionId:string,column:'custom_at'|'relayed_at'|'automatic_at'):void{
    const session=this.db.getSession(sessionId);if(!session)return;
    this.db.connection.prepare('INSERT OR IGNORE INTO notification_turns (session_id,started_at) VALUES (?,?)').run(sessionId,session.createdAt);
    this.db.connection.prepare(`UPDATE notification_turns SET ${column}=? WHERE session_id=?`).run(Date.now(),sessionId);
    // Remembers which state was alerted: a repeated signal is skipped, a new one stays notifiable.
    if(column==='automatic_at')this.db.connection.prepare('UPDATE notification_turns SET automatic_status=? WHERE session_id=?').run(session.status,sessionId);
  }
  private serial(id:string,send:()=>Promise<void>):Promise<void>{
    const previous=this.outgoing.get(id)??Promise.resolve();const next=previous.catch(()=>{}).then(send);this.outgoing.set(id,next);
    void next.finally(()=>{if(this.outgoing.get(id)===next)this.outgoing.delete(id);}).catch(()=>{});return next;
  }

  private readonly sessions: SessionManager;
  private readonly db: CerebroDatabase;
  private readonly peers: PeerSync;
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
  // Branché par le serveur ; absent, `council:` répond que le council est indisponible.
  councils: CouncilRuns | null = null;

  constructor(sessions: SessionManager, db: CerebroDatabase, peers: PeerSync) {
    this.sessions = sessions;
    this.db = db;
    this.peers = peers;
    this.operations=new OperationResults(db);
    this.operations.delay=()=>this.settings.delaySeconds*1000;
    this.operations.wanted=result=>SLACK_ENABLED&&!this.stopped&&(result.ok?this.settings.idle:this.settings.waiting);
    this.operations.onError=cause=>this.logError(cause);
    this.operations.send=async result=>{
      await this.peers.ready;
      if(this.stopped)return false;
      // Les résultats hors projet restent locaux : leur machine d’origine les notifie.
      // L’élection du répondeur général ne déduplique que les commandes entrantes.
      const project=result.projectId===null?null:this.db.getProject(result.projectId);
      if(result.projectId!==null&&(!project||!this.peers.owns(project.name)))return false;
      const councilId=result.kind==='council'?result.id.replace(/^council:/,''):null;
      const link=councilId!==null?`#/c/${encodeURIComponent(councilId)}`:project?`#/p/${encodeURIComponent(project.id)}`:'#/';
      const text=`${result.ok?':white_check_mark:':':x:'} *${escapeMrkdwn(project?.name??'Hors projet')}* — ${result.kind} : ${escapeMrkdwn(result.summary)}\nDurée : ${Math.max(0,Math.round((result.finishedAt-result.startedAt)/1000))} s\n<${PUBLIC_URL.replace(/\/+$/,'')}/${link}|Ouvrir dans Cerebro>`;
      let sent=false;
      const send=async():Promise<void>=>{
        // Recheck after peer coordination and any pending send in this session.
        if(this.stopped)return;
        const current=this.operations.get(result.id);if(this.stopped||current?.seenAt||current?.notifiedAt||!this.operations.wanted(result))return;
        const thread=result.sessionId?this.threads.get(result.sessionId):undefined;
        if(thread)await this.postThreadReply(thread.channel,thread.ts,text);
        else await this.slackApi('chat.postMessage',{channel:await this.openDm(),text,unfurl_links:false});
        sent=true;
      };
      await this.serial(result.sessionId??`operation:${result.id}`,send);
      return sent;
    };
    if (!SLACK_ENABLED) {
      this.unsubscribe = null;
      this.pollTimer = null;
      return;
    }
    this.operations.restore();
    this.loadState();
    this.stateDirty = true;
    this.saveState();
    this.unsubscribe = sessions.onEvent((event) => this.onSessionEvent(event));
    peers.setSlackPoster(async (text) => {
      await this.slackApi('chat.postMessage', { channel: await this.openDm(), text, unfurl_links: false });
    });
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
    this.markTurn(sessionId,'custom_at');
    const pending=this.timers.get(sessionId);if(pending)clearTimeout(pending);this.timers.delete(sessionId);
    const header = this.header(session);
    const suffix = kind === 'ask'
      ? `\n${this.sessionLink(session.id)}\n_Réponds dans le fil : ta réponse sera envoyée à l'agent._`
      : `\n${this.sessionLink(session.id)}`;
    const message = `${kind === 'ask' ? ':question:' : ':bell:'} ${header}\n${text}${suffix}`;
    await this.serial(session.id,async()=>{
      if(this.stopped)return;
      const thread=this.threads.get(session.id);
      if(kind==='notify'&&thread&&(this.turn(session.id)?.automatic_at||thread.kind==='ask'&&!thread.answered))await this.postThreadReply(thread.channel,thread.ts,message);
      else await this.postSessionMessage(session.id,kind,message);
    });
  }

  stop(): void {
    this.stopped = true;
    this.operations.close();
    this.unsubscribe?.();
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private onSessionEvent(event: SessionEvent): void {
    if(event.type==='session'){
      const session=event.session;const turn=this.turn(session.id);
      if(session.status==='running'&&(!turn||turn.ended_at!==null))this.db.connection.prepare('INSERT INTO notification_turns (session_id,started_at) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET started_at=excluded.started_at,ended_at=NULL,custom_at=NULL,relayed_at=NULL,automatic_at=NULL,automatic_status=NULL').run(session.id,session.updatedAt);
      // Work resumed within the turn (permission answered…): the next waiting or the final idle is a new alert.
      else if(session.status==='running'&&turn?.automatic_status!=null)this.db.connection.prepare('UPDATE notification_turns SET automatic_status=NULL WHERE session_id=?').run(session.id);
      if(session.status==='idle'&&turn&&turn.ended_at===null)this.db.connection.prepare('UPDATE notification_turns SET ended_at=? WHERE session_id=?').run(Date.now(),session.id);
    }
    if (event.type === 'session-deleted') {
      const timer = this.timers.get(event.id);
      if (timer !== undefined) clearTimeout(timer);
      this.timers.delete(event.id);
      if (this.threads.delete(event.id)) this.stateChanged();
      return;
    }
    if (event.type === 'turn-complete') {
      this.db.connection.prepare('UPDATE notification_turns SET ended_at=COALESCE(ended_at,?) WHERE session_id=?').run(Date.now(),event.id);
      this.relayTurnEnd(event.id, event.message);
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

  private relayTurnEnd(sessionId: string, message: string | null): void {
    const thread = this.threads.get(sessionId);
    if (thread === undefined || !thread.awaitingReply) return;
    if (thread.skipTurnEnd) {
      thread.skipTurnEnd = false;
      this.stateChanged();
      return;
    }
    if (thread.moreTurns) thread.moreTurns = false;
    else thread.awaitingReply = false;
    this.markTurn(sessionId,'relayed_at');
    this.stateChanged();
    // The answer itself lands in the thread: the "turn complete" alert would only repeat it.
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(sessionId);
    const text = message !== null && message.trim() !== ''
      ? slackMarkdown(message)
      : `\`\`\`\n${safeCodeBlock((this.sessions.screenText(sessionId, 30) ?? []).join('\n').slice(-3_000))}\n\`\`\``;
    void this.serial(sessionId,async () => {
      for (const chunk of splitMessage(text)) await this.postThreadReply(thread.channel, thread.ts, chunk);
    }).catch((error: unknown) => this.logError(error));
  }

  private async sendAutomaticAlert(sessionId: string): Promise<void> {
    await this.serial(sessionId,()=>this.deliverAutomaticAlert(sessionId));
  }
  private async deliverAutomaticAlert(sessionId: string): Promise<void> {
    if (this.stopped) return;
    const session = this.db.getSession(sessionId);
    if (session === null || !session.attention || (session.status !== 'waiting' && session.status !== 'idle')) return;
    if (!this.alertWanted(session.status)) return;
    const turn=this.turn(sessionId);
    if(turn&&(turn.automatic_status===session.status||session.status==='idle'&&(turn.custom_at!==null||turn.relayed_at!==null)))return;
    // The agent just asked a question and ended its turn: keep its thread as the one to answer.
    const thread = this.threads.get(sessionId);
    if (thread?.kind === 'ask' && !thread.answered) return;
    const questions = session.status === 'waiting' ? this.sessions.pendingQuestions(session.id) : null;
    if (questions !== null) {
      const message = `:question: ${this.header(session)}\n${formatQuestions(questions)}\n${this.sessionLink(session.id)}`;
      await this.postSessionMessage(session.id, 'alert', message, questions);
      this.markTurn(sessionId,'automatic_at');
      return;
    }
    const icon = session.status === 'waiting' ? ':raised_hand:' : ':white_check_mark:';
    const label = session.status === 'waiting' ? 'En attente' : 'Tour terminé';
    const reason = escapeMrkdwn(session.attentionReason ?? (session.status === 'waiting' ? 'Confirmation requise' : 'Tour terminé'));
    const screen = safeCodeBlock((this.sessions.screenText(session.id, 15) ?? []).join('\n').slice(-2_500));
    const duration=turn?` · durée du tour : ${Math.max(0,Math.round(((turn.ended_at??Date.now())-turn.started_at)/1000))} s`:'';
    const message = `${icon} ${this.header(session)}${duration}\n*${label} :* ${reason}\n\`\`\`\n${screen}\n\`\`\`\n${this.sessionLink(session.id)} · réponds dans le fil pour écrire dans la session`;
    await this.postSessionMessage(session.id, 'alert', message);
    this.markTurn(sessionId,'automatic_at');
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
      awaitingReply: false,
      skipTurnEnd: false,
      moreTurns: false,
      questions,
      fromDm: false,
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
        // Another machine took the project over: its commands, and their threads, are now its own.
        const project = this.db.getProject(session.projectId);
        if (thread.fromDm && project !== null && !this.peers.owns(project.name)) {
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
    await this.peers.ready;
    // Machines sharing the DM: a single one handles commands that target no project.
    const general = this.peers.generalResponder();
    if (shortcut === 'help' || shortcut === 'aide' || shortcut === '?') {
      if (!general) return;
      await this.postThreadReply(channel, message.ts, this.helpText());
      return;
    }
    if (shortcut === 'list' || shortcut === 'liste' || shortcut === 'projets') {
      if (!general) return;
      await this.postThreadReply(channel, message.ts, this.projectListText());
      return;
    }
    const question = text.match(/^\?\s*([\s\S]+)$/)?.[1]?.trim();
    if (question !== undefined && question !== '') {
      // Answered with the state of the other machines it can reach.
      if (!general) return;
      // The answer can take minutes: thread polling must not wait for it.
      void this.answerDmQuestion(channel, message.ts, question);
      return;
    }
    const council = parseCouncilCommand(text);
    if (council !== null) {
      const project = council.projectName === null ? null : await this.dmProject(channel, message.ts, council.projectName, general);
      if (council.projectName === null ? !general : project === null) return;
      // Several minutes of headless calls: thread polling must not wait for them.
      void this.answerDmCouncil(channel, message.ts, project, council.question);
      return;
    }
    const command = parseDmCommand(text);
    if (command === null) {
      if (!general) return;
      await this.postThreadReply(channel, message.ts, this.helpText('Message non reconnu.'));
      return;
    }
    const project = await this.dmProject(channel, message.ts, command.projectName, general);
    if (project === null) return;
    let session = command.forceNew ? undefined : latestActive(this.db.listProjectSessions(project.id), command.agent);
    const created = session === undefined;
    const queued = session?.status === 'running';
    if (session === undefined) {
      try {
        session = await this.sessions.create(project, {
          ...(command.agent === null ? {} : { agent: command.agent }),
          prompt: command.text,
        }, undefined, undefined, undefined, { rememberDefaults: false });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.postThreadReply(channel, message.ts, `:x: Impossible de créer la session : ${escapeMrkdwn(reason)}`);
        return;
      }
    } else if (!await this.injectDmMessage(session, command.text)) {
      await this.postThreadReply(channel, message.ts, 'Session inactive : message non transmis.');
      return;
    }
    // Slack instructions belong to the session; preserve the web form's prompt.
    if (command.agent !== null) {
      this.sessions.rememberDefaults(project.id, { agent: command.agent });
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
      awaitingReply: true,
      skipTurnEnd: queued,
      moreTurns: false,
      questions: null,
      fromDm: true,
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

  /** Project targeted by a DM command; null when this machine does not handle it (any error reply is posted). */
  private async dmProject(channel: string, threadTs: string, projectName: string, general: boolean): Promise<Project | null> {
    const projects = this.db.listProjects();
    const normalizedName = normalizeProjectName(projectName);
    const exact = projects.filter((project) => normalizeProjectName(project.name) === normalizedName);
    // An exact name on another machine beats a prefix match here; that machine handles it.
    if (exact.length === 0 && this.peers.knownRemotely(projectName, true)) return null;
    const matches = exact.length > 0
      ? exact
      : projects.filter((project) => normalizeProjectName(project.name).startsWith(normalizedName));
    // Handled by the machine that has this project: no "unknown project" reply from this one.
    if (matches.length === 0 && this.peers.knownRemotely(projectName, false)) return null;
    if (matches.length !== 1) {
      // Unknown everywhere: a single machine says so. An ambiguous prefix is only ambiguous here.
      if (matches.length === 0 && !general) return null;
      const error = matches.length === 0
        ? `Projet introuvable : « ${projectName} ».`
        : `Nom de projet ambigu : « ${projectName} ».`;
      await this.postThreadReply(channel, threadTs, this.helpText(error));
      return null;
    }
    const project = matches[0];
    if (project === undefined) return null;
    const conflicts = this.peers.conflictMachines(project);
    if (conflicts.length > 0) {
      // Same name, other repository: nothing runs until one project is renamed; a single machine says so.
      if (this.peers.conflictResponder(project)) {
        await this.postThreadReply(channel, threadTs, `:no_entry: « ${escapeMrkdwn(project.name)} » existe aussi sur ${escapeMrkdwn(conflicts.join(', '))} avec un autre dépôt git : commande bloquée. Renomme l'un des deux projets.`);
      }
      return null;
    }
    // Another machine has the Slack lead on this shared project.
    return this.peers.owns(project.name) ? project : null;
  }

  /** `council: question`: headless council run, its synthesis posted in the request thread. */
  private async answerDmCouncil(channel: string, threadTs: string, project: Project | null, question: string): Promise<void> {
    await this.slackApi('reactions.add', { channel, timestamp: threadTs, name: 'hourglass_flowing_sand' })
      .catch((error: unknown) => this.logError(error));
    let text: string;
    try {
      if (this.councils === null) throw new Error('council indisponible sur cette machine.');
      // readProject absent : valeur des réglages effectifs du projet.
      const run = await this.councils.start({ projectId: project?.id ?? null, origin: 'slack', question }, randomUUID());
      text = councilSlackText(await this.councils.finished(run.id) ?? run, project?.name ?? null);
    } catch (error) {
      this.logError(error);
      text = `:x: Council impossible : ${escapeMrkdwn(error instanceof Error ? error.message : String(error))}`;
    }
    try {
      for (const chunk of splitMessage(text)) await this.postThreadReply(channel, threadTs, chunk);
    } catch (error) {
      this.logError(error);
    }
    await this.slackApi('reactions.remove', { channel, timestamp: threadTs, name: 'hourglass_flowing_sand' })
      .catch((error: unknown) => this.logError(error));
  }

  /** `? question`: free-form question answered by Claude from Cerebro's state. */
  private async answerDmQuestion(channel: string, threadTs: string, question: string): Promise<void> {
    await this.slackApi('reactions.add', { channel, timestamp: threadTs, name: 'hourglass_flowing_sand' })
      .catch((error: unknown) => this.logError(error));
    let text: string;
    try {
      const factual = await answerFactQuestion(this.db, question);
      text = slackMarkdown(factual ?? await answerQuestion(this.db, question));
    } catch (error) {
      this.logError(error);
      text = `:x: Impossible de répondre : ${escapeMrkdwn(error instanceof Error ? error.message : String(error))}`;
    }
    try {
      for (const chunk of splitMessage(text)) await this.postThreadReply(channel, threadTs, chunk);
    } catch (error) {
      this.logError(error);
    }
    await this.slackApi('reactions.remove', { channel, timestamp: threadTs, name: 'hourglass_flowing_sand' })
      .catch((error: unknown) => this.logError(error));
  }

  private async postThreadReply(channel: string, threadTs: string, text: string): Promise<void> {
    await this.slackApi('chat.postMessage', {
      channel,
      thread_ts: threadTs,
      text,
      unfurl_links: false,
    });
  }

  private projectLines(): string[] {
    const lines = this.db.listProjects().map((project) => {
      const active = latestActive(this.db.listProjectSessions(project.id));
      const detail = active === undefined
        ? '_aucune session active_'
        : `${escapeMrkdwn(active.title)} (${active.agent}, statut : ${active.status})`;
      return `• *${escapeMrkdwn(project.name)}* — ${detail}`;
    });
    // A single machine answers `list`: projects only present on the other active machines are shown too.
    const local = new Set(this.db.listProjects().map((project) => normalizeProjectName(project.name)));
    for (const remote of this.peers.activePeerProjects()) {
      if (local.has(normalizeProjectName(remote.name))) continue;
      local.add(normalizeProjectName(remote.name));
      lines.push(`• *${escapeMrkdwn(remote.name)}* — _sur ${escapeMrkdwn(remote.machine)}_`);
    }
    return lines.length > 0 ? lines : ['_Aucun projet configuré._'];
  }

  private projectListText(): string {
    return ['*Projets connus*', ...this.projectLines()].join('\n');
  }

  private helpText(error?: string): string {
    return [
      ...(error === undefined ? [] : [`:warning: ${escapeMrkdwn(error)}`, '']),
      '*Piloter Cerebro depuis Slack*',
      '`projet: instruction` — reprendre la session active, ou en créer une',
      '`projet+: instruction` — toujours créer une nouvelle session',
      '`projet/agent: instruction` — choisir `claude`, `codex` ou `grok`',
      '`projet/agent+: instruction` — choisir l’agent et créer une nouvelle session',
      '`council: question` — réunir le council de LLM hors projet (synthèse dans le fil)',
      '`projet/council: question` — réunir le council sur un projet, avec ses réglages (lecture du dépôt comprise)',
      '`list` — lister les projets et leur session active',
      '`? question` — poser une question sur les projets, sessions et backlogs (ex. `? où en sont les tâches du projet ACME ?`)',
      '',
      FACT_HELP,
      '*Projets connus*',
      ...this.projectLines(),
      '',
      '*Répondre dans un fil de session*',
      'Le texte libre est injecté dans la session. `entrée`/`enter` envoie Entrée ; `échap`/`esc` envoie Échap.',
      'Pendant une confirmation, réponds avec un chiffre, `y` ou `n`. Pour les questions à options : `1`, `1 3` ou `1,3`.',
      '',
      '_Les nouvelles sessions reprennent les réglages du projet (agent, modèle, effort et mode). L’instruction du message sert de prompt._',
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
      const queued = this.db.getSession(sessionId)?.status === 'running' && !isKeyShortcut(text);
      const transmitted = thread.questions !== null
        ? await this.answerQuestions(sessionId, thread, text)
        : await this.injectReply(sessionId, thread.kind, text);
      if (transmitted) {
        thread.answered = true;
        armReply(thread, queued);
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
    // Single-key shortcut for menus/confirmations; a reply to a free-text question stays a message.
    if (session.status === 'waiting' && kind !== 'ask' && /^[0-9yYnN]$/.test(text)) {
      return this.sessions.writeInput(sessionId, text);
    }
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
