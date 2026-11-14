import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import { getWeeklyMetrics } from './api.ts';
import { errorMessage } from './format.ts';
import { usePolling } from './polling.tsx';
import {
  COMPLAINT_CATEGORIES,
  EXTERNAL_ROWS,
  INDICATORS,
  MAIN_ROWS,
  complaintCategories,
  headlineWeeks,
  weekLabel,
  weekViews,
  type Indicator,
  type Unit,
  type WeekView,
} from './weekly-metrics.ts';
import type { WeeklyMetricsReport } from '../../shared/weekly-metrics.ts';
import './weekly-metrics.css';

/** Weeks drawn in the charts; the table lists every week of the machine. */
const SHOWN_WEEKS = 12;
const REFRESH_MS = 5 * 60_000;

const integer = new Intl.NumberFormat('fr-FR');
const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const decimal1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const decimal2 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const dayMonth = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const longDay = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' });

// Categorical slots of the dataviz reference palette, dark steps, validated on --bg-1 (#10141b).
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'];

function formatValue(value: number | null, unit: Unit): string {
  if (value === null) return '—';
  if (unit === 'pct') return `${decimal1.format(value)} %`;
  if (unit === 'rate') return decimal2.format(value);
  if (unit === 'seconds') return `${decimal1.format(value)} s`;
  return integer.format(value);
}

function formatTick(value: number, unit: Unit): string {
  if (unit === 'pct') return `${decimal1.format(value)} %`;
  return value >= 10_000 ? compact.format(value) : decimal1.format(value);
}

function localDate(iso: string): Date | null {
  const [y, m, d] = iso.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}

function weekRange(week: WeekView): string {
  const start = week.start ? localDate(week.start) : null;
  const end = week.end ? localDate(week.end) : null;
  return start && end ? `${dayMonth.format(start)} – ${dayMonth.format(end)}` : week.id;
}

function weekState(week: WeekView): string | null {
  if (!week.complete) return 'en cours';
  if (week.truncated) return 'début tronqué';
  return null;
}

/** Round axis maximum close above `max`, whose half is round too; an even integer for counts. */
function niceMax(max: number, unit: Unit): number {
  if (max <= 0) return unit === 'count' ? 2 : 1;
  const power = 10 ** Math.floor(Math.log10(max));
  const step = [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].find((f) => f * power >= max - 1e-9) ?? 10;
  const nice = Math.round(step * power * 1e6) / 1e6;
  return unit === 'count' ? Math.max(2, Math.ceil(nice / 2) * 2) : nice;
}

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(Math.floor(element.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

interface Series {
  label: string;
  color: string;
  values: (number | null)[];
}

/** Rounded data end, square at the baseline. */
function barPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, height, width / 2);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function WeekChart({
  title,
  weeks,
  series,
  kind,
  unit,
  mini = false,
}: {
  title: string;
  weeks: readonly WeekView[];
  series: Series[];
  kind: 'bar' | 'stacked' | 'line';
  unit: Unit;
  mini?: boolean;
}) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const height = mini ? 96 : 180;
  const pad = { top: 18, right: 10, bottom: 20, left: mini ? 30 : 40 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const n = weeks.length;
  const band = n === 0 ? 0 : plotW / n;
  const totals = weeks.map((_, i) => {
    const values = series.map((s) => s.values[i] ?? null);
    if (values.every((v) => v === null)) return null;
    return kind === 'stacked'
      ? values.reduce<number>((sum, v) => sum + (v ?? 0), 0)
      : Math.max(...values.map((v) => v ?? 0));
  });
  const top = niceMax(Math.max(0, ...totals.map((t) => t ?? 0)), unit);
  const ticks = mini ? [0, top] : [0, top / 2, top];
  const y = (value: number): number => pad.top + plotH - (value / top) * plotH;
  const cx = (i: number): number => pad.left + band * (i + 0.5);
  const barW = Math.max(2, Math.min(24, band * 0.62));
  const baseline = pad.top + plotH;
  const labelEvery = mini ? n - 1 : band < 34 ? 2 : 1;
  const showLabel = (i: number): boolean =>
    mini ? i === 0 || i === n - 1 : (n - 1 - i) % Math.max(1, labelEvery) === 0;

  const lastIndex = totals.findLastIndex((t) => t !== null);
  const single = series.length === 1 ? series[0]! : null;
  // The week in progress is partial: the direct label and the summary give the last finished week.
  const labelIndex = weeks.findLastIndex((week, i) => week.complete && totals[i] !== null);
  const summary =
    labelIndex >= 0
      ? `${title} : ${weeks[labelIndex]!.label} ${formatValue(single ? (single.values[labelIndex] ?? null) : totals[labelIndex]!, unit)}`
      : `${title} : aucune donnée`;

  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (n === 0) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const from = active ?? n - 1;
      setActive(Math.min(n - 1, Math.max(0, from + (event.key === 'ArrowLeft' ? -1 : 1))));
    } else if (event.key === 'Escape') {
      setActive(null);
    }
  };

  const tooltipWeek = active === null ? null : weeks[active];
  const tooltipX = active === null ? 0 : cx(active);
  const align = tooltipX < 110 ? 'start' : tooltipX > width - 110 ? 'end' : 'center';

  return (
    <div className="week-chart">
      {series.length > 1 ? (
        <ul className="week-chart-legend">
          {series.map((s) => (
            <li key={s.label}>
              <span
                className={kind === 'line' ? 'week-key-line' : 'week-key-box'}
                style={{ background: s.color }}
                aria-hidden="true"
              />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      <div
        ref={ref}
        className="week-chart-plot"
        role="img"
        aria-label={summary}
        tabIndex={0}
        onKeyDown={move}
        onFocus={() => setActive((current) => current ?? (lastIndex >= 0 ? lastIndex : null))}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        {width > 0 ? (
          <svg width={width} height={height} aria-hidden="true">
            {active !== null ? (
              <rect className="week-chart-hover" x={pad.left + band * active} y={pad.top} width={band} height={plotH} />
            ) : null}
            {ticks.map((tick) => (
              <g key={tick}>
                <line className="week-chart-grid" x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} />
                <text className="week-chart-tick" x={pad.left - 6} y={y(tick)} dy="0.32em" textAnchor="end">
                  {formatTick(tick, unit)}
                </text>
              </g>
            ))}
            {weeks.map((week, i) =>
              showLabel(i) ? (
                <text
                  key={week.id}
                  className={`week-chart-tick${week.complete ? '' : ' partial'}`}
                  x={cx(i)}
                  y={height - 5}
                  textAnchor="middle"
                >
                  {week.label}
                </text>
              ) : null,
            )}

            {weeks.map((week, i) =>
              totals[i] === null ? (
                <text
                  key={`none-${week.id}`}
                  className="week-chart-none"
                  x={cx(i)}
                  y={baseline - 4}
                  textAnchor="middle"
                >
                  —
                </text>
              ) : null,
            )}

            {kind === 'bar' && single
              ? weeks.map((week, i) => {
                  const value = single.values[i] ?? null;
                  if (value === null || value <= 0) return null;
                  return (
                    <path
                      key={week.id}
                      d={barPath(cx(i) - barW / 2, y(value), barW, baseline - y(value))}
                      fill={single.color}
                      opacity={week.complete ? 1 : 0.45}
                    />
                  );
                })
              : null}

            {kind === 'stacked'
              ? weeks.map((week, i) => {
                  let sum = 0;
                  const parts = series.map((s) => s.values[i] ?? 0);
                  const topPart = parts.findLastIndex((v) => v > 0);
                  return parts.map((value, k) => {
                    if (value <= 0) return null;
                    const y1 = y(sum + value);
                    const y0 = y(sum) - (sum > 0 ? 2 : 0);
                    sum += value;
                    const h = y0 - y1;
                    if (h <= 0) return null;
                    const x = cx(i) - barW / 2;
                    return k === topPart ? (
                      <path
                        key={`${week.id}-${k}`}
                        d={barPath(x, y1, barW, h)}
                        fill={series[k]!.color}
                        opacity={week.complete ? 1 : 0.45}
                      />
                    ) : (
                      <rect
                        key={`${week.id}-${k}`}
                        x={x}
                        y={y1}
                        width={barW}
                        height={h}
                        fill={series[k]!.color}
                        opacity={week.complete ? 1 : 0.45}
                      />
                    );
                  });
                })
              : null}

            {kind === 'line'
              ? series.map((s) => {
                  const runs: string[] = [];
                  let open = false;
                  s.values.forEach((value, i) => {
                    if (value === null) {
                      open = false;
                      return;
                    }
                    runs.push(`${open ? 'L' : 'M'}${cx(i)},${y(value)}`);
                    open = true;
                  });
                  return (
                    <g key={s.label}>
                      <path className="week-chart-line" d={runs.join('')} stroke={s.color} />
                      {s.values.map((value, i) =>
                        value === null ? null : (
                          <circle
                            key={weeks[i]!.id}
                            className="week-chart-dot"
                            cx={cx(i)}
                            cy={y(value)}
                            r={4}
                            fill={weeks[i]!.complete ? s.color : 'var(--bg-1)'}
                            stroke={weeks[i]!.complete ? 'var(--bg-1)' : s.color}
                          />
                        ),
                      )}
                    </g>
                  );
                })
              : null}

            {single && !mini && labelIndex >= 0 ? (
              <text
                className="week-chart-value"
                x={cx(labelIndex)}
                y={y(single.values[labelIndex] ?? 0) - 8}
                textAnchor={cx(labelIndex) > width - 24 ? 'end' : 'middle'}
              >
                {formatValue(single.values[labelIndex] ?? null, unit)}
              </text>
            ) : null}

            {weeks.map((week, i) => (
              <rect
                key={`hit-${week.id}`}
                className="week-chart-hit"
                x={pad.left + band * i}
                y={0}
                width={band}
                height={height}
                onPointerEnter={() => setActive(i)}
              />
            ))}
          </svg>
        ) : null}
        {tooltipWeek && active !== null ? (
          <div className={`week-chart-tooltip ${align}`} style={{ left: tooltipX }}>
            <div className="week-chart-tooltip-head">
              {tooltipWeek.label} · {weekRange(tooltipWeek)}
              {weekState(tooltipWeek) ? <span> ({weekState(tooltipWeek)})</span> : null}
            </div>
            {(kind === 'stacked' ? [...series].reverse() : series).map((s) => (
              <div key={s.label} className="week-chart-tooltip-row">
                <span className="week-key-line" style={{ background: s.color }} aria-hidden="true" />
                <b>{formatValue(s.values[active] ?? null, unit)}</b>
                <span>{s.label}</span>
              </div>
            ))}
            {kind === 'stacked' ? (
              <div className="week-chart-tooltip-row total">
                <b>{formatValue(totals[active] ?? null, unit)}</b>
                <span>Total</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Comment of the weekly analysis on a chart or a group of charts. */
function Synthesis({ text }: { text: string | undefined }) {
  return text ? <p className="weekly-synthesis">{text}</p> : null;
}

function ChartCard({
  title,
  hint,
  value,
  synthesis,
  children,
  mini = false,
}: {
  title: string;
  hint?: string;
  /** Value of the last finished week, shown beside the title of a small chart. */
  value?: ReactNode;
  synthesis?: string | undefined;
  children: ReactNode;
  mini?: boolean;
}) {
  return (
    <section className={`weekly-card${mini ? ' mini' : ''}`}>
      <div className="weekly-card-head">
        <h4>{title}</h4>
        {value}
      </div>
      {hint ? <p className="weekly-card-hint">{hint}</p> : null}
      {children}
      <Synthesis text={synthesis} />
    </section>
  );
}

/** Where the comments come from and which week they cover; says so when the last finished week has none. */
function SynthesesState({
  machine,
  latest,
}: {
  machine: WeeklyMetricsReport['machines'][number];
  latest: WeekView | null;
}) {
  const syntheses = machine.syntheses;
  if (!syntheses) {
    return (
      <p className="weekly-note">
        Pas encore de commentaire pour {machine.name} : l’analyse hebdomadaire les écrit dans syntheses.json.
      </p>
    );
  }
  const written = new Date(`${syntheses.redige_le}T12:00:00`);
  const when = Number.isNaN(written.getTime()) ? syntheses.redige_le : longDay.format(written);
  const behind = latest !== null && syntheses.semaine < latest.id;
  return (
    <p className={`weekly-note${behind ? ' weekly-note-warn' : ''}`}>
      Commentaires de l’analyse hebdomadaire, écrits le {when} sur {weekLabel(syntheses.semaine)}
      {behind ? ` : ${latest.label} n’est pas encore commentée` : ''}.
    </p>
  );
}

function IndicatorChart({
  indicator,
  weeks,
  kind = 'bar',
}: {
  indicator: Indicator;
  weeks: readonly WeekView[];
  kind?: 'bar' | 'line';
}) {
  const values = weeks.map(indicator.get);
  const last = weeks.findLastIndex((week, i) => week.complete && values[i] !== null);
  return (
    <ChartCard
      title={indicator.sub ? `CLI Cerebro : ${indicator.label}` : indicator.label}
      mini
      value={
        last >= 0 ? (
          <span className="weekly-card-value">
            {weeks[last]!.label} <b>{formatValue(values[last] ?? null, indicator.unit)}</b>
          </span>
        ) : null
      }
    >
      <WeekChart
        title={indicator.label}
        weeks={weeks}
        kind={kind}
        unit={indicator.unit}
        mini
        series={[{ label: indicator.label, color: SERIES[0]!, values }]}
      />
    </ChartCard>
  );
}

function Tile({
  indicator,
  current,
  previous,
}: {
  indicator: Indicator;
  current: WeekView;
  previous: WeekView | null;
}) {
  const value = indicator.get(current);
  const before = previous ? indicator.get(previous) : null;
  const delta = value !== null && before !== null ? value - before : null;
  const rounded = delta === null ? null : Math.round(delta * 10) / 10;
  const tone =
    rounded === null || rounded === 0 || indicator.better === null
      ? 'neutral'
      : rounded < 0 === (indicator.better === 'down')
        ? 'good'
        : 'bad';
  const deltaText =
    rounded === null
      ? null
      : `${rounded > 0 ? '+' : rounded < 0 ? '−' : '±'}${
          indicator.unit === 'pct'
            ? `${decimal1.format(Math.abs(rounded))} pt`
            : formatValue(Math.abs(rounded), indicator.unit)
        }`;
  return (
    <div className="weekly-tile">
      <span className="weekly-tile-label">{indicator.label}</span>
      <b className="weekly-tile-value">{formatValue(value, indicator.unit)}</b>
      {deltaText && previous ? (
        <span className={`weekly-tile-delta ${tone}`}>
          <span aria-hidden="true">{rounded! > 0 ? '▲' : rounded! < 0 ? '▼' : '='}</span> {deltaText}{' '}
          <span className="weekly-tile-since">par rapport à {previous.label}</span>
        </span>
      ) : (
        <span className="weekly-tile-delta neutral">Pas de semaine précédente</span>
      )}
    </div>
  );
}

function ValuesTable({ caption, rows, weeks }: { caption: string; rows: Indicator[]; weeks: readonly WeekView[] }) {
  return (
    <div className="weekly-table-wrap">
      <table className="weekly-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Indicateur</th>
            {weeks.map((week) => (
              <th key={week.id} scope="col" title={weekRange(week)}>
                {week.label}
                {weekState(week) ? <span className="weekly-table-state">{weekState(week)}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={row.sub ? 'sub' : undefined}>
              <th scope="row">{row.label}</th>
              {weeks.map((week) => (
                <td key={week.id}>{formatValue(row.get(week), row.unit)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TRACKED = [
  INDICATORS.english,
  INDICATORS.sleep,
  INDICATORS.rtkProxy,
  INDICATORS.noVerdict,
  INDICATORS.classifierDenied,
  INDICATORS.stopHookErrors,
  INDICATORS.progressRequests,
  INDICATORS.compactions,
];
const ADVISOR = [INDICATORS.advisorCalls, INDICATORS.advisorCost, INDICATORS.advisorLatency];
const EXTERNAL = [
  INDICATORS.cerebroCli,
  INDICATORS.cerebroHelp,
  INDICATORS.cerebroErrors,
  INDICATORS.jsonReread,
  INDICATORS.glab,
  INDICATORS.mcpSlack,
  INDICATORS.mcpGoogle,
  INDICATORS.mcpOther,
];
const TILES = [INDICATORS.messages, INDICATORS.complaintsHaiku, INDICATORS.agentErrors, INDICATORS.defects];

export function WeeklyMetrics() {
  const [report, setReport] = useState<WeeklyMetricsReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [machineId, setMachineId] = useState('local');
  usePolling(getWeeklyMetrics, REFRESH_MS, {
    onData: (result) => {
      setReport(result);
      setFailure(null);
    },
    onError: (cause) => setFailure(errorMessage(cause)),
  });

  const machine = report?.machines.find((m) => m.id === machineId) ?? report?.machines[0] ?? null;
  const allWeeks = machine ? weekViews(machine) : [];
  const weeks = allWeeks.slice(-SHOWN_WEEKS);
  const headline = headlineWeeks(allWeeks);
  const computedAt = allWeeks.at(-1)?.data.calcule_le;
  const computed =
    typeof computedAt === 'string' && !Number.isNaN(Date.parse(computedAt)) ? new Date(computedAt) : null;
  const manual = weeks.map(INDICATORS.complaintsManual.get);
  const categories = weeks.map(complaintCategories);
  const categoryLabels = [...COMPLAINT_CATEGORIES.map((c) => c.label), 'Autres'];
  const comment = (key: string): string | undefined => machine?.syntheses?.textes[key];

  return (
    <section className="weekly" aria-labelledby="weekly-title">
      <div className="weekly-head">
        <div>
          <h2 id="weekly-title">Analyse hebdomadaire des sessions Claude Code</h2>
          <p>
            Relevé du lundi 8 h, {report ? report.directory : '~/.claude/metrics'}
            {computed ? ` · dernier calcul le ${dateTime.format(computed)}` : ''}
          </p>
        </div>
        {report && report.machines.length > 1 && machine ? (
          <ChoiceGroup<string>
            label="Machine du relevé hebdomadaire"
            value={machine.id}
            onChange={setMachineId}
            compact
            options={report.machines.map((m) => ({ value: m.id, label: m.name }))}
          />
        ) : null}
      </div>

      {failure ? (
        <p className="form-error" role="alert">
          Relevés hebdomadaires indisponibles : {failure}
        </p>
      ) : null}
      {report && report.problems.length > 0 ? (
        <div className="form-error" role="alert">
          {report.problems.length === 1
            ? 'Un relevé est illisible :'
            : `${report.problems.length} relevés sont illisibles :`}
          <ul>
            {report.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {!report && !failure ? <p className="weekly-empty">Chargement des relevés…</p> : null}
      {report && !machine ? (
        <p className="weekly-empty">Aucun relevé hebdomadaire dans {report.directory} sur cette machine.</p>
      ) : null}

      {machine && weeks.length > 0 ? (
        <>
          <SynthesesState machine={machine} latest={headline?.current ?? null} />
          {headline ? (
            <>
              <h3 className="weekly-section-title">
                {headline.current.label} ({weekRange(headline.current)}), dernière semaine terminée
              </h3>
              <div className="weekly-tiles">
                {TILES.map((indicator) => (
                  <Tile
                    key={indicator.key}
                    indicator={indicator}
                    current={headline.current}
                    previous={headline.previous}
                  />
                ))}
              </div>
              <Synthesis text={comment('semaine')} />
            </>
          ) : null}

          <div className="weekly-grid">
            <ChartCard
              title="Messages tapés"
              hint="Messages écrits à la main dans les sessions interactives."
              synthesis={comment('messages')}
            >
              <WeekChart
                title="Messages tapés"
                weeks={weeks}
                kind="bar"
                unit="count"
                series={[{ label: 'Messages tapés', color: SERIES[0]!, values: weeks.map(INDICATORS.messages.get) }]}
              />
            </ChartCard>
            <ChartCard
              title="Plaintes visant l’agent (%)"
              hint="Part des messages tapés qui reprochent quelque chose à l’agent."
              synthesis={comment('plaintes')}
            >
              <WeekChart
                title="Plaintes visant l’agent"
                weeks={weeks}
                kind="line"
                unit="pct"
                series={[
                  { label: 'Classement Haiku', color: SERIES[0]!, values: weeks.map(INDICATORS.complaintsHaiku.get) },
                  ...(manual.some((v) => v !== null)
                    ? [{ label: 'Lecture manuelle', color: SERIES[1]!, values: manual }]
                    : []),
                ]}
              />
            </ChartCard>
            <ChartCard
              title="Plaintes par catégorie (Haiku)"
              hint="Nombre de messages classés comme plainte, par motif."
              synthesis={comment('categories')}
            >
              <WeekChart
                title="Plaintes par catégorie"
                weeks={weeks}
                kind="stacked"
                unit="count"
                series={categoryLabels.map((label, k) => ({
                  label,
                  color: SERIES[k]!,
                  values: categories.map((values) => (values ? (values[k] ?? 0) : null)),
                }))}
              />
            </ChartCard>
            <ChartCard
              title="Erreurs de l’agent (% des appels d’outils)"
              hint="Commandes échouées, refus et appels rejetés."
              synthesis={comment('erreurs')}
            >
              <WeekChart
                title="Erreurs de l’agent"
                weeks={weeks}
                kind="line"
                unit="pct"
                series={[
                  { label: 'Erreurs de l’agent', color: SERIES[0]!, values: weeks.map(INDICATORS.agentErrors.get) },
                ]}
              />
            </ChartCard>
          </div>

          <h3 className="weekly-section-title">Suivi des corrections</h3>
          <Synthesis text={comment('corrections')} />
          <div className="weekly-minis">
            {TRACKED.map((indicator) => (
              <IndicatorChart key={indicator.key} indicator={indicator} weeks={weeks} />
            ))}
          </div>

          <h3 className="weekly-section-title">Advisor</h3>
          <Synthesis text={comment('advisor')} />
          <div className="weekly-minis">
            {ADVISOR.map((indicator) => (
              <IndicatorChart
                key={indicator.key}
                indicator={indicator}
                weeks={weeks}
                kind={indicator.unit === 'count' ? 'bar' : 'line'}
              />
            ))}
          </div>

          <h3 className="weekly-section-title">Outils externes</h3>
          <p className="weekly-note">
            Base de la question hebdomadaire : un de ces usages justifie-t-il un serveur MCP ? « — » : mesure absente,
            les transcripts de la semaine ont été purgés avant l’ajout de la rubrique.
          </p>
          <Synthesis text={comment('outils_externes')} />
          <div className="weekly-minis">
            {EXTERNAL.map((indicator) => (
              <IndicatorChart key={indicator.key} indicator={indicator} weeks={weeks} />
            ))}
          </div>

          <details className="weekly-details">
            <summary>Tableau des valeurs, {allWeeks.length} semaines</summary>
            <ValuesTable caption={`Indicateurs, ${machine.name}`} rows={MAIN_ROWS} weeks={allWeeks} />
            <ValuesTable caption={`Outils externes, ${machine.name}`} rows={EXTERNAL_ROWS} weeks={allWeeks} />
          </details>
          <p className="weekly-note">
            Barres claires et points creux : semaine en cours. Les graphiques montrent les {SHOWN_WEEKS} dernières
            semaines au plus ; survolez une semaine ou parcourez-la au clavier avec les flèches.
          </p>
        </>
      ) : null}
    </section>
  );
}
