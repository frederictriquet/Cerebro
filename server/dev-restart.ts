export interface DevRestartGuard {
  isBusy(): boolean;
  waitForIdle(): Promise<void>;
}

export interface DevIpcEndpoint {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off?(event: 'message', listener: (message: unknown) => void): unknown;
  removeListener?(event: 'message', listener: (message: unknown) => void): unknown;
  send?(message: unknown): unknown;
}

/**
 * Coordinates hot restarts with `scripts/dev.mjs` over Node IPC so a Git pull/rebase/push that modifies
 * `server/` or `shared/` in Cerebro's own checkout finishes (and lets the UI poll its final status) before
 * `dev.mjs` sends SIGTERM.
 */
export function attachDevRestartChannel(endpoint: DevIpcEndpoint, guard: DevRestartGuard, graceMs = 600): () => void {
  if (typeof endpoint.send !== 'function') return () => {};
  let waiting = false;
  const send = (payload: Record<string, unknown>): void => {
    try {
      endpoint.send?.(payload);
    } catch {
      // Parent IPC channel closed meanwhile.
    }
  };
  const onMessage = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object' || (raw as { type?: unknown }).type !== 'prepare-restart') return;
    if (!guard.isBusy()) {
      send({ type: 'restart-ack', busy: false });
      return;
    }
    send({ type: 'restart-ack', busy: true });
    if (waiting) return;
    waiting = true;
    void (async () => {
      try {
        while (guard.isBusy()) {
          await guard.waitForIdle();
          if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs));
        }
      } finally {
        waiting = false;
        send({ type: 'restart-ready' });
      }
    })();
  };
  endpoint.on('message', onMessage);
  return () => {
    if (typeof endpoint.off === 'function') endpoint.off('message', onMessage);
    else endpoint.removeListener?.('message', onMessage);
  };
}
