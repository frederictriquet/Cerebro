import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test, mock } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-slack-settings-'));
process.env.CEREBRO_DATA_DIR = root;
process.env.HOME = root;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { SlackNotifier } = await import('../server/slack.ts');
const db = new CerebroDatabase(':memory:');
const manager = new SessionManager(db, createServices(db));
const peers = { ready: Promise.resolve(), owns: () => true, setSlackPoster: () => {} };
const file = join(root, 'slack.json');
const notifiers = [];
const create = () => {
  const notifier = new SlackNotifier(manager, db, peers);
  notifiers.push(notifier);
  return notifier;
};
after(() => {
  for (const notifier of notifiers) notifier.stop();
  mock.restoreAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('Slack settings are read lazily, not when the notifier is built', () => {
  rmSync(file, { force: true });
  const notifier = create();
  writeFileSync(file, JSON.stringify({ idle: true, waiting: false, delaySeconds: 7 }));
  const status = notifier.status();
  assert.equal(status.enabled, false);
  assert.equal(status.idle, true);
  assert.equal(status.waiting, false);
  assert.equal(status.delaySeconds, 7);
});

test('updateSettings applies at once and persists the last of a burst asynchronously', async () => {
  rmSync(file, { force: true });
  const notifier = create();
  assert.equal(notifier.updateSettings({ delaySeconds: 1 }).delaySeconds, 1);
  assert.equal(notifier.status().delaySeconds, 1);
  notifier.updateSettings({ delaySeconds: 2 });
  notifier.updateSettings({ idle: true });
  const last = notifier.updateSettings({ delaySeconds: 3 });
  assert.equal(notifier.status().delaySeconds, 3);
  assert.equal(notifier.status().idle, true);
  await notifier.settingsSaved();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), last);
  assert.equal(notifier.updateSettings({ delaySeconds: -1 }), null);
  assert.equal(notifier.status().delaySeconds, 3);
});

test('a failed settings write is reported without breaking later writes', async () => {
  rmSync(file, { force: true });
  mkdirSync(file);
  const notifier = create();
  const errors = mock.method(console, 'error', () => {});
  notifier.updateSettings({ delaySeconds: 4 });
  await assert.rejects(notifier.settingsSaved());
  assert.ok(errors.mock.callCount() >= 1);
  rmSync(file, { recursive: true });
  notifier.updateSettings({ delaySeconds: 5 });
  await notifier.settingsSaved();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).delaySeconds, 5);
  errors.mock.restore();
});

test('a failed settings write restores the persisted settings in memory', async () => {
  rmSync(file, { force: true });
  writeFileSync(file, JSON.stringify({ waiting: true, delaySeconds: 6 }));
  const notifier = create();
  const errors = mock.method(console, 'error', () => {});
  const before = notifier.status();
  assert.equal(before.waiting, true);
  rmSync(file);
  mkdirSync(file);
  assert.equal(notifier.updateSettings({ waiting: false }).waiting, false);
  await assert.rejects(notifier.settingsSaved());
  assert.deepEqual(notifier.status(), before);
  // A burst whose first write fails keeps the newer value queued, and only the final outcome counts.
  notifier.updateSettings({ delaySeconds: 8 });
  notifier.updateSettings({ delaySeconds: 9 });
  await assert.rejects(notifier.settingsSaved());
  assert.deepEqual(notifier.status(), before);
  rmSync(file, { recursive: true });
  notifier.updateSettings({ waiting: false });
  await notifier.settingsSaved();
  assert.equal(notifier.status().waiting, false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).waiting, false);
  // Once saved, that value is what a later failure falls back to.
  rmSync(file);
  mkdirSync(file);
  notifier.updateSettings({ delaySeconds: 11 });
  await assert.rejects(notifier.settingsSaved());
  assert.equal(notifier.status().waiting, false);
  assert.equal(notifier.status().delaySeconds, 6);
  rmSync(file, { recursive: true });
  errors.mock.restore();
});
