import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOOK_SCRIPT, SLACK_ENABLED } from './config.ts';
import type { Agent, Mode } from './db.ts';

const execFileAsync = promisify(execFile);
export const AGENTS: readonly Agent[] = ['claude', 'codex', 'grok'];
export const HOOK = ['node', HOOK_SCRIPT] as const;
export const NOTIFY_INSTRUCTIONS = "Tu tournes dans Cerebro. L'utilisateur n'est peut-être pas devant son écran. Pour le prévenir (tâche longue terminée, blocage important) exécute `cerebro-notify \"message\"` ; pour lui poser une question dont la réponse conditionne la suite, exécute `cerebro-notify --ask \"question\"` puis termine ton tour : sa réponse arrivera comme prochain message. Utilise-le avec parcimonie, messages courts et autoportants.";

export interface AgentCommand {
  cmd: string;
  args: string[];
  agentSessionId: string | null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hookCommand(agent: 'claude' | 'grok', event: string, guarded = false): string {
  const command = `node ${shellQuote(HOOK_SCRIPT)} ${agent} ${event}`;
  return guarded ? `[ -z "$CEREBRO_SESSION_ID" ] || ${command}` : command;
}

function hookSettings(agent: 'claude' | 'grok'): { hooks: Record<string, object[]> } {
  const guarded = agent === 'grok';
  const entry = (event: string): object => ({
    hooks: [{ type: 'command', command: hookCommand(agent, event, guarded) }],
  });
  return {
    hooks: {
      Notification: [entry('Notification')],
      Stop: [entry('Stop')],
      UserPromptSubmit: [entry('UserPromptSubmit')],
      PostToolUse: [entry('PostToolUse')],
      PreToolUse: [{
        matcher: agent === 'grok' ? '(?i)ask.*user|^AskUserQuestion$' : 'AskUserQuestion',
        hooks: [{ type: 'command', command: hookCommand(agent, 'PreToolUse', guarded) }],
      }],
      ...(agent === 'grok' ? { SessionStart: [entry('SessionStart')] } : {}),
    },
  };
}

export function getGrokHookSettings(): { hooks: Record<string, object[]> } {
  return hookSettings('grok');
}

function modeArgs(agent: Agent, mode: Mode): string[] {
  if (mode === 'default') return [];
  if (agent === 'claude') {
    if (mode === 'bypass') return ['--dangerously-skip-permissions'];
    return ['--permission-mode', mode];
  }
  if (agent === 'grok') {
    return ['--permission-mode', mode === 'bypass' ? 'bypassPermissions' : mode];
  }
  if (mode === 'auto') return ['-a', 'on-request', '-s', 'workspace-write'];
  if (mode === 'acceptEdits') return ['-a', 'never', '-s', 'workspace-write'];
  if (mode === 'plan') return ['-s', 'read-only'];
  return ['--dangerously-bypass-approvals-and-sandbox'];
}

function codexConfigArgs(): string[] {
  const args = [
    '-c', `notify=["node",${JSON.stringify(HOOK_SCRIPT)},"codex","notify"]`,
    '-c', 'tui.notifications=true',
    '-c', 'tui.notification_method="osc9"',
  ];
  if (SLACK_ENABLED) args.push('-c', `developer_instructions=${JSON.stringify(NOTIFY_INSTRUCTIONS)}`);
  return args;
}

export function buildAgentCommand(
  agent: Agent,
  mode: Mode,
  prompt: string,
  generatedSessionId: string,
  resumeSessionId: string | null = null,
): AgentCommand {
  const args: string[] = [];
  let agentSessionId: string | null = null;

  if (agent === 'claude') {
    agentSessionId = resumeSessionId ?? generatedSessionId;
    if (resumeSessionId === null) args.push('--session-id', agentSessionId);
    else args.push('--resume', resumeSessionId);
    args.push('--settings', JSON.stringify(hookSettings('claude')), ...modeArgs(agent, mode));
    if (SLACK_ENABLED) args.push('--append-system-prompt', NOTIFY_INSTRUCTIONS);
    if (resumeSessionId === null && prompt !== '') args.push(prompt);
  } else if (agent === 'grok') {
    agentSessionId = resumeSessionId ?? generatedSessionId;
    if (resumeSessionId === null) args.push('--session-id', agentSessionId);
    else args.push('--resume', resumeSessionId);
    args.push(...modeArgs(agent, mode));
    if (SLACK_ENABLED) args.push('--rules', NOTIFY_INSTRUCTIONS);
    if (resumeSessionId === null && prompt !== '') args.push(prompt);
  } else {
    if (resumeSessionId === null) {
      args.push(...codexConfigArgs(), ...modeArgs(agent, mode));
      if (prompt !== '') args.push(prompt);
    } else {
      agentSessionId = resumeSessionId;
      args.push('resume', resumeSessionId, ...codexConfigArgs(), ...modeArgs(agent, mode));
    }
  }
  return { cmd: agent, args, agentSessionId };
}

export async function getAgentAvailability(): Promise<{ agent: Agent; available: boolean }[]> {
  return Promise.all(AGENTS.map(async (agent) => {
    try {
      await execFileAsync('which', [agent]);
      return { agent, available: true };
    } catch {
      return { agent, available: false };
    }
  }));
}
