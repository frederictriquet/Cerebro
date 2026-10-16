import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HOOK_SCRIPT, SLACK_ENABLED } from './config.ts';
import type { Agent, Effort, Mode } from './db.ts';

const execFileAsync = promisify(execFile);
export const AGENTS: readonly Agent[] = ['claude', 'codex', 'grok'];
export const HOOK = ['node', HOOK_SCRIPT] as const;
const NOTIFY_INSTRUCTIONS = "Tu tournes dans Cerebro. L'utilisateur n'est peut-être pas devant son écran. Pour le prévenir (tâche longue terminée, blocage important) exécute `cerebro-notify \"message\"` ; pour lui poser une question dont la réponse conditionne la suite, exécute `cerebro-notify --ask \"question\"` puis termine ton tour : sa réponse arrivera comme prochain message. Utilise-le avec parcimonie, messages courts et autoportants.";
const BACKLOG_INSTRUCTIONS = "Cerebro tient un backlog de tâches par projet. Si l'utilisateur demande de mettre des éléments (par exemple les findings d'une review) dans le backlog, envoie-les sur l'entrée standard de `cerebro-backlog`, une tâche par élément, séparées par une ligne `---` ; chaque tâche doit se suffire à elle-même (fichier:ligne, problème, scénario, correctif attendu), car elle sera confiée telle quelle à une nouvelle session. Quand plusieurs tâches relèvent d'un même sujet (par exemple les findings d'une même review), regroupe-les dans un epic : `cerebro-backlog --new-epic \"Titre\" --description \"contexte commun\"` suivi des tâches, ou `--epic <id>` pour un epic existant. Chaque tâche doit rester autonome ; l'utilisateur peut traiter l'epic d'un bloc. `cerebro-backlog --help` décrit les dépendances entre tâches, les epics et les autres commandes.";
// Le backlog fonctionne toujours ; cerebro-notify seulement si Slack est configuré.
export const AGENT_INSTRUCTIONS = SLACK_ENABLED ? `${NOTIFY_INSTRUCTIONS} ${BACKLOG_INSTRUCTIONS}` : `Tu tournes dans Cerebro. ${BACKLOG_INSTRUCTIONS}`;

export interface Tuning {
  model: string | null;
  effort: Effort | null;
}

function tuningArgs(agent: Agent, { model, effort }: Tuning): string[] {
  const args: string[] = [];
  if (agent === 'codex') {
    if (model !== null) args.push('-m', model);
    if (effort !== null) args.push('-c', `model_reasoning_effort="${effort}"`);
    return args;
  }
  if (model !== null) args.push('--model', model);
  if (effort !== null) args.push(agent === 'claude' ? '--effort' : '--reasoning-effort', effort);
  return args;
}

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

const TOML_ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

function unescapeTomlBasic(value: string): string {
  return value
    .replace(/\\\s*\n\s*/g, '')
    .replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, esc: string) =>
      esc.length > 1 ? String.fromCodePoint(parseInt(esc.slice(1), 16)) : TOML_ESCAPES[esc] ?? esc);
}

// Top-level `developer_instructions` of the user's Codex config: our `-c` override replaces it,
// so Cerebro's instructions are appended to it rather than silently dropping the user's.
export function readCodexDeveloperInstructions(): string | null {
  let text: string;
  try {
    text = readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'), 'utf8');
  } catch {
    return null;
  }
  const firstTable = text.search(/^\s*\[/m);
  const topLevel = firstTable === -1 ? text : text.slice(0, firstTable);
  const match = /^[ \t]*"?developer_instructions"?[ \t]*=[ \t]*("""[\s\S]*?"""(?!")|'''[\s\S]*?'''(?!')|"(?:[^"\\\n]|\\.)*"|'[^'\n]*')/m
    .exec(topLevel);
  if (match === null) return null;
  const raw = match[1];
  let value: string;
  if (raw.startsWith('"""')) value = unescapeTomlBasic(raw.slice(3, -3).replace(/^\r?\n/, ''));
  else if (raw.startsWith("'''")) value = raw.slice(3, -3).replace(/^\r?\n/, '');
  else if (raw.startsWith('"')) value = unescapeTomlBasic(raw.slice(1, -1));
  else value = raw.slice(1, -1);
  return value.trim() === '' ? null : value;
}

function codexConfigArgs(): string[] {
  const args = [
    '-c', `notify=["node",${JSON.stringify(HOOK_SCRIPT)},"codex","notify"]`,
    '-c', 'tui.notifications=true',
    '-c', 'tui.notification_method="osc9"',
  ];
  const userInstructions = readCodexDeveloperInstructions();
  const instructions = userInstructions === null ? AGENT_INSTRUCTIONS : `${userInstructions}\n\n${AGENT_INSTRUCTIONS}`;
  args.push('-c', `developer_instructions=${JSON.stringify(instructions)}`);
  return args;
}

export function buildAgentCommand(
  agent: Agent,
  mode: Mode,
  prompt: string,
  generatedSessionId: string,
  resumeSessionId: string | null = null,
  tuning: Tuning = { model: null, effort: null },
): AgentCommand {
  const args: string[] = [];
  let agentSessionId: string | null = null;

  if (agent === 'claude') {
    agentSessionId = resumeSessionId ?? generatedSessionId;
    if (resumeSessionId === null) args.push('--session-id', agentSessionId);
    else args.push('--resume', resumeSessionId);
    args.push('--settings', JSON.stringify(hookSettings('claude')), ...modeArgs(agent, mode), ...tuningArgs(agent, tuning));
    args.push('--append-system-prompt', AGENT_INSTRUCTIONS);
    if (resumeSessionId === null && prompt !== '') args.push(prompt);
  } else if (agent === 'grok') {
    agentSessionId = resumeSessionId ?? generatedSessionId;
    if (resumeSessionId === null) args.push('--session-id', agentSessionId);
    else args.push('--resume', resumeSessionId);
    args.push(...modeArgs(agent, mode), ...tuningArgs(agent, tuning));
    args.push('--rules', AGENT_INSTRUCTIONS);
    if (resumeSessionId === null && prompt !== '') args.push(prompt);
  } else {
    if (resumeSessionId === null) {
      args.push(...codexConfigArgs(), ...modeArgs(agent, mode), ...tuningArgs(agent, tuning));
      if (prompt !== '') args.push(prompt);
    } else {
      agentSessionId = resumeSessionId;
      args.push('resume', resumeSessionId, ...codexConfigArgs(), ...modeArgs(agent, mode), ...tuningArgs(agent, tuning));
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
