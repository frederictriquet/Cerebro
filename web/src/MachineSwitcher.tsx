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
import { getMachines, wsUrl, type MachinesInfo } from './api.ts';
import { beep, readMuted, showAlertNotification } from './notify.ts';
import { goMachine, useMachine } from './route.ts';
import { useStore } from './store.tsx';
import { parseEventsMessage, type Session } from './types.ts';

interface WatchState {
  online: boolean;
  attention: number;
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
const MachineWatchContext = createContext<MachineWatch>({ info: null, hidden: {} });

function attentionCount(list: Session[]): number {
  let count = 0;
  for (const session of list) {
    if (session.attention) count += 1;
  }
  return count;
}

function upsertSession(list: Session[], session: Session): Session[] {
  const index = list.findIndex((item) => item.id === session.id);
  if (index === -1) return [session, ...list];
  const next = list.slice();
  next[index] = session;
  return next;
}

function usableMachines(data: MachinesInfo): MachinesInfo | null {
  if (typeof data !== 'object' || data === null) return null;
  const name = data.local?.name;
  if (typeof name !== 'string' || !Array.isArray(data.remotes)) return null;
  const remotes: { id: string; name: string }[] = [];
  for (const remote of data.remotes) {
    if (typeof remote?.id !== 'string' || typeof remote.name !== 'string') continue;
    if (remote.id === 'local' || !MACHINE_ID.test(remote.id)) continue;
    remotes.push({ id: remote.id, name: remote.name });
  }
  return { local: { name }, remotes };
}

function hiddenTargets(info: MachinesInfo | null, current: string | null): WatchTarget[] {
  if (!info || info.remotes.length === 0) return [];
  const targets: WatchTarget[] = [];
  if (current !== null) targets.push({ key: 'local', base: '', machineId: null });
  for (const remote of info.remotes) {
    if (remote.id !== current) {
      targets.push({ key: remote.id, base: `/m/${remote.id}`, machineId: remote.id });
    }
  }
  return targets;
}

function startWatcher(
  target: WatchTarget,
  setState: Dispatch<SetStateAction<Record<string, WatchState>>>,
): () => void {
  let stopped = false;
  let retry = 0;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sessions: Session[] = [];

  const publish = (online: boolean): void => {
    if (stopped) return;
    const attention = attentionCount(sessions);
    setState((prev) => {
      const currentState = prev[target.key];
      if (currentState && currentState.online === online && currentState.attention === attention) return prev;
      return { ...prev, [target.key]: { online, attention } };
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
          if (!readMuted()) beep();
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

  useEffect(() => {
    let cancelled = false;
    void getMachines()
      .then((data) => {
        if (cancelled) return;
        const parsed = usableMachines(data);
        if (parsed) setInfo(parsed);
      })
      .catch(() => {
        /* pas de sélecteur si la liste est indisponible */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const wanted = hiddenTargets(info, current);
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
  }, [info, current]);

  const value = useMemo(() => ({ info, hidden }), [info, hidden]);
  return <MachineWatchContext.Provider value={value}>{children}</MachineWatchContext.Provider>;
}

export function MachineSwitcher() {
  const current = useMachine();
  const { connected, sessions } = useStore();
  const { info, hidden } = useContext(MachineWatchContext);

  if (!info || info.remotes.length === 0) return null;

  const pills: { id: string | null; name: string }[] = [
    { id: null, name: info.local.name },
    ...info.remotes.map((remote) => ({ id: remote.id, name: remote.name })),
  ];

  return (
    <nav className="machine-switcher" aria-label="Machines">
      {pills.map((pill) => {
        const active = pill.id === current;
        const watched = hidden[pill.id ?? 'local'];
        const online = active ? connected : (watched?.online ?? false);
        const attention = active ? attentionCount(sessions) : (watched?.attention ?? 0);
        const hash = pill.id === null ? '#/' : `#/m/${pill.id}/`;
        const status = online ? 'en ligne' : 'hors ligne';
        const title =
          attention > 0 ? `${pill.name} — ${status} — ${attention} à traiter` : `${pill.name} — ${status}`;
        return (
          <a
            key={pill.id ?? 'local'}
            className={`machine-pill${active ? ' active' : ''}`}
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
            {attention > 0 ? <span className="machine-badge">{attention}</span> : null}
          </a>
        );
      })}
    </nav>
  );
}
