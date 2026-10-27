export interface ReconnectingSocketHandlers {
  onOpen?: (socket: WebSocket) => void;
  // Message texte déjà décodé en JSON ; les messages binaires ou illisibles sont ignorés.
  onMessage?: (raw: unknown, socket: WebSocket) => void;
  // Coupure non demandée : une reconnexion est programmée juste après.
  onClose?: () => void;
}

export interface ReconnectingSocket {
  // Socket courant, ouvert ou en cours d'ouverture ; null pendant l'attente d'une reconnexion.
  current(): WebSocket | null;
  close(): void;
}

const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 8_000;

// Backoff exponentiel plafonné, tiré dans [delay/2, delay] : les clients coupés en même temps
// ne se reconnectent pas tous au même instant.
function retryDelay(retry: number): number {
  const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retry);
  return delay / 2 + Math.random() * (delay / 2);
}

// Ouvre un WebSocket rouvert automatiquement après chaque coupure. Le retour du réseau (online)
// ou de l'onglet au premier plan (visibilitychange) court-circuite l'attente en cours.
export function openReconnectingSocket(url: string, handlers: ReconnectingSocketHandlers): ReconnectingSocket {
  let stopped = false;
  let retry = 0;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = (): void => {
    timer = undefined;
    if (stopped) return;
    const next = new WebSocket(url);
    socket = next;
    next.addEventListener('open', () => {
      if (stopped || socket !== next) return;
      retry = 0;
      handlers.onOpen?.(next);
    });
    next.addEventListener('message', (ev) => {
      if (stopped || socket !== next || typeof ev.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data) as unknown;
      } catch {
        return;
      }
      handlers.onMessage?.(raw, next);
    });
    next.addEventListener('close', () => {
      if (stopped || socket !== next) return;
      socket = null;
      handlers.onClose?.();
      timer = setTimeout(connect, retryDelay(retry));
      retry += 1;
    });
    next.addEventListener('error', () => {
      next.close();
    });
  };

  // Seule une attente de reconnexion est écourtée : un socket ouvert ou en ouverture est laissé tel quel.
  const reconnectNow = (): void => {
    if (stopped || timer === undefined) return;
    clearTimeout(timer);
    retry = 0;
    connect();
  };
  const onVisibility = (): void => {
    if (!document.hidden) reconnectNow();
  };
  window.addEventListener('online', reconnectNow);
  document.addEventListener('visibilitychange', onVisibility);

  connect();
  return {
    current: () => socket,
    close(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', onVisibility);
      socket?.close();
      socket = null;
    },
  };
}
