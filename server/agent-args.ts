import type { Agent, Effort, Mode } from '../shared/types.ts';

// Command-line flags shared by interactive sessions (agents.ts) and headless runs (headless.ts).

export interface Tuning {
  model: string | null;
  effort: Effort | null;
}

export function tuningArgs(agent: Agent, { model, effort }: Tuning): string[] {
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

export function modeArgs(agent: Agent, mode: Mode): string[] {
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
