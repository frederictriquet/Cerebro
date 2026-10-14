import { parseHash } from './route.ts';
import type { Session } from './types.ts';

const MUTE_KEY = 'cerebro.mute';

export function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* quota / mode privé */
  }
}

export function armNotificationPermission(): void {
  const once = (): void => {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  };
  window.addEventListener('pointerdown', once, { once: true });
}

export function sessionIsOpenAndVisible(id: string): boolean {
  if (document.visibilityState !== 'visible') return false;
  const route = parseHash(window.location.hash);
  return route.kind === 'session' && route.sessionId === id;
}

export function showAlertNotification(session: Session): void {
  if (sessionIsOpenAndVisible(session.id)) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const reason = session.attentionReason ?? '';
  const body = [reason, session.title].filter((p) => p.length > 0).join(' — ');
  try {
    const n = new Notification(`Cerebro — ${session.agent} attend`, {
      body,
      tag: session.id,
    });
    n.onclick = () => {
      window.focus();
      window.location.hash = `#/s/${session.id}`;
      n.close();
    };
  } catch {
    /* Notifications indisponibles */
  }
}

let audioCtx: AudioContext | null = null;

export function beep(): void {
  try {
    const Ctx = window.AudioContext;
    audioCtx ??= new Ctx();
    const ac = audioCtx;
    void ac.resume();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    const t = ac.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.07, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.15);
  } catch {
    /* WebAudio bloqué */
  }
}

export function updateDocumentTitle(attentionCount: number): void {
  document.title = attentionCount > 0 ? `(${attentionCount}) Cerebro` : 'Cerebro';
}
