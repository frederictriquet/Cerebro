import { connect } from 'node:net';

const LOOPBACKS = ['127.0.0.1', '::1'] as const;
const PROBE_TIMEOUT_MS = 500;

function isListening(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (listening: boolean): void => {
      socket.destroy();
      done(listening);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Refuses to start when another process listens on the same port on the other loopback address.
 * Binding 127.0.0.1 succeeds even if [::1] is taken, and a browser resolving `localhost` may then
 * reach the other server (page from one, websockets from the other) without any visible error.
 * Call before listening, so the probe cannot hit our own socket.
 */
export async function assertLoopbackPortFree(host: string, port: number, label: string): Promise<void> {
  // Only loopback binds are affected; `localhost` may resolve to either address, so check both.
  if (host !== 'localhost' && !(LOOPBACKS as readonly string[]).includes(host)) return;
  for (const other of LOOPBACKS) {
    if (other === host) continue;
    if (await isListening(other, port)) {
      const address = other.includes(':') ? `[${other}]:${port}` : `${other}:${port}`;
      throw new Error(
        `${label} : le port ${port} est déjà utilisé par un autre processus sur ${address}. `
          + `Un navigateur ouvrant « localhost:${port} » pourrait joindre ce processus au lieu de Cerebro. `
          + `Arrêtez-le (lsof -nP -iTCP:${port} -sTCP:LISTEN) ou changez de port.`,
      );
    }
  }
}
