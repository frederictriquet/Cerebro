import type WebSocket from 'ws';

export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface Heartbeat {
  watch(socket: WebSocket): void;
  stop(): void;
}

// Une connexion morte (veille, Wi-Fi coupé) ne se ferme qu'au timeout TCP : un ping périodique
// la détecte, et terminate() la libère si elle n'a pas répondu au ping précédent.
export function startHeartbeat(intervalMs = HEARTBEAT_INTERVAL_MS): Heartbeat {
  const alive = new Map<WebSocket, boolean>();
  const timer = setInterval(() => {
    for (const [socket, answered] of alive) {
      if (!answered) {
        alive.delete(socket);
        socket.terminate();
        continue;
      }
      if (socket.readyState !== socket.OPEN) continue;
      alive.set(socket, false);
      socket.ping();
    }
  }, intervalMs);
  timer.unref();
  return {
    watch(socket) {
      alive.set(socket, true);
      socket.on('pong', () => {
        if (alive.has(socket)) alive.set(socket, true);
      });
      socket.on('close', () => alive.delete(socket));
    },
    stop() {
      clearInterval(timer);
      alive.clear();
    },
  };
}
