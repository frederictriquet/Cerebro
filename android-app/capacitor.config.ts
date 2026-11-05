import type { CapacitorConfig } from '@capacitor/cli';

// The app loads the mobile view from the PC: same origin as Cerebro, so its token cookie and origin check apply
// unchanged. `cap sync` copies the URL into the native project, so a new URL needs a new APK.
const url = process.env.CEREBRO_MOBILE_URL;
if (!url) {
  throw new Error('CEREBRO_MOBILE_URL is missing: URL of the mobile view, e.g. https://<pc>.<tailnet>.ts.net/mobile');
}

const config: CapacitorConfig = {
  appId: 'cerebro.mobile',
  appName: 'Cerebro',
  webDir: 'www',
  // When the page cannot load (Tailscale off, PC asleep, Cerebro stopped), the WebView shows www/index.html.
  server: { url, errorPath: 'index.html' },
};

export default config;
