/// <reference types="vite/client" />

declare global {
  /** Commit et heure du build (web/vite.config.ts), null sous le serveur de dev Vite. */
  const __CEREBRO_BUILD__: { sha: string; at: number } | null;
}

export {};
