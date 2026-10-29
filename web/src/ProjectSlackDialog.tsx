import { useEffect, useState } from 'react';
import { ActivityStatus } from './ActivityStatus.tsx';
import { getSlackStatus } from './api.ts';
import { useAsyncAction } from './async-action.ts';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import { Modal } from './Dialog.tsx';
import { DELIVERY_LABELS, SLACK_ALERT_TOGGLES, toggled } from './SlackWatchSettings.tsx';
import { useStore } from './store.tsx';
import {
  WATCH_DELIVERIES,
  WATCH_ENDED_DELIVERIES,
  type Project,
  type ProjectSlackSettings,
} from '../../shared/types.ts';
import type { SlackStatus } from '../../shared/machine.ts';
import './automatic-commits.css';

type Choice = 'machine' | 'off' | 'custom';
type Posting = Omit<ProjectSlackSettings, 'mode'>;

// Valeurs de départ d'un réglage personnalisé : celles de la machine tant que le projet n'en a pas.
const FALLBACK_POSTING: Posting = {
  waiting: true,
  idle: false,
  agentMessages: true,
  watchDeliveryLive: ['inject'],
  watchDeliveryEnded: ['dm'],
};

function postingOf(settings: ProjectSlackSettings | SlackStatus): Posting {
  const { waiting, idle, agentMessages, watchDeliveryLive, watchDeliveryEnded } = settings;
  return { waiting, idle, agentMessages, watchDeliveryLive, watchDeliveryEnded };
}

/** Libellé court du réglage Slack d'un projet, pour son en-tête. */
export function projectSlackLabel(project: Project): string | null {
  if (project.slackSettings === null) return null;
  return project.slackSettings.mode === 'off' ? 'coupé' : 'personnalisé';
}

/** Ce que Cerebro poste dans Slack pour ce projet : réglages de la machine, rien, ou des réglages propres. */
export function ProjectSlackDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const { updateProject } = useStore();
  const own = project.slackSettings;
  const [choice, setChoice] = useState<Choice>(own === null ? 'machine' : own.mode);
  const [posting, setPosting] = useState<Posting>(own === null ? FALLBACK_POSTING : postingOf(own));
  const [machine, setMachine] = useState<SlackStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getSlackStatus()
      .then((status) => {
        if (cancelled) return;
        setMachine(status);
        if (own === null) setPosting(postingOf(status));
      })
      .catch(() => {
        /* machine sans Slack ou injoignable : les valeurs de repli suffisent */
      });
    return () => {
      cancelled = true;
    };
  }, [own]);

  const {
    run: save,
    busy,
    error,
  } = useAsyncAction(async () => {
    await updateProject(project.id, { slackSettings: choice === 'machine' ? null : { mode: choice, ...posting } });
    onClose();
  });
  const botHint = machine !== null && !machine.enabled ? ' (jeton du bot requis)' : '';
  const live = posting.watchDeliveryLive;

  return (
    <Modal title="Réglages Slack du projet" onClose={onClose}>
      <form
        className="commit-settings project-slack"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <ChoiceGroup<Choice>
          label="Envois Slack du projet"
          value={choice}
          disabled={busy}
          options={[
            {
              value: 'machine',
              label: 'Réglages généraux',
              title: 'Le panneau Slack de la barre latérale s’applique à ce projet',
            },
            { value: 'off', label: 'Aucun envoi', title: 'Rien de ce projet n’est posté dans Slack' },
            { value: 'custom', label: 'Personnalisé', title: 'Ces réglages remplacent ceux de la machine' },
          ]}
          onChange={setChoice}
        />
        {choice === 'machine' ? (
          <p>Le projet suit le panneau Slack de la barre latérale.</p>
        ) : choice === 'off' ? (
          <p>
            Ni alerte, ni message d’agent (<code>cerebro-notify</code> est refusé), ni résultat d’opération. Les
            messages des fils surveillés sont seulement tapés dans la session, et ignorés une fois celle-ci terminée.
            Une commande envoyée depuis Slack reçoit toujours sa réponse dans son fil.
          </p>
        ) : (
          <>
            <fieldset className="slack-deliveries">
              <legend>Alertes et messages</legend>
              {SLACK_ALERT_TOGGLES.map((toggle) => (
                <label key={toggle.key} className="slack-toggle" title={toggle.hint}>
                  <input
                    type="checkbox"
                    checked={posting[toggle.key]}
                    disabled={busy}
                    onChange={(e) => setPosting((current) => ({ ...current, [toggle.key]: e.target.checked }))}
                  />
                  {toggle.label}
                </label>
              ))}
            </fieldset>
            <fieldset className="slack-deliveries">
              <legend>Fils surveillés, session active</legend>
              {WATCH_DELIVERIES.map((mode) => (
                <label key={mode} className="slack-toggle" title={DELIVERY_LABELS[mode].hint}>
                  <input
                    type="checkbox"
                    checked={live.includes(mode)}
                    // Au moins un mode tant que la session tourne.
                    disabled={busy || (live.length === 1 && live[0] === mode)}
                    onChange={(e) =>
                      setPosting((current) => ({
                        ...current,
                        watchDeliveryLive: toggled(WATCH_DELIVERIES, current.watchDeliveryLive, mode, e.target.checked),
                      }))
                    }
                  />
                  {DELIVERY_LABELS[mode].label}
                  {mode === 'inject' ? '' : botHint}
                </label>
              ))}
            </fieldset>
            <fieldset className="slack-deliveries">
              <legend>Fils surveillés, session terminée</legend>
              {WATCH_ENDED_DELIVERIES.map((mode) => (
                <label key={mode} className="slack-toggle" title={DELIVERY_LABELS[mode].hint}>
                  <input
                    type="checkbox"
                    checked={posting.watchDeliveryEnded.includes(mode)}
                    disabled={busy}
                    onChange={(e) =>
                      setPosting((current) => ({
                        ...current,
                        watchDeliveryEnded: toggled(
                          WATCH_ENDED_DELIVERIES,
                          current.watchDeliveryEnded,
                          mode,
                          e.target.checked,
                        ),
                      }))
                    }
                  />
                  {DELIVERY_LABELS[mode].label}
                  {botHint}
                </label>
              ))}
              {posting.watchDeliveryEnded.length === 0 ? (
                <p className="meta">Aucun : les messages sont ignorés.</p>
              ) : null}
            </fieldset>
            <p className="hint">
              Le délai avant alerte et la lecture des fils (intervalle, durée de vie, mes messages, surveillance après
              un post) restent ceux du panneau Slack.
            </p>
          </>
        )}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row-actions">
          <button type="submit" className="btn primary" disabled={busy}>
            <ActivityStatus active={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</ActivityStatus>
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Annuler
          </button>
        </div>
      </form>
    </Modal>
  );
}
