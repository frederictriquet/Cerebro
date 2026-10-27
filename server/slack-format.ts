import { PUBLIC_URL } from './config.ts';
import type { CouncilRun } from './council.ts';
import type { Agent, CerebroDatabase, Session } from './db.ts';

interface DmCommand {
  projectName: string;
  agent: Agent | null;
  forceNew: boolean;
  text: string;
}

export function parseDmCommand(text: string): DmCommand | null {
  const match = text.match(/^([^\s:/+]+(?:[ \-_.][^\s:/+]+)*?)\s*(?:\/(claude|codex|grok))?\s*(\+)?\s*:\s*([\s\S]+)$/);
  if (match === null) return null;
  const projectName = match[1]?.trim() ?? '';
  const agent = match[2];
  const prompt = match[4]?.trim() ?? '';
  if (projectName === '' || prompt === '') return null;
  return {
    projectName,
    agent: agent === 'claude' || agent === 'codex' || agent === 'grok' ? agent : null,
    forceNew: match[3] !== undefined,
    text: prompt,
  };
}

export interface CouncilCommand {
  // null : council hors projet.
  projectName: string | null;
  question: string;
}

// `council: question` ou `projet/council: question` ; le mot-clé prime sur un projet nommé « council ».
export function parseCouncilCommand(text: string): CouncilCommand | null {
  const match = text.trim().match(/^(?:([^\s:/+]+(?:[ \-_.][^\s:/+]+)*?)\s*\/\s*)?council\s*:\s*([\s\S]+)$/i);
  if (match === null) return null;
  const projectName = match[1]?.trim();
  const question = match[2]?.trim() ?? '';
  if (question === '' || projectName === '') return null;
  return { projectName: projectName ?? null, question };
}

const COUNCIL_FAILURES: Record<CouncilRun['status'], string> = {
  running: 'en cours',
  succeeded: 'sans synthèse',
  failed: 'en échec',
  cancelled: 'annulé',
  interrupted: 'interrompu',
};

// Réponse du fil Slack : l'essentiel de la synthèse, le détail reste sur la page du run.
export function councilSlackText(run: CouncilRun, projectName: string | null): string {
  const link = `<${PUBLIC_URL.replace(/\/+$/, '')}/#/c/${encodeURIComponent(run.id)}|Ouvrir le rapport dans Cerebro>`;
  const scope = projectName === null ? 'hors projet' : `*${escapeMrkdwn(projectName)}*`;
  const synthesis = run.synthesis;
  if (run.status !== 'succeeded' || synthesis === null) {
    return `:x: Council ${scope} ${COUNCIL_FAILURES[run.status]} : ${escapeMrkdwn(run.error ?? 'aucune synthèse produite.')}\n${link}`;
  }
  return [
    `:busts_in_silhouette: Council ${scope}`,
    '',
    '*Recommandation*',
    slackMarkdown(synthesis.recommendation),
    '',
    '*Première action*',
    slackMarkdown(synthesis.firstAction),
    '',
    '*Accords*',
    slackMarkdown(synthesis.agreements),
    '',
    '*Désaccords*',
    slackMarkdown(synthesis.disagreements),
    '',
    link,
  ].join('\n');
}

export function isKeyShortcut(text: string): boolean {
  return ['entrée', 'enter', 'échap', 'esc'].includes(text.toLocaleLowerCase('fr-FR'));
}

export function slackTimestampNow(): string {
  return (Date.now() / 1_000).toFixed(6);
}

export function laterThan(left: string, right: string): boolean {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber > rightNumber;
  return left > right;
}

export function escapeMrkdwn(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function decodeSlackText(value: string): string {
  return value
    .replace(/&(amp|lt|gt);/g, (entity, name: string) => {
      if (name === 'amp') return '&';
      if (name === 'lt') return '<';
      if (name === 'gt') return '>';
      return entity;
    })
    .trim();
}

export function safeCodeBlock(value: string): string {
  return value.replaceAll('```', '``\u200b`');
}

// Converts the agent's Markdown to Slack mrkdwn; code spans and blocks are only escaped.
export function slackMarkdown(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/)
    .map((part, index) => {
      // Slack shows a fence's language tag as text, and requires entities even inside code.
      if (index % 2 === 1) return escapeMrkdwn(part.replace(/^```[\w+#.-]*\n/, '```\n'));
      return escapeMrkdwn(part)
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/^(\s*)[-*]\s+/gm, '$1• ');
    })
    .join('');
}

const SLACK_CHUNK = 3_500;

// Cuts an over-long line, preferring whitespace and never inside an entity or a `<url|text>` link.
function hardSplit(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > SLACK_CHUNK) {
    const window = rest.slice(0, SLACK_CHUNK);
    const space = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'));
    let cut = space >= SLACK_CHUNK / 2 ? space + 1 : SLACK_CHUNK;
    const head = rest.slice(0, cut);
    const openLink = head.lastIndexOf('<');
    if (openLink > head.lastIndexOf('>')) cut = openLink;
    else {
      const entity = /&[a-z]{0,3}$/.exec(head);
      if (entity) cut = entity.index;
    }
    // A single link longer than a chunk cannot stay whole: fall back to a plain cut.
    if (cut === 0) cut = SLACK_CHUNK;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}

// Slack truncates long messages: split on line breaks, keeping code blocks balanced.
export function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current === '' ? line : `${current}\n${line}`;
    if (candidate.length <= SLACK_CHUNK || current === '') {
      current = candidate;
      continue;
    }
    chunks.push(current);
    current = line;
  }
  if (current !== '') chunks.push(current);
  const balanced: string[] = [];
  let open = false;
  for (const chunk of chunks.flatMap(hardSplit)) {
    const prefix = open ? '```\n' : '';
    if ((chunk.match(/```/g) ?? []).length % 2 === 1) open = !open;
    balanced.push(`${prefix}${chunk}${open ? '\n```' : ''}`);
  }
  return balanced;
}

export function sessionHeader(db: CerebroDatabase, session: Session): string {
  const project = db.getProject(session.projectId);
  return `*${escapeMrkdwn(project?.name ?? 'Projet inconnu')}* · ${escapeMrkdwn(session.title)} (${session.agent})`;
}

export function sessionLink(sessionId: string): string {
  const base = PUBLIC_URL.replace(/\/+$/, '');
  return `<${base}/#/s/${encodeURIComponent(sessionId)}|Ouvrir dans Cerebro>`;
}
