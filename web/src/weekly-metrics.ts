import { isRecord } from '../../shared/parse.ts';
import type { WeeklyMetricsMachine } from '../../shared/weekly-metrics.ts';

/** One week record of `weekly_metrics.py`, with the fields the charts need read and checked. */
export interface WeekView {
  /** `2026-W45`. */
  id: string;
  /** `S45`. */
  label: string;
  start: string | null;
  end: string | null;
  /** False for the week in progress. */
  complete: boolean;
  /** The transcripts start after the Monday (oldest week of the machine). */
  truncated: boolean;
  data: Record<string, unknown>;
  manual: Record<string, unknown> | null;
}

/** Number at a dotted path of a week record; null when absent (purged transcripts, older format). */
export function numberAt(data: unknown, path: string): number | null {
  let node = data;
  for (const key of path.split('.')) {
    if (!isRecord(node) || Array.isArray(node)) return null;
    node = node[key];
  }
  return typeof node === 'number' && Number.isFinite(node) ? node : null;
}

/** Map of numbers at a dotted path (category counts, tool calls); null when absent. */
export function countsAt(data: unknown, path: string): Record<string, number> | null {
  let node = data;
  for (const key of path.split('.')) {
    if (!isRecord(node) || Array.isArray(node)) return null;
    node = node[key];
  }
  if (!isRecord(node) || Array.isArray(node)) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function sumOf(counts: Record<string, number> | null, keep: (key: string) => boolean = () => true): number | null {
  if (!counts) return null;
  return Object.entries(counts).reduce((sum, [key, value]) => (keep(key) ? sum + value : sum), 0);
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Short label of a week id: `2026-W45` → `S45`. */
export function weekLabel(id: string): string {
  return `S${Number(id.split('-W')[1] ?? id)}`;
}

export function weekViews(machine: WeeklyMetricsMachine): WeekView[] {
  return machine.weeks.flatMap((data) => {
    const id = typeof data.semaine === 'string' ? data.semaine : null;
    if (!id) return [];
    const manual = machine.manual[id];
    return [
      {
        id,
        label: weekLabel(id),
        start: typeof data.debut === 'string' ? data.debut : null,
        end: typeof data.fin === 'string' ? data.fin : null,
        complete: data.terminee === true,
        truncated: data.debut_tronque === true,
        data,
        manual: isRecord(manual) && !Array.isArray(manual) ? manual : null,
      },
    ];
  });
}

export type Unit = 'count' | 'pct' | 'rate' | 'seconds';

export interface Indicator {
  key: string;
  /** Same wording as the rows of `~/.claude/metrics/report.md`. */
  label: string;
  unit: Unit;
  /** Direction that counts as an improvement, for the colour of a delta. */
  better: 'up' | 'down' | null;
  /** Row indented under the previous one in the table. */
  sub?: boolean;
  get: (week: WeekView) => number | null;
}

const at =
  (path: string) =>
  (week: WeekView): number | null =>
    numberAt(week.data, path);
const external = (key: string, kind: 'appels' | 'erreurs' = 'appels') => {
  return (week: WeekView): number | null => {
    const counts = countsAt(week.data, `outils_externes.${kind}`);
    return counts ? (counts[key] ?? 0) : null;
  };
};
const GOOGLE = new Set(['claude_ai_Google_Docs', 'claude_ai_Google_Sheets', 'claude_ai_Google_Drive']);
const mcp = (keep: (server: string) => boolean, kind: 'appels' | 'erreurs' = 'appels') => {
  return (week: WeekView): number | null =>
    sumOf(countsAt(week.data, `outils_externes.${kind}`), (key) => key.startsWith('mcp:') && keep(key.slice(4)));
};
const regexCategory = (key: string) => (week: WeekView) => {
  const counts = countsAt(week.data, 'friction.plaintes_par_categorie');
  return counts ? (counts[key] ?? 0) : null;
};

/** Manual complaint reading of `manual.json`, as a share of typed messages. */
export function manualComplaintsPct(week: WeekView): number | null {
  const complaints = numberAt(week.manual, 'plaintes');
  const messages = numberAt(week.manual, 'messages_tapes');
  return complaints === null || !messages ? null : round1((100 * complaints) / messages);
}

const indicator = (
  key: string,
  label: string,
  get: Indicator['get'],
  unit: Unit = 'count',
  better: Indicator['better'] = null,
  sub = false,
): Indicator => ({ key, label, get, unit, better, sub });

export const INDICATORS = {
  activeDays: indicator('activeDays', 'Jours avec activité', at('jours_avec_activite')),
  sessions: indicator('sessions', 'Sessions interactives', at('volume.sessions_interactives')),
  messages: indicator('messages', 'Messages tapés', at('volume.messages_tapes')),
  messagesPerSession: indicator('messagesPerSession', 'Messages tapés / session', at('volume.messages_par_session')),
  complaintsManual: indicator(
    'complaintsManual',
    'Plaintes visant l’agent, lecture manuelle (%)',
    manualComplaintsPct,
    'pct',
    'down',
  ),
  complaintsHaiku: indicator(
    'complaintsHaiku',
    'Plaintes visant l’agent, Haiku (%)',
    at('friction.plaintes_haiku.pct'),
    'pct',
    'down',
  ),
  defects: indicator(
    'defects',
    'Défauts d’application signalés (Haiku)',
    at('friction.plaintes_haiku.defauts_logiciel'),
    'count',
    'down',
  ),
  complaintsRegex: indicator(
    'complaintsRegex',
    'Plaintes détectées par expressions (%)',
    at('friction.plaintes_pct'),
    'pct',
    'down',
  ),
  regexActed: indicator('regexActed', 'agi sans demande', regexCategory('agi_sans_demande'), 'count', 'down', true),
  regexDoubt: indicator(
    'regexDoubt',
    'doute / vérification',
    regexCategory('doute_verification'),
    'count',
    'down',
    true,
  ),
  regexWrong: indicator('regexWrong', 'inexactitude', regexCategory('inexactitude'), 'count', 'down', true),
  regexBroken: indicator('regexBroken', 'ne marche pas', regexCategory('ne_marche_pas'), 'count', 'down', true),
  regexIncomplete: indicator(
    'regexIncomplete',
    'oubli / incomplet',
    regexCategory('oubli_incomplet'),
    'count',
    'down',
    true,
  ),
  regexMisread: indicator('regexMisread', 'incompréhension', regexCategory('incomprehension'), 'count', 'down', true),
  regexQuality: indicator('regexQuality', 'qualité du rendu', regexCategory('qualite_rendu'), 'count', 'down', true),
  regexRepeat: indicator('regexRepeat', 'répétition', regexCategory('repetition'), 'count', 'down', true),
  progressRequests: indicator(
    'progressRequests',
    'Demandes de point d’avancement',
    at('friction.demandes_de_point'),
    'count',
    'down',
  ),
  antiSlop: indicator('antiSlop', '/anti-slop lancé', (w) => {
    const counts = countsAt(w.data, 'outils.commandes_slash');
    return counts ? (counts['anti-slop'] ?? 0) : null;
  }),
  interruptions: indicator(
    'interruptions',
    'Interruptions / 100 messages',
    at('friction.interruptions_pour_100'),
    'rate',
    'down',
  ),
  english: indicator('english', 'Réponses en anglais (%)', at('friction.reponses_anglais_pct'), 'pct', 'down'),
  guards: indicator('guards', 'Gardes posées', (w) => sumOf(countsAt(w.data, 'friction.gardes_posees'))),
  toolCalls: indicator('toolCalls', 'Appels d’outils', at('outils.appels')),
  agentErrors: indicator('agentErrors', 'Erreurs de l’agent (% appels)', at('outils.erreurs_agent_pct'), 'pct', 'down'),
  classifierDenied: indicator(
    'classifierDenied',
    'Refus du classifieur',
    (w) => sumOf(countsAt(w.data, 'outils.refus_classifieur')),
    'count',
    'down',
  ),
  noVerdict: indicator(
    'noVerdict',
    'Classifieur sans verdict / 100 Bash',
    at('outils.classifieur_sans_verdict_pour_100_bash'),
    'rate',
    'down',
  ),
  guardDenied: indicator(
    'guardDenied',
    'Refus du garde',
    (w) => {
      const counts = countsAt(w.data, 'outils.erreurs');
      return counts ? (counts.guard_denied ?? 0) : null;
    },
    'count',
    'down',
  ),
  sleep: indicator('sleep', 'sleep au premier plan', at('outils.sleep_premier_plan'), 'count', 'down'),
  rtkProxy: indicator('rtkProxy', 'rtk proxy', at('outils.rtk_proxy')),
  commits: indicator('commits', 'Commits lancés par l’agent', at('outils.commits_agent')),
  codexExec: indicator('codexExec', 'codex exec', at('outils.codex_exec')),
  stopHookErrors: indicator('stopHookErrors', 'Erreurs de hook Stop', at('outils.erreurs_hook_stop'), 'count', 'down'),
  compactions: indicator('compactions', 'Compactions', at('friction.compactions')),
  advisorSessions: indicator('advisorSessions', 'Advisor : sessions avec appel', at('advisor.sessions_avec_appel')),
  advisorCalls: indicator('advisorCalls', 'Advisor : appels', at('advisor.appels')),
  advisorLatency: indicator(
    'advisorLatency',
    'Advisor : latence médiane (s)',
    at('advisor.latence_mediane_s'),
    'seconds',
  ),
  advisorCost: indicator('advisorCost', 'Advisor : part du coût (%)', at('tokens.part_advisor_pct'), 'pct'),
  mcpSlack: indicator(
    'mcpSlack',
    'MCP Slack',
    mcp((s) => s === 'claude_ai_Slack'),
  ),
  mcpGoogle: indicator(
    'mcpGoogle',
    'MCP Google (Docs, Sheets, Drive)',
    mcp((s) => GOOGLE.has(s)),
  ),
  mcpOther: indicator(
    'mcpOther',
    'MCP, autres serveurs',
    mcp((s) => s !== 'claude_ai_Slack' && !GOOGLE.has(s)),
  ),
  mcpServers: indicator('mcpServers', 'MCP : serveurs utilisés', (w) => {
    const counts = countsAt(w.data, 'outils_externes.appels');
    return counts ? Object.keys(counts).filter((key) => key.startsWith('mcp:')).length : null;
  }),
  mcpErrors: indicator(
    'mcpErrors',
    'MCP : appels en erreur',
    mcp(() => true, 'erreurs'),
    'count',
    'down',
  ),
  glab: indicator('glab', 'glab (GitLab)', external('glab')),
  gh: indicator('gh', 'gh (GitHub)', external('gh')),
  psql: indicator('psql', 'psql', external('psql')),
  adb: indicator('adb', 'adb', external('adb')),
  curl: indicator('curl', 'curl', external('curl')),
  ssh: indicator('ssh', 'ssh, scp, rsync', external('ssh')),
  cerebroCli: indicator('cerebroCli', 'CLI Cerebro (tasks, backlog, notify…)', external('cerebro')),
  cerebroHelp: indicator('cerebroHelp', 'lectures de leur aide', external('cerebro_aide'), 'count', 'down', true),
  cerebroErrors: indicator('cerebroErrors', 'appels en erreur', external('cerebro', 'erreurs'), 'count', 'down', true),
  jsonReread: indicator('jsonReread', 'Sorties relues par python3 -c ou jq', external('json_relu')),
} satisfies Record<string, Indicator>;

const I = INDICATORS;

/** Rows of the report's main table, in its order. */
export const MAIN_ROWS: Indicator[] = [
  I.activeDays,
  I.sessions,
  I.messages,
  I.messagesPerSession,
  I.complaintsManual,
  I.complaintsHaiku,
  I.defects,
  I.complaintsRegex,
  I.regexActed,
  I.regexDoubt,
  I.regexWrong,
  I.regexBroken,
  I.regexIncomplete,
  I.regexMisread,
  I.regexQuality,
  I.regexRepeat,
  I.progressRequests,
  I.antiSlop,
  I.interruptions,
  I.english,
  I.guards,
  I.toolCalls,
  I.agentErrors,
  I.classifierDenied,
  I.noVerdict,
  I.guardDenied,
  I.sleep,
  I.rtkProxy,
  I.commits,
  I.codexExec,
  I.stopHookErrors,
  I.compactions,
  I.advisorSessions,
  I.advisorCalls,
  I.advisorLatency,
  I.advisorCost,
];

/** Rows of the report's « Outils externes » table, in its order. */
export const EXTERNAL_ROWS: Indicator[] = [
  I.mcpSlack,
  I.mcpGoogle,
  I.mcpOther,
  I.mcpServers,
  I.mcpErrors,
  I.glab,
  I.gh,
  I.psql,
  I.adb,
  I.curl,
  I.ssh,
  I.cerebroCli,
  I.cerebroHelp,
  I.cerebroErrors,
  I.jsonReread,
];

/** Haiku complaint categories, largest overall first; `repetition` and `autre` fold into « autres ». */
export const COMPLAINT_CATEGORIES: { key: string; label: string; keys: string[] }[] = [
  { key: 'ne_marche_pas', label: 'Ne marche pas', keys: ['ne_marche_pas'] },
  { key: 'exactitude', label: 'Exactitude', keys: ['exactitude'] },
  { key: 'clarte', label: 'Clarté', keys: ['clarte'] },
  { key: 'incomplet', label: 'Incomplet', keys: ['incomplet'] },
  { key: 'qualite_rendu', label: 'Qualité du rendu', keys: ['qualite_rendu'] },
  { key: 'agi_sans_demande', label: 'Agi sans demande', keys: ['agi_sans_demande'] },
];

/** Haiku complaint counts of a week, per displayed category; null without a Haiku classification. */
export function complaintCategories(week: WeekView): number[] | null {
  const counts = countsAt(week.data, 'friction.plaintes_haiku.categories');
  if (!counts) return null;
  const known = new Set(COMPLAINT_CATEGORIES.flatMap((c) => c.keys));
  const rest = sumOf(counts, (key) => !known.has(key)) ?? 0;
  return [...COMPLAINT_CATEGORIES.map((c) => c.keys.reduce((sum, key) => sum + (counts[key] ?? 0), 0)), rest];
}

/** Last finished week and the one before it, for the headline tiles. */
export function headlineWeeks(weeks: readonly WeekView[]): { current: WeekView; previous: WeekView | null } | null {
  const index = weeks.findLastIndex((week) => week.complete);
  if (index < 0) return null;
  return { current: weeks[index]!, previous: index > 0 ? weeks[index - 1]! : null };
}
