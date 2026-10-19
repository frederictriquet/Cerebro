import claude from './assets/agents/claude.svg';
import codex from './assets/agents/codex.svg';
import grok from './assets/agents/grok.svg';
import { AGENT_LABEL } from './format.ts';
import type { Agent } from './types.ts';

const logos: Record<Agent, string> = { claude, codex, grok };

export function AgentLabel({ agent }: { agent: Agent }) {
  return (
    <span className="agent-label">
      <span
        className={`agent-logo agent-logo-${agent}`}
        style={{ maskImage: `url("${logos[agent]}")`, WebkitMaskImage: `url("${logos[agent]}")` }}
        aria-hidden="true"
      />
      {AGENT_LABEL[agent]}
    </span>
  );
}
