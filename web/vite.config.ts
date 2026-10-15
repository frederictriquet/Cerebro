import type { Socket } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));
const api = `http://127.0.0.1:${process.env.CEREBRO_PORT ?? '4317'}`;

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

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: api },
      '/ws': { target: api, ws: true, configure: quietWsDisconnects },
    },
  },
});
