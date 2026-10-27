import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  getMachines,
  wsUrl,
  type Compatibility,
  type MachinesInfo,
  type RemoteVersionStatus,
  type VersionInfo,
} from './api.ts';
import { playAlert, readMuted, showAlertNotification, showFindingsNotification } from './notify.ts';
import { needsAttention } from './format.ts';
import { goMachine, useMachine } from './route.ts';
import { useStore } from './store.tsx';
import { parseEventsMessage, type Session } from './types.ts';

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

const MACHINE_ID = /^[a-z0-9-]{1,32}$/;
const MACHINES_REFRESH_MS = 30_000;
const COMPATIBILITIES: readonly Compatibility[] = ['same', 'compatible', 'incompatible', 'unknown'];
const MachineWatchContext = createContext<MachineWatch>({ info: null, hidden: {} });

interface AttentionCounts {
  /** Sessions réclamant l'attention, tous types confondus. */
  total: number;
  /** Parmi elles, celles en attente d'une réponse/permission (type « question »). */
  waiting: number;
}

function countAttention(list: Session[]): AttentionCounts {
  let total = 0;
  let waiting = 0;
  for (const session of list) {
    if (!needsAttention(session)) continue;
    total += 1;
    if (session.status === 'waiting') waiting += 1;
  }
  return { total, waiting };
}

function upsertSession(list: Session[], session: Session): Session[] {
  const index = list.findIndex((item) => item.id === session.id);
  if (index === -1) return [session, ...list];
  const next = list.slice();
  next[index] = session;
  return next;
}

function usableVersion(value: unknown): VersionInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, commit } = value as Partial<Record<keyof VersionInfo, unknown>>;
  if (typeof version !== 'string') return null;
  return { version, commit: typeof commit === 'string' ? commit : null };
}

function usableStatus(value: unknown): RemoteVersionStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Partial<Record<keyof RemoteVersionStatus, unknown>>;
  const compatibility = COMPATIBILITIES.find((candidate) => candidate === raw.compatibility);
  if (compatibility === undefined || typeof raw.checkedAt !== 'number') return null;
  return {
    version: usableVersion(raw.version),
    compatibility,
    reachable: raw.reachable === true,
    error: typeof raw.error === 'string' ? raw.error : null,
    checkedAt: raw.checkedAt,
  };
}

function usableMachines(data: MachinesInfo): MachinesInfo | null {
  if (typeof data !== 'object' || data === null) return null;
  const name = data.local?.name;
  if (typeof name !== 'string' || !Array.isArray(data.remotes)) return null;
  const remotes: MachinesInfo['remotes'] = [];
  for (const remote of data.remotes) {
    if (typeof remote?.id !== 'string' || typeof remote.name !== 'string') continue;
    if (remote.id === 'local' || !MACHINE_ID.test(remote.id)) continue;
    remotes.push({ id: remote.id, name: remote.name, status: usableStatus(remote.status) });
  }
  return { local: { name, version: usableVersion(data.local.version) }, remotes };
}

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

function startWatcher(target: WatchTarget, setState: Dispatch<SetStateAction<Record<string, WatchState>>>): () => void {
  let stopped = false;
  let retry = 0;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sessions: Session[] = [];

  const publish = (online: boolean): void => {
    if (stopped) return;
    const { total, waiting } = countAttention(sessions);
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

  const connect = (): void => {
    if (stopped) return;
    const next = new WebSocket(wsUrl('/ws/events', target.base));
    socket = next;
    next.addEventListener('open', () => {
      if (stopped) return;
      retry = 0;
      publish(true);
    });
    next.addEventListener('message', (ev) => {
      if (stopped || typeof ev.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data) as unknown;
      } catch {
        return;
      }
      const msg = parseEventsMessage(raw);
      if (!msg) return;
      switch (msg.type) {
        case 'snapshot':
          sessions = msg.sessions;
          publish(next.readyState === WebSocket.OPEN);
          break;
        case 'session':
          sessions = upsertSession(sessions, msg.session);
          publish(true);
          break;
        case 'session-deleted':
          sessions = sessions.filter((item) => item.id !== msg.id);
          publish(true);
          break;
        case 'alert':
          sessions = upsertSession(sessions, msg.session);
          publish(true);
          showAlertNotification(msg.session, target.machineId);
          if (!readMuted()) playAlert(msg.session.status);
          break;
        case 'findings-available':
          sessions = upsertSession(sessions, msg.session);
          publish(true);
          showFindingsNotification(msg.session, target.machineId);
          if (!readMuted()) playAlert('idle');
          break;
        case 'projects':
          break;
      }
    });
    next.addEventListener('close', () => {
      if (stopped) return;
      publish(false);
      const delay = Math.min(8_000, 400 * 2 ** retry);
      retry += 1;
      timer = setTimeout(connect, delay);
    });
    next.addEventListener('error', () => {
      next.close();
    });
  };

  connect();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    socket?.close();
  };
}

export function MachineWatchProvider({ children }: { children: ReactNode }) {
  const current = useMachine();
  const [info, setInfo] = useState<MachinesInfo | null>(null);
  const [hidden, setHidden] = useState<Record<string, WatchState>>({});

  // Rechargée périodiquement : la version d'une machine distante change quand elle est mise à jour.
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void getMachines()
        .then((data) => {
          if (cancelled) return;
          const parsed = usableMachines(data);
          if (parsed) setInfo((prev) => (JSON.stringify(prev) === JSON.stringify(parsed) ? prev : parsed));
        })
        .catch(() => {
          /* pas de sélecteur si la liste est indisponible */
        });
    };
    load();
    const timer = window.setInterval(load, MACHINES_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

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
    const stops = wanted.map((target) => startWatcher(target, setHidden));
    return () => {
      for (const stop of stops) stop();
    };
  }, [remoteIds, current]);

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
      version:
        info.local.version === null ? 'version inconnue' : `cette machine, Cerebro ${versionLabel(info.local.version)}`,
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
          ? countAttention(sessions)
          : { total: watched?.attention ?? 0, waiting: watched?.waiting ?? 0 };
        const attention = counts.total;
        // Priorité au type « question » : une seule session en attente teinte la machine en orange.
        const tone = counts.waiting > 0 ? 'waiting' : 'idle';
        const hash = pill.id === null ? '#/' : `#/m/${pill.id}/`;
        const status = online ? 'en ligne' : 'hors ligne';
        const detail =
          attention > 0
            ? counts.waiting > 0
              ? `${counts.waiting} question(s), ${attention} à traiter`
              : `${attention} terminée(s)`
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
          {distant && local ? ` (Cerebro ${versionLabel(distant)} ; ici Cerebro ${versionLabel(local)})` : ''}.
          Certaines actions risquent d'échouer et la coordination Slack est suspendue : mettez à jour l'une des deux
          machines.
        </span>
      </div>
    </div>
  );
}
