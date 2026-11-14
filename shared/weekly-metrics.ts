import { array, nullable, object, parser, record, string, unknown } from './parse.ts';

/**
 * Weekly Claude Code usage records written by `~/.claude/scripts/weekly_metrics.py` under
 * `~/.claude/metrics`. The week objects are passed through untouched: the script owns their format and the
 * web UI reads each value through a checked accessor (`web/src/weekly-metrics.ts`).
 */
/**
 * Comments written by the weekly analysis session in `syntheses.json` (next to the machine's `weeks` folder):
 * one short text per chart or chart group, keyed `semaine`, `messages`, `plaintes`, `categories`, `erreurs`,
 * `corrections`, `advisor` or `outils_externes`.
 */
export interface WeeklySyntheses {
  /** Last finished week the texts comment on, `<year>-W<week>`. */
  semaine: string;
  /** Day the texts were written, `YYYY-MM-DD`. */
  redige_le: string;
  textes: Record<string, string>;
}

const weeklySyntheses = object<WeeklySyntheses>({ semaine: string, redige_le: string, textes: record(string) });
export const parseWeeklySyntheses = parser(weeklySyntheses);

export interface WeeklyMetricsMachine {
  /** `local` for this machine's own records, otherwise the folder name under `metrics/machines`. */
  id: string;
  name: string;
  /** One object per `<year>-W<week>.json` file, oldest first. */
  weeks: Record<string, unknown>[];
  /** Manual complaint readings from `manual.json`, keyed by week (this machine only). */
  manual: Record<string, unknown>;
  /** Comments of the weekly analysis; null when none were written for this machine. */
  syntheses: WeeklySyntheses | null;
}

export interface WeeklyMetricsReport {
  directory: string;
  machines: WeeklyMetricsMachine[];
  /** Files that could not be read or parsed, with the reason. */
  problems: string[];
}

export const parseWeeklyMetricsReport = parser(
  object<WeeklyMetricsReport>({
    directory: string,
    machines: array(
      object<WeeklyMetricsMachine>({
        id: string,
        name: string,
        weeks: array(record(unknown)),
        manual: record(unknown),
        syntheses: nullable(weeklySyntheses),
      }),
    ),
    problems: array(string),
  }),
);
