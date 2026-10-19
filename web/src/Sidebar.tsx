import { AgentLabel } from './AgentLabel.tsx';
import { useEffect, useRef, useState } from 'react';
import {
  acquireGeneralSlack,
  getGeneralSlack,
  getSlackStatus,
  updateSlackSettings,
  type GeneralSlackStatus,
  type SlackSettings,
  type SlackStatus,
} from './api.ts';
import { relativeTime, sessionTitle } from './format.ts';
import { AppVersion, MachineSwitcher } from './MachineSwitcher.tsx';
import { href, useNow, type Route } from './route.ts';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import { UsageGauges } from './UsageGauges.tsx';
import type { Session } from './types.ts';
import { PreviewButton, ScreenPopover, usePreviewController } from './ScreenPreview.tsx';

export function Sidebar({ route, onNavigate }: { route: Route; onNavigate: () => void }) {
  const { sessions, connected, muted, setMuted, desktopNotif, setDesktopNotif } = useStore();
  const now = useNow();
  const [slack, setSlack] = useState<SlackStatus | null>(null);
  const [showSlack, setShowSlack] = useState(false);

  const attention = sessions.filter((s) => s.attention);
  const activeSessionId = route.kind === 'session' ? route.sessionId : null;

  useEffect(() => {
    let cancelled = false;
    void getSlackStatus()
      .then((status) => {
        if (!cancelled) setSlack(status);
      })
      .catch(() => {
        /* endpoint missing or Slack unconfigured: pill stays off */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <aside className="sidebar" id="sidebar">
      <MachineSwitcher />
      <header className="sidebar-head">
        <div className={`ws-pill ${connected ? 'on' : 'off'}`}>
          {connected ? 'connecté' : 'reconnexion…'}
        </div>
        <button
          type="button"
          className={`slack-pill ${slack?.enabled ? 'on' : 'off'}`}
          aria-expanded={showSlack}
          disabled={slack === null}
          title={slack?.enabled ? 'Réglages des notifications Slack' : 'Slack non configuré (voir README)'}
          onClick={() => setShowSlack(!showSlack)}
        >
          Slack
        </button>
        <button
          type="button"
          className={`btn-mute${muted ? ' off' : ''}`}
          aria-pressed={muted}
          title={muted ? 'Activer le son' : 'Couper le son'}
          onClick={() => setMuted(!muted)}
        >
          Son
        </button>
        <button
          type="button"
          className={`btn-mute${desktopNotif ? '' : ' off'}`}
          aria-pressed={!desktopNotif}
          title={
            desktopNotif
              ? 'Couper les notifications système (toaster du bureau et son de l’OS)'
              : 'Réactiver les notifications système'
          }
          onClick={() => setDesktopNotif(!desktopNotif)}
        >
          Notif
        </button>
      </header>
      {showSlack && slack !== null ? <SlackPanel status={slack} onChange={setSlack} /> : null}

      <section className="side-section side-attention">
        <h2>
          À traiter
          {attention.length > 0 ? <span className="count">{attention.length}</span> : null}
        </h2>
        {attention.length === 0 ? (
          <p className="empty-hint">Rien pour le moment</p>
        ) : (
          <ul className="side-list">
            {attention.map((s) => (
              <AttentionItem
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                now={now}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}
      </section>

      <UsageGauges />
      <AppVersion />
    </aside>
  );
}

const SLACK_TOGGLES: { key: 'waiting' | 'idle' | 'agentMessages'; label: string; hint: string }[] = [
  { key: 'waiting', label: 'Confirmations', hint: 'Une session attend une validation ou une réponse' },
  { key: 'idle', label: 'Fins de tour', hint: "L'agent a terminé et rend la main" },
  { key: 'agentMessages', label: 'Messages des agents', hint: 'Envoyés par cerebro-notify (notifications et questions)' },
];

function SlackPanel({ status, onChange }: { status: SlackStatus; onChange: (status: SlackStatus) => void }) {
  const [delay, setDelay] = useState(String(status.delaySeconds));
  const [error, setError] = useState<string | null>(null);

  const save = async (patch: Partial<SlackSettings>): Promise<void> => {
    setError(null);
    const previous = status;
    onChange({ ...status, ...patch });
    try {
      onChange(await updateSlackSettings(patch));
    } catch (err) {
      onChange(previous);
      setError(err instanceof Error ? err.message : 'Enregistrement impossible');
    }
  };

  const saveDelay = (): void => {
    const seconds = Number(delay);
    if (delay.trim() === '' || !Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {
      setDelay(String(status.delaySeconds));
      setError('Délai entre 0 et 3600 secondes');
      return;
    }
    if (Math.round(seconds) !== status.delaySeconds) void save({ delaySeconds: Math.round(seconds) });
  };

  return (
    <div className="slack-panel">
      {status.enabled ? null : (
        <p className="empty-hint">Slack n'est pas configuré : ces réglages s'appliqueront une fois le jeton défini.</p>
      )}
      {SLACK_TOGGLES.map((toggle) => (
        <label key={toggle.key} className="slack-toggle" title={toggle.hint}>
          <input
            type="checkbox"
            checked={status[toggle.key]}
            onChange={(e) => void save({ [toggle.key]: e.target.checked })}
          />
          {toggle.label}
        </label>
      ))}
      <label className="slack-delay">
        Délai avant alerte
        <input
          type="number"
          min={0}
          max={3600}
          step={5}
          value={delay}
          disabled={!status.waiting && !status.idle}
          onChange={(e) => setDelay(e.target.value)}
          onBlur={saveDelay}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        s
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <GeneralSlackLead />
    </div>
  );
}

// Plusieurs machines lisent le même DM : une seule traite les commandes sans projet. On prend la main, on ne la rend pas.
function GeneralSlackLead() {
  const { peersVersion } = useStore();
  const [status, setStatus] = useState<GeneralSlackStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getGeneralSlack()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'État de la prise de main indisponible');
      });
    return () => {
      cancelled = true;
    };
  }, [peersVersion]);

  if (!status?.shared && error === null) return null;
  const local = status?.owner === 'local';
  const acquire = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await acquireGeneralSlack());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Prise de main impossible');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {status ? (
        <label
          className="slack-toggle"
          title={local ? "On ne rend pas la main : prends-la depuis l'autre machine." : 'Traiter ici help, list et les questions « ? »'}
        >
          <input type="checkbox" checked={local} disabled={local || busy} onChange={() => void acquire()} />
          Commandes générales
        </label>
      ) : null}
      {status ? (
        <p className="meta">
          {local
            ? `help, list et « ? » traités par cette machine${status.manual ? '' : ' (choix automatique)'}`
            : `help, list et « ? » traités par ${status.ownerMachine}${status.manual ? '' : ' (choix automatique)'}`}
        </p>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </>
  );
}

function AttentionItem({
  session,
  active,
  now,
  onNavigate,
}: {
  session: Session;
  active: boolean;
  now: number;
  onNavigate: () => void;
}) {
  const tone = session.status === 'waiting' ? 'waiting' : 'idle';
  const preview = usePreviewController();
  const anchorRef = useRef<HTMLSpanElement>(null);
  return (
    <li className="attention-item">
      <a
        href={href(`#/s/${session.id}`)}
        className={`attention-link ${tone} ${active ? 'active' : ''}`}
        onClick={onNavigate}
      >
        <StatusDot status={session.status === 'waiting' ? 'waiting' : 'idle'} />
        <span className="session-link-title">{sessionTitle(session.title)}</span>
        <span className="meta">
          <AgentLabel agent={session.agent} /> · {relativeTime(session.updatedAt, now)}
        </span>
      </a>
      <div className="attention-extra">
        {session.attentionReason ? <p className={`reason-line ${tone}`}>{session.attentionReason}</p> : null}
        <PreviewButton pressed={preview.open} onToggle={preview.toggle} anchorRef={anchorRef} />
      </div>
      {preview.open ? <ScreenPopover sessionId={session.id} anchorRef={anchorRef} /> : null}
    </li>
  );
}
