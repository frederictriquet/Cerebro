import { AgentLabel } from './AgentLabel.tsx';
import { useEffect, useState } from 'react';
import { getUpdates, getUsage, setAutoUpdate, startUpdate } from './api.ts';
import { relativeTime } from './format.ts';
import { useNow } from './route.ts';
import type { AgentAuth, AgentUpdate, AgentUsage, UsageWindow } from '../../shared/machine.ts';

/** Why a team login has no gauge: /usage hits the same endpoint and gets no percent. */
const GROK_USAGE_HINT = [
  "Compte d'équipe : xAI ne publie pas de pourcentage de conso pour ce login.",
  '/usage lit GET /v1/billing?format=credits : la fenêtre hebdomadaire est renvoyée, sans creditUsagePercent ni répartition par produit. Le plafond mensuel est à 0.',
  "Les limites (débit de l'API, crédits) se règlent dans la console xAI par un admin. Le jeton OAuth d'un membre ne peut pas les lire.",
].join('\n');

const REFRESH_MS = 60_000;
// While a CLI updates, follow it closely.
const UPDATING_REFRESH_MS = 3_000;
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
    const tone = left <= DAY_MS ? ' high' : left <= 3 * DAY_MS ? ' warn' : '';
    return (
      <span className={`auth-line${tone}`} title={`Le jeton de renouvellement expire le ${fullDate(auth.loginExpiresAt)}`}>
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
    <span className="auth-line" title={title}>
      {auth.renewedAt === null
        ? 'Connexion renouvelée auto.'
        : `Connexion renouvelée ${relativeTime(Date.parse(auth.renewedAt), now)}`}
    </span>
  );
}

/** Installed version, update button when a newer one exists, and the auto-update switch. */
function UpdateLine({ update, onChange }: { update: AgentUpdate; onChange: (next: AgentUpdate) => void }) {
  const [failed, setFailed] = useState<string | null>(null);
  const act = (call: () => Promise<AgentUpdate>): void => {
    setFailed(null);
    void call().then(onChange, (cause: unknown) => setFailed(cause instanceof Error ? cause.message : String(cause)));
  };
  const lastFailure = update.lastRun !== null && !update.lastRun.ok ? update.lastRun : null;
  const checked = update.checkedAt === null ? null : `vérifié le ${fullDate(update.checkedAt)}`;
  return (
    <div className="update-line">
      <span className="update-version" title={[update.error, checked].filter(Boolean).join('\n')}>
        {update.installed === null ? 'version inconnue' : `v${update.installed}`}
      </span>
      {update.updating ? (
        <span className="update-badge busy">Mise à jour…</span>
      ) : update.available ? (
        <button
          type="button"
          className="update-badge"
          title={`Installer ${update.latest ?? ''} (les sessions ouvertes gardent leur version jusqu'à relance)`}
          onClick={() => act(() => startUpdate(update.agent))}
        >
          ↑ {update.latest}
        </button>
      ) : update.error === null ? (
        <span className="update-ok" title={checked ?? undefined}>à jour</span>
      ) : (
        <span className="update-error" title={update.error}>⚠</span>
      )}
      <label className="update-auto" title="Installer automatiquement les nouvelles versions (vérification toutes les heures)">
        <input
          type="checkbox"
          checked={update.auto}
          onChange={(event) => {
            const auto = event.target.checked;
            act(() => setAutoUpdate(update.agent, auto));
          }}
        />
        auto update
      </label>
      {lastFailure === null ? null : (
        <p className="usage-error" title={lastFailure.output}>
          Échec de la mise à jour ({fullDate(lastFailure.at)}) : {lastFailure.output.split('\n').at(-1)}
        </p>
      )}
      {failed === null ? null : <p className="usage-error">{failed}</p>}
    </div>
  );
}

function AgentGauges({
  usage,
  update,
  now,
  onUpdate,
}: {
  usage: AgentUsage;
  update: AgentUpdate | undefined;
  now: number;
  onUpdate: (next: AgentUpdate) => void;
}) {
  const updated = usage.updatedAt === null ? null : Date.parse(usage.updatedAt);
  return (
    <div className="usage-agent">
      <div className="usage-agent-head">
        <span className="usage-agent-name"><AgentLabel agent={usage.agent} /></span>
        {usage.auth === null ? null : <AuthLine auth={usage.auth} now={now} />}
      </div>
      {update === undefined ? null : <UpdateLine update={update} onChange={onUpdate} />}
      {usage.windows.map((w) => <Gauge key={w.label} window={w} now={now} />)}
      {usage.agent === 'codex' && updated !== null ? (
        <span className="usage-updated" title="Codex ne publie ses quotas que pendant qu'il tourne">
          quotas relevés {relativeTime(updated, now)}
        </span>
      ) : null}
      {usage.error === null ? null : (
        <p className="usage-error" title={usage.agent === 'grok' ? GROK_USAGE_HINT : undefined}>
          {usage.error}
        </p>
      )}
    </div>
  );
}

export function UsageGauges() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('cerebro.usageCollapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem('cerebro.usageCollapsed', next ? '1' : '0');
    } catch {
      /* Le panneau reste utilisable si le stockage est indisponible. */
    }
  };
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

  const [updates, setUpdates] = useState<AgentUpdate[]>([]);
  const updating = updates.some((u) => u.updating);
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void getUpdates().then(
        (result) => {
          if (!cancelled) setUpdates(result);
        },
        () => {},
      );
    };
    load();
    const timer = window.setInterval(load, updating ? UPDATING_REFRESH_MS : REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [updating]);
  const replaceUpdate = (next: AgentUpdate): void => {
    setUpdates((current) => current.map((u) => (u.agent === next.agent ? next : u)));
  };

  return (
    <section className="side-section side-usage">
      <h2>
        <button
          type="button"
          className="usage-toggle"
          aria-expanded={!collapsed}
          aria-controls="sidebar-usage-content"
          title={collapsed ? 'Afficher la consommation' : 'Replier la consommation'}
          onClick={toggleCollapsed}
        >
          Consommation
          <span aria-hidden="true">{collapsed ? '▴' : '▾'}</span>
        </button>
      </h2>
      <div id="sidebar-usage-content" hidden={collapsed}>
        {usage === null ? (
          <p className="empty-hint">{failed ? 'Indisponible' : 'Chargement…'}</p>
        ) : (
          <div className="usage-grid">
            {usage.map((u) => (
              <AgentGauges
                key={u.agent}
                usage={u}
                update={updates.find((x) => x.agent === u.agent)}
                now={now}
                onUpdate={replaceUpdate}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
