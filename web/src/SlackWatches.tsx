import { useEffect, useState } from 'react';
import { getSlackWatches, removeSlackWatch, setSlackWatchDelivery } from './api.ts';
import { useAsyncAction } from './async-action.ts';
import { errorMessage, formatDateTime, formatDuration, sessionTitle } from './format.ts';
import { useNow } from './polling.tsx';
import { href } from './route.ts';
import { DELIVERY_LABELS, toggled } from './SlackWatchSettings.tsx';
import { useStore } from './store.tsx';
import { WATCH_DELIVERIES, type SlackWatchInfo, type SlackWatchList, type WatchDelivery } from '../../shared/machine.ts';
import type { Session } from '../../shared/types.ts';

// Horodatage Slack (secondes.microsecondes) en millisecondes.
function slackDate(ts: string): string {
  const seconds = Number(ts);
  return Number.isFinite(seconds) ? formatDateTime(seconds * 1000) : ts;
}

/**
 * Fils et canaux Slack surveillés pour `sessions` (cerebro-slack-watch, surveillance après un post), relus à chaque
 * changement diffusé par le serveur. Rien n'est affiché sans surveillance ni jeton utilisateur.
 */
export function SlackWatches({ sessions, showSession }: { sessions: Session[]; showSession: boolean }) {
  const { slackWatchesVersion, connected, projects } = useStore();
  const now = useNow();
  const [list, setList] = useState<SlackWatchList | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  if (shown.length === 0 && error === null) return null;

  return (
    <section className={`card slack-watches${showSession ? '' : ' compact'}`} aria-label="Fils Slack surveillés">
      <h2>
        Fils Slack surveillés <span className="pill">{shown.length}</span>
      </h2>
      {error ? <p className="form-error">{error}</p> : null}
      <ul className="slack-watch-list">
        {shown.map((watch) => {
          const session = byId.get(watch.sessionId);
          const ended = session?.status === 'exited';
          const own = projects.find((project) => project.id === session?.projectId)?.slackSettings ?? null;
          // Projet sans envoi Slack : seule l'injection reste, quelle que soit la remise propre.
          const muted = own?.mode === 'off';
          const defaults = own === null ? (list?.defaultDeliver ?? []) : own.watchDeliveryLive;
          const modes = muted ? defaults : (watch.deliver ?? defaults);
          return (
            <li key={`${watch.sessionId}:${watch.id}`} className="slack-watch">
              <div className="slack-watch-main">
                <strong>{watch.label ?? (watch.threadTs === null ? 'Canal entier' : 'Fil')}</strong>
                <span className="meta">
                  #{watch.channel}
                  {watch.threadTs === null ? ' · messages hors fil' : ` · fil du ${slackDate(watch.threadTs)}`}
                </span>
                {showSession && session ? (
                  <a className="meta" href={href(`#/s/${session.id}`)}>
                    {sessionTitle(session.title)}
                    {session.status === 'exited' ? ' (terminée)' : ''}
                  </a>
                ) : null}
              </div>
              <div className="slack-watch-meta meta">
                <span title={`Expire le ${formatDateTime(watch.expiresAt)}`}>
                  {watch.expiresAt > now ? `expire dans ${formatDuration(watch.expiresAt - now)}` : 'expirée'}
                </span>
                <span title="Dernier message lu : seuls les suivants sont remis">
                  vu jusqu'au {slackDate(watch.lastTs)}
                </span>
              </div>
              <fieldset
                className="slack-deliveries slack-watch-deliver"
                disabled={setDelivery.busy || ended || muted}
                title={
                  ended
                    ? 'Session terminée : la remise des sessions terminées s’applique'
                    : muted
                      ? 'Aucun envoi Slack pour ce projet (réglages Slack du projet)'
                      : undefined
                }
              >
                <legend className="meta">Remise</legend>
                {WATCH_DELIVERIES.map((mode) => (
                  <label key={mode} className="slack-toggle" title={DELIVERY_LABELS[mode].hint}>
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
                    {mode === 'inject' || list?.botEnabled ? '' : ' (jeton du bot requis)'}
                  </label>
                ))}
                {ended ? (
                  <span className="meta">session terminée</span>
                ) : muted ? (
                  <span className="meta">Slack coupé pour ce projet</span>
                ) : watch.deliver ? (
                  <button
                    type="button"
                    className="btn"
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
                    {own === null ? 'par défaut' : 'par défaut (projet)'}
                  </span>
                )}
              </fieldset>
              <button
                type="button"
                className="btn"
                disabled={remove.busy}
                title="Ne plus surveiller ce fil pour cette session"
                onClick={() => void remove.run(watch)}
              >
                Retirer
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
