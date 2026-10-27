// Structured questions asked through the AskUserQuestion tool (several tabs, several options each).

export interface QuestionOption {
  label: string;
  description: string | null;
  preview: string | null;
}

export interface AgentQuestion {
  question: string;
  header: string | null;
  multiSelect: boolean;
  options: QuestionOption[];
}

const PREVIEW_MAX_LINES = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Reads the `questions` of an AskUserQuestion tool input; null when it has none usable. */
export function parseQuestions(toolInput: unknown): AgentQuestion[] | null {
  if (!isRecord(toolInput) || !Array.isArray(toolInput.questions)) return null;
  const questions: AgentQuestion[] = [];
  for (const item of toolInput.questions) {
    if (!isRecord(item)) continue;
    const question = text(item.question);
    if (question === null) continue;
    const options = (Array.isArray(item.options) ? item.options : [])
      .filter(isRecord)
      .map((option) => ({
        label: text(option.label),
        description: text(option.description),
        preview: text(option.preview),
      }))
      .filter((option): option is QuestionOption => option.label !== null);
    questions.push({ question, header: text(item.header), multiSelect: item.multiSelect === true, options });
  }
  return questions.length > 0 ? questions : null;
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function codeBlock(value: string): string {
  const lines = value.split('\n');
  const shown = lines.slice(0, PREVIEW_MAX_LINES).join('\n') + (lines.length > PREVIEW_MAX_LINES ? '\n…' : '');
  return `\`\`\`\n${escapeMrkdwn(shown).replaceAll('```', '``​`')}\n\`\`\``;
}

/** Slack mrkdwn rendering: one block per question, numbered options, then how to answer. */
export function formatQuestions(questions: AgentQuestion[]): string {
  const blocks = questions.map((question, index) => {
    const title = questions.length > 1 ? `*Question ${index + 1}/${questions.length}*` : '*Question*';
    const header = question.header === null ? '' : ` · _${escapeMrkdwn(question.header)}_`;
    const lines = [
      `${title}${header}${question.multiSelect ? ' · _plusieurs choix possibles_' : ''}`,
      escapeMrkdwn(question.question),
    ];
    question.options.forEach((option, optionIndex) => {
      const description = option.description === null ? '' : ` — ${escapeMrkdwn(option.description)}`;
      lines.push(`>*${optionIndex + 1}.* ${escapeMrkdwn(option.label)}${description}`);
      if (option.preview !== null) lines.push(codeBlock(option.preview));
    });
    return lines.join('\n');
  });
  const single = questions.length === 1;
  const multi = questions.some((question) => question.multiSelect);
  const examples = [
    single
      ? '`2`'
      : `\`${questions.map((_, index) => (index % 3) + 1).join(' ')}\` (une réponse par question, dans l'ordre)`,
    ...(multi ? ['`1,3` pour plusieurs choix'] : []),
    'ou du texte libre',
  ];
  return `${blocks.join('\n\n')}\n\n_Réponds dans le fil : ${examples.join(', ')}._`;
}

/**
 * Turns a numeric reply ("2", "1 3", "1,3 2") into a one-line answer naming the chosen options.
 * Returns null when the reply is not a valid numeric answer (it is then forwarded as free text).
 */
export function interpretAnswer(questions: AgentQuestion[], reply: string): string | null {
  const tokens = reply
    .trim()
    .split(/[\s;]+/)
    .filter((token) => token !== '');
  if (tokens.length !== questions.length) return null;
  const parts: string[] = [];
  for (const [index, question] of questions.entries()) {
    const token = tokens[index] ?? '';
    if (!/^\d+(,\d+)*$/.test(token)) return null;
    const choices = [...new Set(token.split(',').map(Number))];
    if (choices.length > 1 && !question.multiSelect) return null;
    if (choices.some((choice) => choice < 1 || choice > question.options.length)) return null;
    const labels = choices.map((choice) => question.options[choice - 1]?.label ?? '');
    parts.push(`« ${question.header ?? question.question} » → ${labels.join(', ')}`);
  }
  return parts.join(' ; ');
}
