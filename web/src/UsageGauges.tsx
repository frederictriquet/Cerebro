import { useEffect, useState } from 'react';
import { getUsage, type AgentAuth, type AgentUsage, type UsageWindow } from './api.ts';
import { AGENT_LABEL, relativeTime } from './format.ts';
import { useNow } from './route.ts';

const REFRESH_MS = 60_000;
const DAY_MS = 86_400_000;

function untilReset(resetsAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
  return `${Math.floor(hours / 24)} j ${hours % 24} h`;
}

function resetDate(resetsAt: string): string {
  return new Date(resetsAt).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function level(percent: number): 'ok' | 'warn' | 'high' {
  if (percent >= 90) return 'high';
  if (percent >= 70) return 'warn';
  return 'ok';
}

/** Share of the window already elapsed: consumption ahead of it means the limit will be hit early. */
function elapsedPercent(window: UsageWindow, now: number): number | null {
  if (window.resetsAt === null || window.minutes === null) return null;
  const remaining = (Date.parse(window.resetsAt) - now) / 60_000;
  return Math.min(100, Math.max(0, 100 - (remaining / window.minutes) * 100));
}

function Gauge({ window, now }: { window: UsageWindow; now: number }) {
  const percent = Math.round(window.percent);
  const elapsed = elapsedPercent(window, now);
  const title = [
    `${window.label} : ${percent} % utilisé`,
    elapsed === null ? null : `${Math.round(elapsed)} % de la période écoulée`,
    window.resetsAt === null ? null : `réinitialisation ${resetDate(window.resetsAt)}`,
  ].filter(Boolean).join('\n');
  // Fragment: label, track and value are cells of the section's grid, so columns line up across agents.
  return (
    <>
      <span className="gauge-label" title={title}>{window.label}</span>
      <div
        className="gauge-track"
        title={title}
        role="meter"
        aria-label={`${window.label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className={`gauge-fill ${level(window.percent)}`} style={{ width: `${window.percent}%` }} />
        {elapsed === null ? null : <div className="gauge-pace" style={{ left: `${elapsed}%` }} />}
      </div>
      <span className={`gauge-value ${level(window.percent)}`} title={title}>{percent} %</span>
      {window.resetsAt === null ? null : (
        <span className="gauge-reset">réinit. dans {untilReset(window.resetsAt, now)}</span>
      )}
    </>
  );
}

function fullDate(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Login status: a firm deadline when the CLI records one (Claude), otherwise the last renewal. */
function AuthLine({ auth, now }: { auth: AgentAuth; now: number }) {
  if (auth.error !== null) return <span className="auth-line high">{auth.error}</span>;
  if (auth.loginExpiresAt !== null) {
    const left = Date.parse(auth.loginExpiresAt) - now;
    const tone = left <= DAY_MS ? 'high' : left <= 3 * DAY_MS ? 'warn' : 'ok';
    return (
      <span className={`auth-line ${tone}`} title={`Le jeton de renouvellement expire le ${fullDate(auth.loginExpiresAt)}`}>
        {left <= 0 ? 'Reconnexion requise' : `Reconnexion dans ${untilReset(auth.loginExpiresAt, now)}`}
      </span>
    );
  }
  const expired = auth.accessExpiresAt !== null && Date.parse(auth.accessExpiresAt) <= now;
  const title = [
    "Renouvelée automatiquement : la date de reconnexion n'est pas publiée par le CLI",
    auth.accessExpiresAt === null ? null : `jeton d'accès valable jusqu'au ${fullDate(auth.accessExpiresAt)}`,
    expired ? 'il sera renouvelé au prochain lancement' : null,
  ].filter(Boolean).join('\n');
  return (
    <span className="auth-line ok" title={title}>
      {auth.renewedAt === null
        ? 'Connexion renouvelée auto.'
        : `Connexion renouvelée ${relativeTime(Date.parse(auth.renewedAt), now)}`}
    </span>
  );
}

function AgentGauges({ usage, now }: { usage: AgentUsage; now: number }) {
  const updated = usage.updatedAt === null ? null : Date.parse(usage.updatedAt);
  return (
    <div className="usage-agent">
      <div className="usage-agent-head">
        <span className="usage-agent-name">{AGENT_LABEL[usage.agent]}</span>
        {usage.auth === null ? null : <AuthLine auth={usage.auth} now={now} />}
      </div>
      {usage.windows.map((w) => <Gauge key={w.label} window={w} now={now} />)}
      {usage.agent === 'codex' && updated !== null ? (
        <span className="usage-updated" title="Codex ne publie ses quotas que pendant qu'il tourne">
          quotas relevés {relativeTime(updated, now)}
        </span>
      ) : null}
      {usage.error === null ? null : <p className="usage-error">{usage.error}</p>}
    </div>
  );
}

export function UsageGauges() {
  const [usage, setUsage] = useState<AgentUsage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const now = useNow(REFRESH_MS);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void getUsage()
        .then((result) => {
          if (cancelled) return;
          setUsage(result);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <section className="side-section side-usage">
      <h2>Consommation</h2>
      {usage === null ? (
        <p className="empty-hint">{failed ? 'Indisponible' : 'Chargement…'}</p>
      ) : (
        <div className="usage-grid">
          {usage.map((u) => <AgentGauges key={u.agent} usage={u} now={now} />)}
        </div>
      )}
    </section>
  );
}
