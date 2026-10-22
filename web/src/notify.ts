import { parseHash, parseMachine } from './route.ts';
import type { Session } from './types.ts';

const MUTE_KEY = 'cerebro.mute';
const DESKTOP_NOTIF_KEY = 'cerebro.desktopNotif';

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

// Notifications système (toaster du bureau). Activées par défaut ; sous certains bureaux Linux
// elles jouent un son non contrôlable par la page, d'où cet interrupteur dédié.
export function readDesktopNotif(): boolean {
  try {
    return localStorage.getItem(DESKTOP_NOTIF_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeDesktopNotif(enabled: boolean): void {
  try {
    localStorage.setItem(DESKTOP_NOTIF_KEY, enabled ? '1' : '0');
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

export function sessionIsOpenAndVisible(id: string, machineId?: string | null): boolean {
  if (document.visibilityState !== 'visible') return false;
  const route = parseHash(window.location.hash);
  if (route.kind !== 'session' || route.sessionId !== id) return false;
  if (machineId === undefined) return true;
  return parseMachine(window.location.hash) === machineId;
}

function sessionHash(sessionId: string, machineId: string | null, panel?: 'findings'): string {
  const path = machineId === null ? `#/s/${sessionId}` : `#/m/${machineId}/s/${sessionId}`;
  return panel ? `${path}/${panel}` : path;
}

export function showAlertNotification(session: Session, machineId?: string | null): void {
  // Sans machine explicite : celle affichée (le store ne passe pas l'id).
  const target = machineId === undefined ? parseMachine(window.location.hash) : machineId;
  if (!readDesktopNotif()) return;
  if (sessionIsOpenAndVisible(session.id, target)) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const waiting = session.status === 'waiting';
  // Titre selon le type : « attend une réponse » n'apparaît que pour une vraie question/permission.
  const head = waiting ? `${session.agent} attend une réponse` : `${session.agent} a terminé`;
  // Certains agents renvoient « waiting for your input » en fin de tour : trompeur pour un simple idle.
  const rawReason = session.attentionReason ?? '';
  const reason = !waiting && /waiting for your input/i.test(rawReason) ? '' : rawReason;
  const body = [reason, session.title].filter((p) => p.length > 0).join(' — ');
  try {
    const n = new Notification(`Cerebro — ${head}`, {
      body,
      tag: target === null ? session.id : `${target}:${session.id}`,
      // Le son est fourni par le WebAudio (playAlert), distinct selon le type d'attente :
      // on coupe le son par défaut de l'OS pour ne pas doubler. Le toaster reste le signal visuel.
      silent: true,
    });
    n.onclick = () => {
      window.focus();
      window.location.hash = sessionHash(session.id, target);
      n.close();
    };
  } catch {
    /* Notifications indisponibles */
  }
}

export function showFindingsNotification(session: Session, machineId?: string | null): void {
  const target = machineId === undefined ? parseMachine(window.location.hash) : machineId;
  if (!session.pendingFindings || !readDesktopNotif() || sessionIsOpenAndVisible(session.id, target)) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const count = session.pendingFindings;
  try {
    const notification = new Notification(`Cerebro — ${count} finding${count > 1 ? 's' : ''} de review à traiter`, {
      body: [session.epic ? `Epic « ${session.epic.title} »` : '', session.title].filter(Boolean).join(' — '),
      tag: `findings:${target ?? 'local'}:${session.id}`,
      silent: true,
    });
    notification.onclick = () => {
      window.focus();
      window.location.hash = sessionHash(session.id, target, 'findings');
      notification.close();
    };
  } catch { /* Notifications indisponibles. */ }
}

let audioCtx: AudioContext | null = null;

interface ToneStep {
  freq: number;
  /** Décalage de départ depuis le début du motif, en secondes. */
  start: number;
  dur: number;
  peak: number;
}

function playTone(steps: readonly ToneStep[]): void {
  try {
    const Ctx = window.AudioContext;
    audioCtx ??= new Ctx();
    const ac = audioCtx;
    void ac.resume();
    const t0 = ac.currentTime;
    for (const s of steps) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = s.freq;
      const t = t0 + s.start;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(s.peak, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + s.dur);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(t);
      osc.stop(t + s.dur + 0.02);
    }
  } catch {
    /* WebAudio bloqué */
  }
}

// « Tour terminé » : une seule note douce et brève, volontairement très discrète.
export function beepDone(): void {
  playTone([{ freq: 523, start: 0, dur: 0.11, peak: 0.03 }]);
}

// « Question / permission » : deux notes ascendantes — reconnaissable au motif, pas au volume.
// Gain gardé sous l'ancien bip (0.07) pour rester agréable.
export function beepAsk(): void {
  playTone([
    { freq: 784, start: 0, dur: 0.12, peak: 0.055 },
    { freq: 1175, start: 0.15, dur: 0.16, peak: 0.06 },
  ]);
}

// 'waiting' = l'agent attend une réponse/permission ; tout le reste = tour terminé.
export function playAlert(status: Session['status']): void {
  if (status === 'waiting') beepAsk();
  else beepDone();
}

function updateFavicon(kind: 'waiting' | 'idle' | 'none'): void {
  try {
    const color = kind === 'waiting' ? '#f0a04b' : kind === 'idle' ? '#5ea2d8' : '#6b7280';
    const dot =
      kind === 'none'
        ? ''
        : kind === 'waiting'
          ? `<circle cx='23' cy='9' r='9' fill='${color}'/>` +
            `<text x='23' y='14.5' font-size='15' font-family='sans-serif' font-weight='800' text-anchor='middle' fill='#1b1e24'>?</text>`
          : `<circle cx='25' cy='7' r='6' fill='${color}'/>`;
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>` +
      `<rect width='32' height='32' rx='7' fill='#1b1e24'/>` +
      `<text x='15' y='23' font-size='19' font-family='sans-serif' font-weight='700' text-anchor='middle' fill='#e6e8ec'>C</text>` +
      `${dot}</svg>`;
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/svg+xml';
    link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch {
    /* DOM indisponible */
  }
}

// Titre et favicon de l'onglet : signal distinct selon le type d'attention (utile hors de l'app).
export function updateAttentionIndicators(waiting: number, done: number, findings = 0): void {
  const total = waiting + done;
  const mark = waiting > 0 ? '❓ ' : findings > 0 ? '📋 ' : done > 0 ? '✅ ' : '';
  const suffix = findings > 0 ? ` · ${findings} finding${findings > 1 ? 's' : ''} à traiter` : '';
  document.title = total > 0 ? `${mark}(${total}) Cerebro${suffix}` : 'Cerebro';
  updateFavicon(waiting > 0 ? 'waiting' : done > 0 ? 'idle' : 'none');
}
