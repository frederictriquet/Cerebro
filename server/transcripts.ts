import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Agent, Session } from '../shared/types.ts';
import { codexHome, listCodexRollouts } from './codex-config.ts';
import { asRecord } from './util.ts';

/** Échange lisible d'une conversation : messages de l'utilisateur et réponses textuelles de l'agent, sans outils. */
export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface TranscriptRoots {
  claude: string;
  codex: string;
  grok: string;
}

export function defaultTranscriptRoots(): TranscriptRoots {
  return {
    claude: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    codex: codexHome(),
    grok: process.env.GROK_HOME ?? join(homedir(), '.grok'),
  };
}

// Messages injectés par la CLI (commandes locales, rappels système) : pas des propos de l'utilisateur.
const CLAUDE_INJECTED = /^<(command-|local-command-|system-reminder|task-notification|user-prompt-submit-hook)/;

function texts(content: unknown, types: readonly string[]): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const record = asRecord(part);
    return record !== null && types.includes(String(record.type)) && typeof record.text === 'string'
      ? [record.text]
      : [];
  });
}

function records(text: string): Record<string, unknown>[] {
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return [];
    try {
      const record = asRecord(JSON.parse(line));
      return record === null ? [] : [record];
    } catch {
      return [];
    }
  });
}

/** Les messages consécutifs d'un même rôle (blocs d'une réponse diffusée en plusieurs fois) sont réunis. */
function merged(messages: TranscriptMessage[]): TranscriptMessage[] {
  const result: TranscriptMessage[] = [];
  for (const message of messages) {
    const text = message.text.trim();
    if (text === '') continue;
    const last = result.at(-1);
    if (last?.role === message.role) last.text = `${last.text}\n\n${text}`;
    else result.push({ role: message.role, text });
  }
  return result;
}

function claudeMessages(text: string): TranscriptMessage[] {
  const seen = new Set<string>();
  return records(text).flatMap((record): TranscriptMessage[] => {
    if (record.isSidechain === true || record.isMeta === true) return [];
    if (typeof record.uuid === 'string') {
      if (seen.has(record.uuid)) return [];
      seen.add(record.uuid);
    }
    const message = asRecord(record.message);
    if (record.type === 'user' && message?.role === 'user')
      return texts(message.content, ['text'])
        .filter((entry) => !CLAUDE_INJECTED.test(entry.trimStart()))
        .map((entry) => ({ role: 'user', text: entry }));
    if (record.type === 'assistant' && message?.role === 'assistant')
      return texts(message.content, ['text']).map((entry) => ({ role: 'assistant', text: entry }));
    return [];
  });
}

// Rollouts récents : éléments `item_completed` ; plus anciens : événements `user_message` / `agent_message`.
function codexMessages(text: string): TranscriptMessage[] {
  const items: TranscriptMessage[] = [];
  const legacy: TranscriptMessage[] = [];
  for (const record of records(text)) {
    const payload = asRecord(record.payload);
    if (record.type !== 'event_msg' || payload === null) continue;
    if (payload.type === 'item_completed') {
      const item = asRecord(payload.item);
      const role = item?.type === 'UserMessage' ? 'user' : item?.type === 'AgentMessage' ? 'assistant' : null;
      if (role !== null) items.push({ role, text: texts(item?.content, ['text', 'Text']).join('\n\n') });
    } else if (
      (payload.type === 'user_message' || payload.type === 'agent_message') &&
      typeof payload.message === 'string'
    )
      legacy.push({ role: payload.type === 'user_message' ? 'user' : 'assistant', text: payload.message });
  }
  return items.length > 0 ? items : legacy;
}

// Seuls les messages `user` numérotés (`prompt_index`) viennent de l'utilisateur, dans <user_query>.
function grokMessages(text: string): TranscriptMessage[] {
  return records(text).flatMap((record): TranscriptMessage[] => {
    if (record.type === 'user' && typeof record.prompt_index === 'number')
      return texts(record.content, ['text']).map((entry) => ({
        role: 'user',
        text: entry.replace(/^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/, '$1'),
      }));
    if (record.type === 'assistant' && typeof record.content === 'string')
      return [{ role: 'assistant', text: record.content }];
    return [];
  });
}

export function parseTranscript(agent: Agent, text: string): TranscriptMessage[] {
  return merged(
    agent === 'claude' ? claudeMessages(text) : agent === 'codex' ? codexMessages(text) : grokMessages(text),
  );
}

async function newest(paths: string[]): Promise<string | null> {
  const dated = await Promise.all(
    paths.map(async (path) => ({
      path,
      mtime: await stat(path).then(
        (s) => s.mtimeMs,
        () => -1,
      ),
    })),
  );
  const found = dated.filter((entry) => entry.mtime >= 0).sort((a, b) => b.mtime - a.mtime);
  return found[0]?.path ?? null;
}

async function subdirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

/** Fichier de transcript de la conversation de l'agent ; une copie (worktree déplacé) : la plus récente. */
export async function findTranscript(
  agent: Agent,
  agentSessionId: string,
  roots: TranscriptRoots = defaultTranscriptRoots(),
): Promise<string | null> {
  if (agent === 'claude')
    return newest(
      (await subdirectories(join(roots.claude, 'projects'))).map((dir) => join(dir, `${agentSessionId}.jsonl`)),
    );
  if (agent === 'grok')
    return newest(
      (await subdirectories(join(roots.grok, 'sessions'))).map((dir) =>
        join(dir, agentSessionId, 'chat_history.jsonl'),
      ),
    );
  const rollouts = await listCodexRollouts(join(roots.codex, 'sessions'));
  return newest(rollouts.filter((path) => path.endsWith(`-${agentSessionId}.jsonl`)));
}

/** Messages d'une session Cerebro, null si son transcript est introuvable ou illisible. */
export async function readSessionTranscript(
  session: Pick<Session, 'agent' | 'agentSessionId'>,
  roots?: TranscriptRoots,
): Promise<TranscriptMessage[] | null> {
  if (session.agentSessionId === null) return null;
  const path = await findTranscript(session.agent, session.agentSessionId, roots);
  if (path === null) return null;
  try {
    return parseTranscript(session.agent, await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

const OMITTED = (count: number): string =>
  `_… ${count} message${count > 1 ? 's' : ''} intermédiaire${count > 1 ? 's' : ''} omis pour tenir dans le contexte du council …_`;

function excerpt(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}\n\n_… (tronqué)_`;
}

/**
 * Conversation mise en forme pour le contexte d'un council, en `max` caractères au plus : la demande initiale
 * est toujours gardée (au besoin tronquée), puis les messages les plus récents ; ceux du milieu sont omis.
 */
export function transcriptContext(
  session: Pick<Session, 'title' | 'agent' | 'model' | 'prompt'>,
  messages: TranscriptMessage[] | null,
  max: number,
): { text: string; truncated: boolean; complete: boolean } {
  const agentLabel = [session.agent, session.model].filter((part) => part !== null).join(' · ');
  const label = (message: TranscriptMessage): string =>
    message.role === 'user' ? '### Utilisateur' : `### Agent (${agentLabel})`;
  const head = `Conversation de la session Cerebro « ${session.title} » (${agentLabel}), soumise au council :`;
  const complete = messages !== null && messages.length > 0;
  const list: TranscriptMessage[] = complete ? messages : [{ role: 'user', text: session.prompt.trim() }];
  const intro = complete
    ? head
    : `${head}\n\n_Transcript de la conversation introuvable : seule sa demande initiale est reprise._`;
  const render = (message: TranscriptMessage, limit = Infinity): string =>
    `${label(message)}\n\n${excerpt(message.text, limit)}`;
  const full = [intro, ...list.map((message) => render(message))].join('\n\n');
  if (full.length <= max) return { text: full, truncated: false, complete };

  const [first, ...rest] = list;
  const firstBlock = render(first!, Math.floor(max / 4));
  let budget = max - intro.length - firstBlock.length - OMITTED(rest.length).length - 8;
  const tail: string[] = [];
  for (let index = rest.length - 1; index >= 0; index--) {
    const block = render(rest[index]!);
    if (block.length + 2 > budget) {
      // Le dernier message trop long est gardé tronqué plutôt que perdu.
      if (tail.length === 0 && budget > 200) tail.unshift(render(rest[index]!, budget - 200));
      break;
    }
    tail.unshift(block);
    budget -= block.length + 2;
  }
  const omitted = rest.length - tail.length;
  return {
    text: [intro, firstBlock, ...(omitted > 0 ? [OMITTED(omitted)] : []), ...tail].join('\n\n'),
    truncated: true,
    complete,
  };
}
