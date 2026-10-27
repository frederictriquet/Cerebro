import type { Socket } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';
import { INTERNAL_URL } from '../server/config.ts';
import { assertLoopbackPortFree } from '../server/ports.ts';

const root = dirname(fileURLToPath(import.meta.url));
// The server's own configuration (env file included), so the proxy targets the port it listens on.
const api = INTERNAL_URL;

// A browser tab closing its websocket (reload, session switch, StrictMode remount)
// while the PTY is still streaming makes the proxy's write fail with ECONNRESET/EPIPE.
// Harmless, but Vite logs a full stack trace for each one: drop them before Vite's handlers.
// Two paths reach the logger: the proxy's own 'error' event ("ws proxy error") and an
// 'error' listener Vite attaches to the client socket on 'proxyReqWs' ("ws proxy socket error").
const isDisconnect = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ECONNRESET' || code === 'EPIPE';
};

const quietSocket = (socket: Socket) => {
  const emit = socket.emit.bind(socket);
  socket.emit = ((event: string, ...args: unknown[]) => {
    if (event === 'error' && isDisconnect(args[0])) {
      socket.destroy();
      return true;
    }
    return emit(event, ...args);
  }) as typeof socket.emit;
};

const quietWsDisconnects: ProxyOptions['configure'] = (proxy) => {
  const emit = proxy.emit.bind(proxy);
  proxy.emit = ((event: string, ...args: unknown[]) => {
    if (event === 'proxyReqWs') quietSocket(args[2] as Socket);
    const [err, , target] = args as [unknown, unknown, { destroy?: () => void } & object];
    if (event === 'error' && !('req' in target) && isDisconnect(err)) {
      target.destroy?.();
      return true;
    }
    return emit(event, ...args);
  }) as typeof proxy.emit;
};

const DEV_HOST = '127.0.0.1';
const DEV_PORT = 5173;

export default defineConfig(async ({ command }) => {
  // strictPort only covers 127.0.0.1: also refuse a port already taken on [::1].
  if (command === 'serve') await assertLoopbackPortFree(DEV_HOST, DEV_PORT, 'Vite (Cerebro)');
  return {
    root,
    plugins: [react()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      host: DEV_HOST,
      port: DEV_PORT,
      strictPort: true,
      proxy: {
        '/api': { target: api },
        '/ws': { target: api, ws: true, configure: quietWsDisconnects },
        // VS Code relayé par le serveur (regex : '/vscode' seul capterait aussi d'éventuels /vscode*.ts).
        '^/vscode(/|$|\\?)': { target: api, ws: true, configure: quietWsDisconnects },
        // Passerelle vers les machines distantes (regex : un préfixe '/m' capterait aussi /main.tsx…).
        '^/m/': { target: api, ws: true, configure: quietWsDisconnects },
      },
    },
  };
});
