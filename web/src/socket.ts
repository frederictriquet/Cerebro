export interface ReconnectingSocketHandlers {
  onOpen?: (socket: WebSocket) => void;
  /** Message texte déjà décodé en JSON ; les messages binaires ou illisibles sont ignorés. */
  onMessage?: (data: unknown, socket: WebSocket) => void;
  onClose?: (socket: WebSocket) => void;
}

export interface ReconnectingSocket {
  /** Socket courant, null entre une fermeture et la reconnexion suivante. */
  readonly socket: WebSocket | null;
  /** Ferme définitivement : plus aucun handler ni reconnexion. */
  close(): void;
}

const MAX_DELAY_MS = 8_000;
const BASE_DELAY_MS = 400;

// Backoff exponentiel plafonné, tiré entre la moitié et la totalité du palier pour étaler les reconnexions.
function retryDelay(retry: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retry);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/**
 * Ouvre un WebSocket qui se reconnecte après chaque fermeture. Une reconnexion en attente est
 * avancée dès que le réseau revient ou que l'onglet redevient visible.
 */
export function openReconnectingSocket(url: string, handlers: ReconnectingSocketHandlers): ReconnectingSocket {
  let stopped = false;
  let retry = 0;
  let current: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = (): void => {
    timer = undefined;
    if (stopped) return;
    const socket = new WebSocket(url);
    current = socket;
    socket.addEventListener('open', () => {
      if (stopped) return;
      retry = 0;
      handlers.onOpen?.(socket);
    });
    socket.addEventListener('message', (ev) => {
      if (stopped || typeof ev.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data) as unknown;
      } catch {
        return;
      }
      handlers.onMessage?.(raw, socket);
    });
    socket.addEventListener('close', () => {
      if (current === socket) current = null;
      if (stopped) return;
      handlers.onClose?.(socket);
      timer = setTimeout(connect, retryDelay(retry));
      retry += 1;
    });
    socket.addEventListener('error', () => {
      socket.close();
    });
  };

  const reconnectNow = (): void => {
    if (stopped || timer === undefined) return;
    clearTimeout(timer);
    connect();
  };
  const onVisibility = (): void => {
    if (!document.hidden) reconnectNow();
  };
  window.addEventListener('online', reconnectNow);
  document.addEventListener('visibilitychange', onVisibility);

  connect();
  return {
    get socket() {
      return current;
    },
    close() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', onVisibility);
      current?.close();
      current = null;
    },
  };
}
