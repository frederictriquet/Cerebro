import { useState } from 'react';
import {
  WATCH_DELIVERIES,
  WATCH_ENDED_DELIVERIES,
  type SlackSettings,
  type SlackStatus,
  type WatchDelivery,
} from '../../shared/machine.ts';

// Alertes et messages postés par Cerebro : réglages de la machine, ou d'un projet (ProjectSlackDialog).
export const SLACK_ALERT_TOGGLES: { key: 'waiting' | 'idle' | 'agentMessages'; label: string; hint: string }[] = [
  { key: 'waiting', label: 'Confirmations', hint: 'Une session attend une validation ou une réponse' },
  { key: 'idle', label: 'Fins de tour', hint: "L'agent a terminé et rend la main" },
  {
    key: 'agentMessages',
    label: 'Messages des agents',
    hint: 'Envoyés par cerebro-notify (notifications et questions)',
  },
];

export const DELIVERY_LABELS: Record<WatchDelivery, { label: string; hint: string }> = {
  inject: { label: 'Injecter', hint: 'Tapé dans la session comme prochain message' },
  dm: { label: 'DM', hint: 'Posté dans le DM du bot Cerebro' },
  notify: { label: 'Notification', hint: 'Posté dans le fil de notification de la session, comme cerebro-notify' },
};

const WATCH_TOGGLES: { key: 'watchIncludeSelf' | 'watchAutoOnPost'; label: string; hint: string }[] = [
  {
    key: 'watchAutoOnPost',
    label: 'Surveiller après un post',
    hint: 'Une session qui poste via le connecteur Slack surveille ce fil automatiquement',
  },
  {
    key: 'watchIncludeSelf',
    label: 'Inclure mes messages',
    hint: 'Remet aussi vos propres messages, dont ceux postés par vos sessions',
  },
];

/** Champ numérique enregistré à la sortie du champ (ou sur Entrée) ; une valeur hors bornes est refusée. */
export function NumberSetting({
  label,
  unit,
  value,
  min,
  max,
  step = 1,
  disabled = false,
  invalid,
  onSave,
  onError,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  invalid: string;
  onSave: (value: number) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  const commit = (): void => {
    const parsed = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(parsed) || parsed < min || parsed > max) {
      setDraft(String(value));
      onError(invalid);
      return;
    }
    if (Math.round(parsed) !== value) onSave(Math.round(parsed));
  };

  return (
    <label className="slack-delay">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      {unit}
    </label>
  );
}

// Ordre canonique des modes, quel que soit l'ordre des clics.
export function toggled<T extends WatchDelivery>(all: readonly T[], current: readonly T[], mode: T, on: boolean): T[] {
  return all.filter((candidate) => (candidate === mode ? on : current.includes(candidate)));
}

/** Réglages de la surveillance des fils et canaux Slack (jeton utilisateur), dans le panneau Slack. */
export function SlackWatchSettings({
  status,
  save,
  onError,
}: {
  status: SlackStatus;
  save: (patch: Partial<SlackSettings>) => void;
  onError: (message: string) => void;
}) {
  const live = status.watchDeliveryLive;
  const ended = status.watchDeliveryEnded;
  const botHint = status.enabled ? '' : ' (jeton du bot requis)';

  return (
    <div className="slack-watch-settings">
      <h3>Fils surveillés</h3>
      {status.watchEnabled ? null : (
        <p className="empty-hint">
          Surveillance désactivée : définissez CEREBRO_SLACK_USER_TOKEN (jeton utilisateur xoxp, lecture seule) puis
          redémarrez Cerebro. Ces réglages s'appliqueront alors.
        </p>
      )}
      <fieldset className="slack-deliveries">
        <legend>Session active</legend>
        {WATCH_DELIVERIES.map((mode) => (
          <label key={mode} className="slack-toggle" title={DELIVERY_LABELS[mode].hint}>
            <input
              type="checkbox"
              checked={live.includes(mode)}
              // Au moins un mode tant que la session tourne.
              disabled={live.length === 1 && live[0] === mode}
              onChange={(e) => save({ watchDeliveryLive: toggled(WATCH_DELIVERIES, live, mode, e.target.checked) })}
            />
            {DELIVERY_LABELS[mode].label}
            {mode === 'inject' ? '' : botHint}
          </label>
        ))}
      </fieldset>
      <fieldset className="slack-deliveries">
        <legend title="Plus rien ne peut être tapé dans la session ; sans mode coché, le message est ignoré">
          Session terminée
        </legend>
        {WATCH_ENDED_DELIVERIES.map((mode) => (
          <label key={mode} className="slack-toggle" title={DELIVERY_LABELS[mode].hint}>
            <input
              type="checkbox"
              checked={ended.includes(mode)}
              onChange={(e) =>
                save({ watchDeliveryEnded: toggled(WATCH_ENDED_DELIVERIES, ended, mode, e.target.checked) })
              }
            />
            {DELIVERY_LABELS[mode].label}
            {botHint}
          </label>
        ))}
        {ended.length === 0 ? <p className="meta">Aucun : les messages sont ignorés.</p> : null}
      </fieldset>
      <NumberSetting
        key={`interval-${status.watchIntervalSec}`}
        label="Relecture d'un fil"
        unit="s"
        value={status.watchIntervalSec}
        min={5}
        max={3600}
        step={5}
        invalid="Relecture entre 5 et 3600 secondes"
        onSave={(value) => save({ watchIntervalSec: value })}
        onError={onError}
      />
      <NumberSetting
        key={`ttl-${status.watchTtlDays}`}
        label="Durée de vie"
        unit="j"
        value={status.watchTtlDays}
        min={1}
        max={365}
        invalid="Durée de vie entre 1 et 365 jours"
        onSave={(value) => save({ watchTtlDays: value })}
        onError={onError}
      />
      {WATCH_TOGGLES.map((toggle) => (
        <label key={toggle.key} className="slack-toggle" title={toggle.hint}>
          <input
            type="checkbox"
            checked={status[toggle.key]}
            onChange={(e) => save({ [toggle.key]: e.target.checked })}
          />
          {toggle.label}
        </label>
      ))}
    </div>
  );
}
