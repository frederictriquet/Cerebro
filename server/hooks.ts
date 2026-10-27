import { globSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getGrokHookSettings } from './agents.ts';
import { codexHome } from './codex-config.ts';
import { parseQuestions } from './questions.ts';
import type { SessionManager } from './sessions.ts';
import type { Agent } from '../shared/types.ts';
import { ignoreEnoent, isRecord } from './util.ts';

type HookPayload = Record<string, unknown>;

function stringField(payload: HookPayload, ...names: string[]): string | null {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
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

/**
 * Rewritten at each server start and never removed: the hook is a no-op outside Cerebro sessions.
 * To uninstall, stop Cerebro then delete the file (see README, « Désinstallation »).
 */
export function installGrokHook(path = join(homedir(), '.grok', 'hooks', 'cerebro.json')): void {
  const contents = `${JSON.stringify(getGrokHookSettings(), null, 2)}\n`;
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
      sessions.setReliableState(sessionId, 'idle', 'Tour terminé');
      sessions.reportTurnComplete(sessionId, stringField(payload, 'last-assistant-message'));
    }
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
    sessions.setReliableState(sessionId, 'idle', 'Tour terminé');
    sessions.reportTurnComplete(sessionId, stringField(payload, 'last_assistant_message'));
    return;
  }
  if (event === 'PreToolUse') {
    const toolName = stringField(payload, 'tool_name') ?? '';
    if (!/ask.*user/i.test(toolName)) return;
    // Kept for Slack: the terminal only shows the current tab of a multi-question dialog.
    sessions.setPendingQuestions(sessionId, parseQuestions(payload.tool_input));
    sessions.setReliableState(sessionId, 'waiting', 'Question');
    return;
  }
  if (event !== 'Notification') return;

  const notificationType = stringField(payload, 'notification_type', 'type');
  const message = stringField(payload, 'message');
  if (notificationType === 'permission_prompt' || notificationType === 'elicitation_dialog') {
    sessions.setReliableState(sessionId, 'waiting', message ?? 'Permission demandée');
  } else if (notificationType === 'idle_prompt') {
    sessions.setReliableState(sessionId, 'idle', message ?? 'Tour terminé');
  } else if (message !== null && /permission/i.test(message)) {
    sessions.setReliableState(sessionId, 'waiting', message);
  } else {
    sessions.setReliableState(sessionId, 'idle', message ?? 'Tour terminé');
  }
}

export function isHookPayload(value: unknown): value is HookPayload {
  return isRecord(value);
}
