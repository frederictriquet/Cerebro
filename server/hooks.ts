import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getGrokHookSettings } from './agents.ts';
import type { Agent } from './db.ts';
import { parseQuestions } from './questions.ts';
import type { SessionManager } from './sessions.ts';

type HookPayload = Record<string, unknown>;

function stringField(payload: HookPayload, ...names: string[]): string | null {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function codexRolloutExists(threadId: string): boolean {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  // Rollouts live in sessions/YYYY/MM/DD/; check today and yesterday (sessions spanning midnight).
  for (const offset of [0, 1]) {
    const day = new Date(Date.now() - offset * 86_400_000);
    const dir = join(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0'),
    );
    try {
      if (readdirSync(dir).some((name) => name.endsWith(`${threadId}.jsonl`))) return true;
    } catch {
      // Directory missing: keep looking.
    }
  }
  return false;
}

export function installGrokHook(path = join(homedir(), '.grok', 'hooks', 'cerebro.json')): void {
  const contents = `${JSON.stringify(getGrokHookSettings(), null, 2)}\n`;
  let current: string | null = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
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
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
