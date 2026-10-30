import { AgentLabel } from './AgentLabel.tsx';
import { useEffect, useRef, useState } from 'react';
import { acquireGeneralSlack, getGeneralSlack, getSlackStatus, updateSlackSettings } from './api.ts';
import { errorMessage, needsAttention, relativeTime, sessionTitle } from './format.ts';
import { AppVersion, MachineSwitcher } from './MachineSwitcher.tsx';
import { href, type Route } from './route.ts';
import { useNow } from './polling.tsx';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import { UsageGauges } from './UsageGauges.tsx';
import { WorktreeLabel } from './WorktreeLabel.tsx';
import { SessionEpicBadge } from './SessionEpicBadge.tsx';
import { NumberSetting, SLACK_ALERT_TOGGLES, SlackWatchSettings } from './SlackWatchSettings.tsx';
import { projectSlackLabel } from './ProjectSlackDialog.tsx';
import type { Session } from '../../shared/types.ts';
import type { GeneralSlackStatus, SlackSettings, SlackStatus } from '../../shared/machine.ts';
import { useSessionPreview } from './ScreenPreview.tsx';
import { attentionTone, SessionAttention } from './SessionMeta.tsx';

export function Sidebar({ route, onNavigate }: { route: Route; onNavigate: () => void }) {
  const { sessions, connected, muted, setMuted, desktopNotif, setDesktopNotif } = useStore();
  const now = useNow();
  const [slack, setSlack] = useState<SlackStatus | null>(null);
  const [showSlack, setShowSlack] = useState(false);

  const attention = sessions.filter(needsAttention);
  const activeSessionId = route.kind === 'session' ? route.sessionId : null;

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const loadSlack = (open = false) => {
    void getSlackStatus()
      .then((status) => {
        if (!mounted.current) return;
        setSlack(status);
        if (open) setShowSlack(true);
      })
      .catch(() => {
        /* endpoint missing or transient error: retried on WS reconnect or on click */
      });
  };

  // Tant que le statut manque, on retente au montage et à chaque reconnexion WS.
  const slackLoaded = slack !== null;
  useEffect(() => {
    if (!slackLoaded) loadSlack();
  }, [connected, slackLoaded]);

  return (
    <aside className="sidebar" id="sidebar">
      <MachineSwitcher />
      <header className="sidebar-head">
        <div className={`ws-pill ${connected ? 'on' : 'off'}`}>{connected ? 'connecté' : 'reconnexion…'}</div>
        <button
          type="button"
          className={`slack-pill ${slack?.enabled || slack?.watchEnabled ? 'on' : 'off'}`}
          aria-expanded={showSlack}
          title={
            slack === null
              ? 'Statut Slack indisponible : cliquer pour réessayer'
              : slack.enabled || slack.watchEnabled
                ? 'Réglages des notifications et des fils surveillés Slack'
                : 'Slack non configuré (voir README)'
          }
          onClick={() => (slack === null ? loadSlack(true) : setShowSlack(!showSlack))}
        >
          Slack
        </button>
        <button
          type="button"
          className={`btn-mute${muted ? ' off' : ''}`}
          aria-pressed={!muted}
          title={muted ? 'Activer le son' : 'Couper le son'}
          onClick={() => setMuted(!muted)}
        >
          Son
        </button>
        <button
          type="button"
          className={`btn-mute${desktopNotif ? '' : ' off'}`}
          aria-pressed={desktopNotif}
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
      {showSlack && slack !== null ? <SlackPanel status={slack} onChange={setSlack} onNavigate={onNavigate} /> : null}

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

function SlackPanel({
  status,
  onChange,
  onNavigate,
}: {
  status: SlackStatus;
  onChange: (status: SlackStatus) => void;
  onNavigate: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const save = async (patch: Partial<SlackSettings>): Promise<void> => {
    setError(null);
    const previous = status;
    onChange({ ...status, ...patch });
    try {
      onChange(await updateSlackSettings(patch));
    } catch (err) {
      onChange(previous);
      setError(errorMessage(err, 'Enregistrement impossible'));
    }
  };

  return (
    <div className="slack-panel">
      {status.enabled ? null : (
        <p className="empty-hint">Slack n'est pas configuré : ces réglages s'appliqueront une fois le jeton défini.</p>
      )}
      <ProjectSlackOverrides onNavigate={onNavigate} />
      {SLACK_ALERT_TOGGLES.map((toggle) => (
        <label key={toggle.key} className="slack-toggle" title={toggle.hint}>
          <input
            type="checkbox"
            checked={status[toggle.key]}
            onChange={(e) => void save({ [toggle.key]: e.target.checked })}
          />
          {toggle.label}
        </label>
      ))}
      <NumberSetting
        key={`delay-${status.delaySeconds}`}
        label="Délai avant alerte"
        unit="s"
        value={status.delaySeconds}
        min={0}
        max={3600}
        step={5}
        disabled={!status.waiting && !status.idle}
        invalid="Délai entre 0 et 3600 secondes"
        onSave={(value) => void save({ delaySeconds: value })}
        onError={setError}
      />
      <GeneralSlackLead />
      <SlackWatchSettings status={status} save={(patch) => void save(patch)} onError={setError} />
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

// Ces réglages ne valent pas pour les projets qui ont les leurs : on les nomme pour éviter de chercher ici leur effet.
function ProjectSlackOverrides({ onNavigate }: { onNavigate: () => void }) {
  const { projects } = useStore();
  const overrides = projects.flatMap((project) => {
    const label = projectSlackLabel(project);
    return label === null ? [] : [{ project, label }];
  });
  if (overrides.length === 0) return null;
  return (
    <p className="meta">
      Remplacés par leurs propres réglages :{' '}
      {overrides.map(({ project, label }, index) => (
        <span key={project.id}>
          {index > 0 ? ', ' : null}
          <a
            href={href(`#/p/${encodeURIComponent(project.id)}`)}
            title="Ce projet a ses propres réglages Slack : bouton Slack de son en-tête"
            onClick={onNavigate}
          >
            {project.name}
          </a>{' '}
          ({label})
        </span>
      ))}
      .
    </p>
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
        if (!cancelled) setError(errorMessage(err, 'État de la prise de main indisponible'));
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
      setError(errorMessage(err, 'Prise de main impossible'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {status ? (
        <label
          className="slack-toggle"
          title={
            local
              ? "On ne rend pas la main : prends-la depuis l'autre machine."
              : 'Traiter ici help, list et les questions « ? »'
          }
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
  const tone = attentionTone(session);
  const preview = useSessionPreview(session.id);
  return (
    <li className="attention-item">
      <a
        href={href(`#/s/${session.id}`)}
        className={`attention-link ${tone} ${active ? 'active' : ''}`}
        onClick={onNavigate}
      >
        <StatusDot status={tone} />
        <span className="session-link-title">{sessionTitle(session.title)}</span>
        <span className="meta">
          <AgentLabel agent={session.agent} /> · {relativeTime(session.updatedAt, now)}
        </span>
        <SessionEpicBadge session={session} />
        {session.worktree ? (
          <span className="attention-worktree">
            <WorktreeLabel worktree={session.worktree} />
          </span>
        ) : null}
      </a>
      <div className="attention-extra">
        <SessionAttention session={session} onNavigate={onNavigate} />
        {preview.button}
      </div>
      {preview.popover}
    </li>
  );
}
