import { useEffect, useId, useState, type FormEvent } from 'react';
import { addSlackWatch, getSlackWatches, removeSlackWatch, setSlackWatchDelivery, setSlackWatchLabel } from './api.ts';
import { useAsyncAction } from './async-action.ts';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import { errorMessage, formatDateTime, formatDuration, sessionTitle } from './format.ts';
import { useNow } from './polling.tsx';
import { href } from './route.ts';
import { DELIVERY_LABELS, toggled } from './SlackWatchSettings.tsx';
import { useStoredFlag } from './storage.ts';
import { useStore } from './store.tsx';
import {
  WATCH_DELIVERIES,
  type SlackWatchInfo,
  type SlackWatchList,
  type WatchDelivery,
} from '../../shared/machine.ts';
import type { Session } from '../../shared/types.ts';

// Horodatage Slack (secondes.microsecondes) en millisecondes.
function slackDate(ts: string): string {
  const seconds = Number(ts);
  return Number.isFinite(seconds) ? formatDateTime(seconds * 1000) : ts;
}

/**
 * Libellé d'un fil, renommé sur place : un clic ouvre le champ, Entrée ou la sortie du champ enregistre, Échap
 * annule. Vide, le fil reprend son libellé par défaut.
 */
function WatchLabel({
  label,
  fallback,
  disabled,
  onRename,
}: {
  label: string | undefined;
  fallback: string;
  disabled: boolean;
  onRename: (label: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing)
    return (
      <button
        type="button"
        className="slack-watch-label"
        disabled={disabled}
        title="Renommer ce fil"
        onClick={() => setEditing(true)}
      >
        {label ?? fallback}
      </button>
    );
  const commit = (value: string): void => {
    setEditing(false);
    if (value.trim() !== (label ?? '')) onRename(value.trim());
  };
  return (
    <input
      className="slack-watch-label-input"
      aria-label="Libellé du fil"
      autoFocus
      maxLength={200}
      defaultValue={label ?? ''}
      placeholder={fallback}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          e.currentTarget.value = label ?? '';
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Ajout d'un fil par son lien Slack, pour une des sessions en cours (choisie dans la vue projet). */
function AddSlackWatchForm({
  sessions,
  onAdded,
  onClose,
}: {
  sessions: Session[];
  onAdded: () => Promise<void>;
  onClose: () => void;
}) {
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? '');
  const [link, setLink] = useState('');
  const [label, setLabel] = useState('');
  const add = useAsyncAction(
    async (target: string) => {
      await addSlackWatch(target, link.trim(), label.trim() === '' ? undefined : label.trim());
      await onAdded();
      onClose();
    },
    { fallback: 'Ajout impossible' },
  );
  const chosen = sessions.some((session) => session.id === sessionId) ? sessionId : (sessions[0]?.id ?? '');
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void add.run(chosen);
  };

  return (
    <form className="slack-watch-add" onSubmit={onSubmit}>
      {sessions.length > 1 ? (
        <select
          aria-label="Session qui reçoit les messages"
          value={chosen}
          onChange={(e) => setSessionId(e.target.value)}
        >
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {sessionTitle(session.title)}
            </option>
          ))}
        </select>
      ) : null}
      <input
        className="slack-watch-add-link"
        type="url"
        required
        autoFocus
        placeholder="Lien Slack d’un message, d’un fil ou d’un canal"
        title="« Copier le lien » dans Slack : le fil du message, ou le niveau principal pour un lien de canal"
        value={link}
        onChange={(e) => setLink(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      />
      <input
        className="slack-watch-add-label"
        placeholder="Libellé (facultatif)"
        maxLength={200}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <button type="submit" className="btn primary slack-watch-btn" disabled={add.busy || chosen === ''}>
        Surveiller
      </button>
      <button type="button" className="btn slack-watch-btn" onClick={onClose}>
        Annuler
      </button>
      {add.error ? <span className="form-error">{add.error}</span> : null}
    </form>
  );
}

/**
 * Fils et canaux Slack surveillés pour `sessions` (cerebro-slack-watch, surveillance après un post), relus à chaque
 * changement diffusé par le serveur. Un fil s'ajoute aussi par son lien Slack. Rien n'est affiché sans jeton
 * utilisateur, ni sans surveillance ou session en cours.
 */
export function SlackWatches({ sessions, showSession }: { sessions: Session[]; showSession: boolean }) {
  const { slackWatchesVersion, connected, projects } = useStore();
  const now = useNow();
  const [list, setList] = useState<SlackWatchList | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Repli mémorisé par ce navigateur, séparément pour la vue projet et la vue session.
  const [collapsed, setCollapsed] = useStoredFlag(
    `cerebro.slackWatchesCollapsed.${showSession ? 'project' : 'session'}`,
    false,
  );
  const listId = useId();
  const [adding, setAdding] = useState(false);
  const watches = list?.watches ?? [];
  const setWatches = (update: (watches: SlackWatchInfo[]) => SlackWatchInfo[]) =>
    setList((current) => (current === null ? current : { ...current, watches: update(current.watches) }));
  // Retirée aussitôt de la liste : la diffusion du serveur peut manquer pendant une reconnexion.
  const remove = useAsyncAction(
    async (watch: SlackWatchInfo) => {
      await removeSlackWatch(watch.sessionId, watch.id);
      setWatches((list) => list.filter((candidate) => candidate !== watch));
    },
    {
      fallback: 'Suppression impossible',
      onError: setError,
    },
  );
  // null : la surveillance suit de nouveau les réglages Slack. Appliquée aussitôt, comme le retrait.
  const setDelivery = useAsyncAction(
    async (watch: SlackWatchInfo, deliver: WatchDelivery[] | null) => {
      await setSlackWatchDelivery(watch.sessionId, watch.id, deliver);
      setWatches((list) =>
        list.map((candidate) => {
          if (candidate !== watch) return candidate;
          const { deliver: _previous, ...rest } = candidate;
          return deliver === null ? rest : { ...rest, deliver };
        }),
      );
    },
    {
      fallback: 'Remise impossible à modifier',
      onError: setError,
    },
  );

  // Libellé vide : le fil reprend son libellé par défaut. Appliqué aussitôt, comme la remise.
  const rename = useAsyncAction(
    async (watch: SlackWatchInfo, label: string) => {
      await setSlackWatchLabel(watch.sessionId, watch.id, label);
      setWatches((list) =>
        list.map((candidate) => {
          if (candidate !== watch) return candidate;
          const { label: _previous, ...rest } = candidate;
          return label === '' ? rest : { ...rest, label };
        }),
      );
    },
    {
      fallback: 'Libellé impossible à modifier',
      onError: setError,
    },
  );

  // Une reconnexion peut avoir manqué des diffusions : la liste est aussi relue à ce moment.
  useEffect(() => {
    let cancelled = false;
    void getSlackWatches()
      .then((value) => {
        if (cancelled) return;
        setList(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Surveillances Slack indisponibles'));
      });
    return () => {
      cancelled = true;
    };
  }, [slackWatchesVersion, connected]);

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const shown = watches.filter((watch) => byId.has(watch.sessionId));
  const running = list?.enabled ? sessions.filter((session) => session.status !== 'exited') : [];
  if (shown.length === 0 && running.length === 0 && error === null) return null;
  // Relue sans attendre la diffusion du serveur, qui peut manquer pendant une reconnexion.
  const reload = async (): Promise<void> => {
    setList(await getSlackWatches());
    setCollapsed(false);
  };

  return (
    <section className={`card slack-watches${showSession ? '' : ' compact'}`} aria-label="Fils Slack surveillés">
      <h2>
        <button
          type="button"
          className="slack-watches-toggle"
          aria-expanded={!collapsed}
          aria-controls={listId}
          title={collapsed ? 'Afficher les fils surveillés' : 'Replier les fils surveillés'}
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="task-caret" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          Fils Slack surveillés <span className="pill">{shown.length}</span>
        </button>
        {running.length > 0 && !adding ? (
          <button
            type="button"
            className="btn slack-watch-btn"
            title="Surveiller un fil ou un canal Slack à partir de son lien"
            onClick={() => setAdding(true)}
          >
            + Ajouter
          </button>
        ) : null}
      </h2>
      {adding && running.length > 0 ? (
        <AddSlackWatchForm sessions={running} onAdded={reload} onClose={() => setAdding(false)} />
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
      <ul id={listId} className="slack-watch-list" hidden={collapsed}>
        {shown.map((watch) => {
          const session = byId.get(watch.sessionId);
          const ended = session?.status === 'exited';
          const own = projects.find((project) => project.id === session?.projectId)?.slackSettings ?? null;
          // Projet sans envoi Slack : seule l'injection reste, quelle que soit la remise propre.
          const muted = own?.mode === 'off';
          const defaults = own === null ? (list?.defaultDeliver ?? []) : own.watchDeliveryLive;
          const modes = muted ? defaults : (watch.deliver ?? defaults);
          const fallback = watch.threadTs === null ? 'Canal entier' : 'Fil';
          const label = watch.label ?? fallback;
          const where = `#${watch.channel}${watch.threadTs === null ? ' · messages hors fil' : ` · fil du ${slackDate(watch.threadTs)}`}`;
          return (
            <li key={`${watch.sessionId}:${watch.id}`} className="slack-watch">
              <span className="slack-watch-main" title={`${label} — ${where}`}>
                <WatchLabel
                  label={watch.label}
                  fallback={fallback}
                  disabled={rename.busy}
                  onRename={(value) => void rename.run(watch, value)}
                />{' '}
                <span className="meta">{where}</span>
              </span>
              {showSession && session ? (
                <a className="meta slack-watch-session" href={href(`#/s/${session.id}`)}>
                  {sessionTitle(session.title)}
                  {session.status === 'exited' ? ' (terminée)' : ''}
                </a>
              ) : null}
              <fieldset
                className="slack-watch-deliver"
                aria-label="Remise"
                disabled={setDelivery.busy || ended || muted}
                title={
                  ended
                    ? 'Session terminée : la remise des sessions terminées s’applique'
                    : muted
                      ? 'Aucun envoi Slack pour ce projet (réglages Slack du projet)'
                      : undefined
                }
              >
                {WATCH_DELIVERIES.map((mode) => (
                  <label
                    key={mode}
                    className="slack-toggle"
                    title={`Remise : ${DELIVERY_LABELS[mode].hint}${mode === 'inject' || list?.botEnabled ? '' : ' (jeton du bot requis)'}`}
                  >
                    <input
                      type="checkbox"
                      checked={modes.includes(mode)}
                      // Au moins un mode tant que la session tourne.
                      disabled={modes.length === 1 && modes[0] === mode}
                      onChange={(e) =>
                        void setDelivery.run(watch, toggled(WATCH_DELIVERIES, modes, mode, e.target.checked))
                      }
                    />
                    {DELIVERY_LABELS[mode].label}
                    {mode === 'inject' || list?.botEnabled ? '' : '*'}
                  </label>
                ))}
                {ended ? (
                  <span className="meta">terminée</span>
                ) : muted ? (
                  <span className="meta">Slack coupé</span>
                ) : watch.deliver ? (
                  <button
                    type="button"
                    className="btn slack-watch-btn"
                    title="Revenir à la remise des réglages Slack"
                    onClick={() => void setDelivery.run(watch, null)}
                  >
                    Par défaut
                  </button>
                ) : (
                  <span
                    className="meta"
                    title={
                      own === null
                        ? 'Remise des réglages Slack (panneau Slack, Fils surveillés)'
                        : 'Remise des réglages Slack du projet'
                    }
                  >
                    {own === null ? 'défaut' : 'défaut (projet)'}
                  </span>
                )}
              </fieldset>
              <span className="meta slack-watch-meta" title={`Expire le ${formatDateTime(watch.expiresAt)}`}>
                {watch.expiresAt > now ? `expire dans ${formatDuration(watch.expiresAt - now)}` : 'expirée'}
              </span>
              <span className="meta slack-watch-meta" title="Dernier message lu : seuls les suivants sont remis">
                vu {slackDate(watch.lastTs)}
              </span>
              <DelayedActionButton
                className="btn danger-ghost slack-watch-btn"
                disabled={remove.busy}
                title={`Ne plus surveiller « ${label} » pour cette session, après 5 s (second clic ou Échap pour annuler)`}
                onAction={() => void remove.run(watch)}
              >
                Supprimer
              </DelayedActionButton>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
