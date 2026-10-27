import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { getMachines, wsUrl } from './api.ts';
import { playAlert, readMuted, showAlertNotification, showFindingsNotification } from './notify.ts';
import { attentionCounts, plural } from './format.ts';
import { openReconnectingSocket } from './reconnectingSocket.ts';
import { goMachine, useMachine } from './route.ts';
import { usePolling } from './polling.tsx';
import { upsertById, useStore } from './store.tsx';
import { parseEventsMessage, type Session } from '../../shared/types.ts';
import type { Compatibility, MachinesInfo, RemoteVersionStatus, VersionInfo } from '../../shared/machine.ts';

interface WatchState {
  online: boolean;
  attention: number;
  waiting: number;
}

interface WatchTarget {
  key: string;
  base: string;
  machineId: string | null;
}

interface MachineWatch {
  info: MachinesInfo | null;
  hidden: Record<string, WatchState>;
}

const MACHINES_REFRESH_MS = 30_000;
const MachineWatchContext = createContext<MachineWatch>({ info: null, hidden: {} });


export function versionLabel(info: VersionInfo): string {
  return info.commit === null ? info.version : `${info.version}+${info.commit}`;
}

function compatibilityText(status: RemoteVersionStatus | null): string {
  if (status === null) return 'version pas encore vérifiée';
  const version = status.version === null ? null : `Cerebro ${versionLabel(status.version)}`;
  switch (status.compatibility) {
    case 'same':
      return `même version (${version})`;
    case 'compatible':
      return `version différente, même majeure (${version})`;
    case 'incompatible':
      return `INCOMPATIBLE (${version}) : mettre à jour l'une des machines`;
    case 'unknown':
      return status.reachable ? 'version inconnue (instance antérieure)' : 'version inconnue (machine injoignable)';
  }
}

const COMPAT_MARK: Record<Compatibility, string | null> = {
  same: null,
  compatible: '≈',
  incompatible: '⚠',
  unknown: 'v?',
};

/** Version de cette instance et, si la machine affichée est une machine distante, son statut. */
export function useMachineInfo(): MachinesInfo | null {
  return useContext(MachineWatchContext).info;
}

function hiddenTargets(remoteIds: string[], current: string | null): WatchTarget[] {
  if (remoteIds.length === 0) return [];
  const targets: WatchTarget[] = [];
  if (current !== null) targets.push({ key: 'local', base: '', machineId: null });
  for (const id of remoteIds) {
    if (id !== current) {
      targets.push({ key: id, base: `/m/${id}`, machineId: id });
    }
  }
  return targets;
}

function startWatcher(
  target: WatchTarget,
  setState: Dispatch<SetStateAction<Record<string, WatchState>>>,
): () => void {
  let stopped = false;
  let sessions: Session[] = [];

  const publish = (online: boolean): void => {
    if (stopped) return;
    const { total, waiting } = attentionCounts(sessions);
    setState((prev) => {
      const currentState = prev[target.key];
      if (
        currentState &&
        currentState.online === online &&
        currentState.attention === total &&
        currentState.waiting === waiting
      ) {
        return prev;
      }
      return { ...prev, [target.key]: { online, attention: total, waiting } };
    });
  };

  const connection = openReconnectingSocket(wsUrl('/ws/events', target.base), {
    onOpen: () => {
      publish(true);
    },
    onMessage: (raw) => {
      const msg = parseEventsMessage(raw);
      if (!msg) return;
      switch (msg.type) {
        case 'snapshot':
          sessions = msg.sessions;
          publish(true);
          break;
        case 'session':
          sessions = upsertById(sessions, msg.session, 'start');
          publish(true);
          break;
        case 'session-deleted':
          sessions = sessions.filter((item) => item.id !== msg.id);
          publish(true);
          break;
        case 'alert':
          sessions = upsertById(sessions, msg.session, 'start');
          publish(true);
          showAlertNotification(msg.session, target.machineId);
          if (!readMuted()) playAlert(msg.session.status);
          break;
        case 'findings-available':
          sessions = upsertById(sessions, msg.session, 'start');
          publish(true);
          showFindingsNotification(msg.session, target.machineId);
          if (!readMuted()) playAlert('idle');
          break;
        case 'projects':
          break;
      }
    },
    onClose: () => {
      publish(false);
    },
  });
  return () => {
    stopped = true;
    connection.close();
  };
}

export function MachineWatchProvider({ children }: { children: ReactNode }) {
  const current = useMachine();
  const [info, setInfo] = useState<MachinesInfo | null>(null);
  const [hidden, setHidden] = useState<Record<string, WatchState>>({});
  // Surveillances en cours par clé de machine : changer de machine n'arrête et ne lance que celles qui changent.
  const watchers = useRef(new Map<string, () => void>());

  // Rechargée périodiquement : la version d'une machine distante change quand elle est mise à jour.
  usePolling(getMachines, MACHINES_REFRESH_MS, {
    onData: (parsed) => setInfo((prev) => (JSON.stringify(prev) === JSON.stringify(parsed) ? prev : parsed)),
    onError: () => {
      /* pas de sélecteur si la liste est indisponible */
    },
  });

  // Clé stable : un changement de version ne doit pas rouvrir les WebSocket de surveillance.
  const remoteIds = info?.remotes.map((remote) => remote.id).join(',') ?? '';

  useEffect(() => {
    const wanted = hiddenTargets(remoteIds === '' ? [] : remoteIds.split(','), current);
    const wantedKeys = new Set(wanted.map((target) => target.key));
    setHidden((prev) => {
      let changed = false;
      const next: Record<string, WatchState> = {};
      for (const key of Object.keys(prev)) {
        const value = prev[key];
        if (value && wantedKeys.has(key)) next[key] = value;
        else changed = true;
      }
      return changed ? next : prev;
    });
    const running = watchers.current;
    for (const [key, stop] of running) {
      if (wantedKeys.has(key)) continue;
      stop();
      running.delete(key);
    }
    for (const target of wanted) {
      if (!running.has(target.key)) running.set(target.key, startWatcher(target, setHidden));
    }
  }, [remoteIds, current]);

  useEffect(() => {
    const running = watchers.current;
    return () => {
      for (const stop of running.values()) stop();
      running.clear();
    };
  }, []);

  const value = useMemo(() => ({ info, hidden }), [info, hidden]);
  return <MachineWatchContext.Provider value={value}>{children}</MachineWatchContext.Provider>;
}

export function MachineSwitcher() {
  const current = useMachine();
  const { connected, sessions } = useStore();
  const { info, hidden } = useContext(MachineWatchContext);

  if (!info || info.remotes.length === 0) return null;

  const pills: { id: string | null; name: string; status: RemoteVersionStatus | null; version: string }[] = [
    {
      id: null,
      name: info.local.name,
      status: null,
      version: info.local.version === null ? 'version inconnue' : `cette machine, Cerebro ${versionLabel(info.local.version)}`,
    },
    ...info.remotes.map((remote) => ({
      id: remote.id,
      name: remote.name,
      status: remote.status,
      version: compatibilityText(remote.status),
    })),
  ];

  return (
    <nav className="machine-switcher" aria-label="Machines">
      {pills.map((pill) => {
        const active = pill.id === current;
        const watched = hidden[pill.id ?? 'local'];
        const online = active ? connected : (watched?.online ?? false);
        const counts = active
          ? attentionCounts(sessions)
          : { total: watched?.attention ?? 0, waiting: watched?.waiting ?? 0 };
        const attention = counts.total;
        // Priorité au type « question » : une seule session en attente teinte la machine en orange.
        const tone = counts.waiting > 0 ? 'waiting' : 'idle';
        const hash = pill.id === null ? '#/' : `#/m/${pill.id}/`;
        const status = online ? 'en ligne' : 'hors ligne';
        const detail =
          attention > 0
            ? counts.waiting > 0
              ? `${plural(counts.waiting, 'question')}, ${attention} à traiter`
              : `${plural(attention, 'terminée')}`
            : null;
        const title = [pill.name, status, pill.version, detail].filter(Boolean).join(' — ');
        const compat = pill.status?.compatibility ?? null;
        const mark = compat === null ? null : COMPAT_MARK[compat];
        return (
          <a
            key={pill.id ?? 'local'}
            className={`machine-pill${active ? ' active' : ''}${compat === 'incompatible' ? ' incompatible' : ''}`}
            href={hash}
            aria-current={active ? 'page' : undefined}
            title={title}
            onClick={(event) => {
              event.preventDefault();
              goMachine(pill.id);
            }}
          >
            <span className={`machine-dot${online ? ' on' : ''}`} aria-hidden="true" />
            <span className="machine-name">{pill.name}</span>
            {mark !== null && compat !== null ? (
              <span className={`machine-compat ${compat}`} aria-label={pill.version}>
                {mark}
              </span>
            ) : null}
            {attention > 0 ? (
              <span className={`machine-badge ${tone}`} aria-label={detail ?? undefined}>
                {tone === 'waiting' ? '? ' : null}
                {attention}
              </span>
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}

/** Version de l'instance locale, affichée même sans machine distante. */
export function AppVersion() {
  const info = useMachineInfo();
  const version = info?.local.version;
  if (!version) return null;
  return (
    <p className="app-version" title="Version SemVer : les machines de même version majeure sont compatibles">
      Cerebro {versionLabel(version)}
    </p>
  );
}

/** Machine distante affichée d'une autre version majeure : l'interface risque d'échouer, on le dit. */
export function MachineCompatNotice() {
  const current = useMachine();
  const info = useMachineInfo();
  const remote = current === null ? undefined : info?.remotes.find((candidate) => candidate.id === current);
  if (remote?.status?.compatibility !== 'incompatible') return null;
  const local = info?.local.version;
  const distant = remote.status.version;
  return (
    <div className="peer-notices">
      <div className="peer-notice compat-notice" role="alert">
        <span>
          {remote.name} n'est pas compatible avec cette machine
          {distant && local
            ? ` (Cerebro ${versionLabel(distant)} ; ici Cerebro ${versionLabel(local)})`
            : ''}
          . Certaines actions risquent d'échouer et la coordination Slack est suspendue : mettez à jour l'une des deux machines.
        </span>
      </div>
    </div>
  );
}
