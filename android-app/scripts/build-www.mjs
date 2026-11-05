// Writes www/index.html, the page the app shows when the mobile view cannot load (Capacitor `server.errorPath`),
// from offline.html with the mobile view URL filled in. Run by `npm run sync` before `cap sync android`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = "'__CEREBRO_MOBILE_URL__'";
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const raw = process.env.CEREBRO_MOBILE_URL;
if (!raw) {
  throw new Error('CEREBRO_MOBILE_URL is missing: URL of the mobile view, e.g. https://<pc>.<tailnet>.ts.net/mobile');
}
// Throws on an invalid URL. The parsed form percent-encodes `<`, so the JSON string cannot close the script tag.
const url = new URL(raw).href;

const template = readFileSync(join(root, 'offline.html'), 'utf8');
if (!template.includes(MARKER)) throw new Error(`offline.html no longer contains ${MARKER}`);
mkdirSync(join(root, 'www'), { recursive: true });
writeFileSync(join(root, 'www', 'index.html'), template.replace(MARKER, JSON.stringify(url)));
console.log(`www/index.html written for ${url}`);
