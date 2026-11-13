import { existsSync, globSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  GEMINI_QUESTION_TOOL,
  getGeminiHookSettings,
  getGeminiSessionInjection,
  getGrokHookSettings,
} from './agents.ts';
import { codexHome } from './codex-config.ts';
import { parseQuestions } from './questions.ts';
import type { SessionManager } from './sessions.ts';
import { findTranscript, geminiHome } from './transcripts.ts';
import type { Agent, AttentionDetail } from '../shared/types.ts';
import { ignoreEnoent, isRecord } from './util.ts';

type HookPayload = Record<string, unknown>;

function stringField(payload: HookPayload, ...names: string[]): string | null {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

// Assez pour lire une commande ou un message dans une liste, sans transporter un rapport entier.
const SUMMARY_MAX = 400;
const TURN_MESSAGE_MAX = 600;

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Ce que l'outil va faire, en une ligne lisible : commande Bash, fichier modifié, URL lue. */
export function summarizeToolUse(tool: string | null, input: unknown): string | null {
  if (!isRecord(input)) return null;
  const field = (name: string): string | null => {
    const value = input[name];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  };
  const summary =
    tool === 'Bash'
      ? field('command')
      : (field('file_path') ?? field('notebook_path') ?? field('url') ?? field('pattern') ?? field('path'));
  return summary === null ? null : clip(summary, SUMMARY_MAX);
}

/** Dernier message du tour ; undefined quand l'agent n'en transmet pas (le détail connu est gardé). */
export function turnDetail(message: string | null): AttentionDetail | undefined {
  return message === null || message.trim() === ''
    ? undefined
    : { kind: 'turn', message: clip(message, TURN_MESSAGE_MAX) };
}

// Threads already matched to a rollout: a rollout is never removed while its session lives.
const knownCodexThreads = new Set<string>();
// Threads whose full scan found nothing, with the scan time: helper threads (e.g. title generation)
// notify repeatedly and must not rescan the whole, ever-growing rollout tree each time.
const missedCodexThreads = new Map<string, number>();
const CODEX_MISS_TTL_MS = 60_000;

function rolloutInDay(root: string, threadId: string, day: Date): boolean {
  const dir = join(
    root,
    String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'),
    String(day.getDate()).padStart(2, '0'),
  );
  try {
    return readdirSync(dir).some((name) => name.startsWith('rollout-') && name.endsWith(`${threadId}.jsonl`));
  } catch (error) {
    // Directory missing: not this day. Any other failure is reported, not taken for a missing rollout silently.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn(`[hooks] rollouts Codex illisibles dans ${dir} :`, error instanceof Error ? error.message : error);
    return false;
  }
}

function codexRolloutExists(threadId: string): boolean {
  if (knownCodexThreads.has(threadId)) return true;
  // Thread ids are UUIDs: refuse anything that could act as a glob pattern.
  if (!/^[\w-]+$/.test(threadId)) return false;
  const root = join(codexHome(), 'sessions');
  // Rollouts live in sessions/YYYY/MM/DD/, dated by the thread's creation, not by its resumption.
  // A new thread's rollout lands in today's (or, past midnight, yesterday's) folder: always check
  // them, so a rollout written after the first notification is never hidden by the miss cache.
  const now = Date.now();
  if (rolloutInDay(root, threadId, new Date(now)) || rolloutInDay(root, threadId, new Date(now - 86_400_000))) {
    knownCodexThreads.add(threadId);
    missedCodexThreads.delete(threadId);
    return true;
  }
  // Only a resumed older thread needs the full scan, and its rollout already exists.
  const missedAt = missedCodexThreads.get(threadId);
  if (missedAt !== undefined && now - missedAt < CODEX_MISS_TTL_MS) return false;
  if (globSync(`**/rollout-*${threadId}*.jsonl`, { cwd: root }).length === 0) {
    for (const [id, at] of missedCodexThreads) if (now - at >= CODEX_MISS_TTL_MS) missedCodexThreads.delete(id);
    missedCodexThreads.set(threadId, now);
    return false;
  }
  knownCodexThreads.add(threadId);
  missedCodexThreads.delete(threadId);
  return true;
}

function writeIfChanged(path: string, contents: string): void {
  let current: string | null = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch (error) {
    ignoreEnoent(error);
  }
  if (current === contents) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o600 });
}

/**
 * Rewritten at each server start and never removed: the hook is a no-op outside Cerebro sessions.
 * To uninstall, stop Cerebro then delete the file (see README, « Désinstallation »).
 */
export function installGrokHook(path = join(homedir(), '.grok', 'hooks', 'cerebro.json')): void {
  writeIfChanged(path, `${JSON.stringify(getGrokHookSettings(), null, 2)}\n`);
}

/**
 * Cerebro plugin of agy, discovered in its global customization folder. Same lifecycle as the Grok hook: rewritten
 * at each server start when agy is installed, inert outside Cerebro sessions; to uninstall, stop Cerebro then delete
 * the folder.
 */
export function installGeminiHook(
  dir = join(homedir(), '.gemini', 'config', 'plugins', 'cerebro'),
  home = geminiHome(),
): void {
  // agy not installed: nothing to add next to another Gemini tool's files.
  if (!existsSync(home)) return;
  const injection = join(dir, 'session-start.json');
  writeIfChanged(join(dir, 'plugin.json'), `${JSON.stringify({ name: 'cerebro' }, null, 2)}\n`);
  writeIfChanged(injection, `${JSON.stringify(getGeminiSessionInjection())}\n`);
  writeIfChanged(join(dir, 'hooks.json'), `${JSON.stringify(getGeminiHookSettings(injection), null, 2)}\n`);
}

// agy runs its Stop hook just before writing the turn's last answer to the transcript: read it a little later.
const GEMINI_STOP_POLL_MS = 400;
const GEMINI_STOP_ATTEMPTS = 8;
// Turns begun per session, so that an end of turn handled late never overrides a turn started meanwhile.
const geminiTurns = new Map<string, number>();

/** Text of the turn's final answer once it is the transcript's last step; undefined while it is not written yet. */
export function geminiFinalAnswer(transcript: string): string | undefined {
  const last = transcript.trimEnd().split('\n').at(-1);
  if (last === undefined || last === '') return undefined;
  let step: unknown;
  try {
    step = JSON.parse(last);
  } catch {
    // Line still being written.
    return undefined;
  }
  if (!isRecord(step) || step.type !== 'PLANNER_RESPONSE' || step.source !== 'MODEL') return undefined;
  if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) return undefined;
  return typeof step.content === 'string' ? step.content : undefined;
}

async function geminiLastAnswer(conversationId: string): Promise<string | null> {
  const path = await findTranscript('gemini', conversationId);
  if (path === null) return null;
  for (let attempt = 0; attempt < GEMINI_STOP_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, GEMINI_STOP_POLL_MS));
    const answer = geminiFinalAnswer(await readFile(path, 'utf8'));
    if (answer !== undefined) return answer;
  }
  return null;
}

async function finishGeminiTurn(
  sessions: SessionManager,
  sessionId: string,
  conversationId: string,
  answered: boolean,
): Promise<void> {
  const turn = geminiTurns.get(sessionId);
  let message: string | null = null;
  try {
    if (answered) message = await geminiLastAnswer(conversationId);
  } catch (error) {
    console.warn('[hooks] dernière réponse agy illisible :', error instanceof Error ? error.message : error);
  }
  if (geminiTurns.get(sessionId) !== turn) return;
  sessions.setPendingQuestions(sessionId, null);
  sessions.setReliableState(sessionId, 'idle', 'Tour terminé', turnDetail(message));
  sessions.reportTurnComplete(sessionId, message);
}

function handleGeminiHook(sessions: SessionManager, sessionId: string, event: string, payload: HookPayload): void {
  const conversationId = stringField(payload, 'conversationId');
  if (conversationId === null) return;
  const known = sessions.db.getSession(sessionId)?.agentSessionId ?? null;
  if (event === 'SessionStart') {
    // Only the session's own conversation: subagents start conversations of their own.
    if (known === null) sessions.setAgentSessionId(sessionId, conversationId);
    return;
  }
  if (known !== null && known !== conversationId) return;
  if (event === 'PreInvocation') {
    // The first model call of a turn follows a new prompt: it answers a pending question.
    if (payload.invocationNum === 0) {
      geminiTurns.set(sessionId, (geminiTurns.get(sessionId) ?? 0) + 1);
      sessions.clearAsked(sessionId);
    }
    sessions.setPendingQuestions(sessionId, null);
    sessions.setRunning(sessionId);
    return;
  }
  if (event === 'PostToolUse') {
    sessions.setPendingQuestions(sessionId, null);
    sessions.setRunning(sessionId);
    return;
  }
  if (event === 'PreToolUse') {
    const tool = isRecord(payload.toolCall) ? payload.toolCall : null;
    if (tool?.name !== GEMINI_QUESTION_TOOL) return;
    const questions = parseQuestions(tool.args);
    sessions.setPendingQuestions(sessionId, questions);
    sessions.setReliableState(
      sessionId,
      'waiting',
      'Question',
      questions === null ? null : { kind: 'questions', questions },
    );
    return;
  }
  if (event === 'Stop')
    void finishGeminiTurn(sessions, sessionId, conversationId, payload.terminationReason === 'NO_TOOL_CALL');
}

export function handleHook(
  sessions: SessionManager,
  sessionId: string,
  agent: Agent,
  event: string,
  payload: HookPayload,
): void {
  if (agent === 'codex') {
    // Codex also notifies for short-lived helper threads (e.g. title generation): ignore any
    // thread without a rollout file, i.e. one that `codex resume` could not open.
    const threadId = stringField(payload, 'thread-id', 'thread_id', 'session_id');
    if (threadId === null || !codexRolloutExists(threadId)) return;
    sessions.setAgentSessionId(sessionId, threadId);
    if (event === 'notify' && payload.type === 'agent-turn-complete') {
      const message = stringField(payload, 'last-assistant-message');
      sessions.setReliableState(sessionId, 'idle', 'Tour terminé', turnDetail(message));
      sessions.reportTurnComplete(sessionId, message);
    }
    return;
  }

  if (agent === 'gemini') {
    handleGeminiHook(sessions, sessionId, event, payload);
    return;
  }
  if (event === 'SessionStart' && agent === 'grok') {
    const agentSessionId = stringField(payload, 'session_id');
    if (agentSessionId !== null) sessions.setAgentSessionId(sessionId, agentSessionId);
    return;
  }
  if (event === 'UserPromptSubmit' || event === 'PostToolUse') {
    // PostToolUse also follows the cerebro-notify call itself: only a new prompt answers the question.
    if (event === 'UserPromptSubmit') sessions.clearAsked(sessionId);
    sessions.setPendingQuestions(sessionId, null);
    sessions.setRunning(sessionId);
    return;
  }
  if (event === 'Stop') {
    sessions.setPendingQuestions(sessionId, null);
    const message = stringField(payload, 'last_assistant_message');
    sessions.setReliableState(sessionId, 'idle', 'Tour terminé', turnDetail(message));
    sessions.reportTurnComplete(sessionId, message);
    return;
  }
  if (event === 'PreToolUse') {
    const toolName = stringField(payload, 'tool_name') ?? '';
    if (!/ask.*user/i.test(toolName)) return;
    // Kept for Slack and the web queue: the terminal only shows the current tab of a multi-question dialog.
    const questions = parseQuestions(payload.tool_input);
    sessions.setPendingQuestions(sessionId, questions);
    sessions.setReliableState(
      sessionId,
      'waiting',
      'Question',
      questions === null ? null : { kind: 'questions', questions },
    );
    return;
  }
  if (event === 'PermissionRequest') {
    // Arrive avant la notification permission_prompt (environ 6 s) : l'outil est gardé pour elle.
    const tool = stringField(payload, 'tool_name');
    sessions.rememberPermissionRequest(sessionId, { tool, summary: summarizeToolUse(tool, payload.tool_input) });
    return;
  }
  if (event !== 'Notification') return;

  const notificationType = stringField(payload, 'notification_type', 'type');
  const message = stringField(payload, 'message');
  if (notificationType === 'permission_prompt') {
    sessions.setReliableState(
      sessionId,
      'waiting',
      message ?? 'Permission demandée',
      sessions.takePermissionRequest(sessionId),
    );
  } else if (notificationType === 'elicitation_dialog') {
    sessions.setReliableState(sessionId, 'waiting', message ?? 'Permission demandée');
  } else if (notificationType === 'idle_prompt') {
    sessions.reportIdlePrompt(sessionId);
  } else if (message !== null && /permission/i.test(message)) {
    sessions.setReliableState(sessionId, 'waiting', message, sessions.takePermissionRequest(sessionId));
  } else {
    sessions.setReliableState(sessionId, 'idle', message ?? 'Tour terminé');
  }
}

export function isHookPayload(value: unknown): value is HookPayload {
  return isRecord(value);
}
