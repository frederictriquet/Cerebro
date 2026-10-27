#!/usr/bin/env node

const sessionId = process.env.CEREBRO_SESSION_ID;
const baseUrl = process.env.CEREBRO_URL;

if (sessionId && baseUrl) {
  const [, , agent = '', event = '', ...args] = process.argv;
  let payload = {};

  try {
    let raw = '';
    if (agent === 'codex') {
      // Codex appends the JSON payload as the last argument.
      raw = args.at(-1) ?? '';
    } else {
      for await (const chunk of process.stdin) raw += chunk;
    }
    if (raw.trim() !== '') {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
    }
  } catch {
    payload = {};
  }

  try {
    await fetch(`${baseUrl}/api/hook/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cerebro-token': process.env.CEREBRO_TOKEN ?? '',
      },
      body: JSON.stringify({ agent, event, payload }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // Hooks must never interfere with the agent.
  }
}
