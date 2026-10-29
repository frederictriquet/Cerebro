import { isSlackTimestamp, watchRequestFrom, type WatchRequest } from './slack-state.ts';
import { isRecord } from './util.ts';

// Posts of the claude.ai Slack connector: the session then waits for replies in that thread.
const SEND_TOOL = 'mcp__claude_ai_Slack__slack_send_message';
const SCHEDULE_TOOL = 'mcp__claude_ai_Slack__slack_schedule_message';

/**
 * The connector's answer, as seen in PostToolUse payloads: `[{ type: 'text', text: '{"message_link": …,
 * "message_context": { "message_ts": …, "channel_id": … } }' }]`. Its `channel_id` is the conversation actually
 * posted to: a DM's `D…` when the tool was given a user's `U…`.
 */
function messageContext(response: unknown): { channel: unknown; ts: unknown } | null {
  for (const item of Array.isArray(response) ? response : [response]) {
    if (!isRecord(item) || typeof item.text !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.text);
    } catch {
      continue;
    }
    if (isRecord(parsed) && isRecord(parsed.message_context))
      return { channel: parsed.message_context.channel_id, ts: parsed.message_context.message_ts };
  }
  return null;
}

const AUTO_LABEL_MAX = 60;

/**
 * Label of a watch started by a post: the first line of the message, Slack markup reduced to its text
 * (`<url|texte>`, `<@U…>`, `*gras*`…), shortened. undefined when nothing readable remains.
 */
export function postedLabel(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  const line =
    message
      .replace(/<([^<>|]*)\|([^<>]*)>/g, '$2')
      .replace(/<([^<>]*)>/g, '$1')
      .replace(/[*~`]+/g, '')
      .split('\n')
      .map((candidate) => candidate.replace(/\s+/g, ' ').trim())
      .find((candidate) => candidate !== '') ?? '';
  if (line === '') return undefined;
  return line.length > AUTO_LABEL_MAX ? `${line.slice(0, AUTO_LABEL_MAX - 1).trimEnd()}…` : line;
}

/**
 * The thread to watch after a session posted through the Slack connector, from the PostToolUse payload: the
 * thread replied to, or the new top-level message, from just after the post, labelled with the start of the
 * message. null when the tool posts nothing to
 * watch; a string, the reason, when the payload does not have the expected shape.
 */
export function postedWatchRequest(payload: Record<string, unknown>): WatchRequest | string | null {
  const tool = payload.tool_name;
  if (tool !== SEND_TOOL && tool !== SCHEDULE_TOOL) return null;
  const input = payload.tool_input;
  if (!isRecord(input)) return `${tool} : tool_input absent`;
  if (input.thread_ts !== undefined && !isSlackTimestamp(input.thread_ts)) return `${tool} : thread_ts invalide`;
  const threadTs = input.thread_ts;
  if (tool === SCHEDULE_TOOL) {
    // A scheduled top-level message has no timestamp until Slack posts it: nothing to watch yet.
    if (threadTs === undefined) return null;
    const request = watchRequestFrom({ channel: input.channel_id, threadTs, label: postedLabel(input.message) });
    return typeof request === 'string' ? `${tool} : ${request}` : request;
  }
  const context = messageContext(payload.tool_response);
  if (context === null || !isSlackTimestamp(context.ts)) return `${tool} : message_context absent de la réponse`;
  const request = watchRequestFrom({
    channel: typeof context.channel === 'string' ? context.channel : input.channel_id,
    threadTs: threadTs ?? context.ts,
    since: context.ts,
    label: postedLabel(input.message),
  });
  return typeof request === 'string' ? `${tool} : ${request}` : request;
}
