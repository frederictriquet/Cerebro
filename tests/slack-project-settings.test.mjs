import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test, mock } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-slack-project-'));
process.env.CEREBRO_DATA_DIR = root;
process.env.HOME = root;
process.env.CEREBRO_SLACK_TOKEN = 'test';
process.env.CEREBRO_SLACK_USER = 'test';
process.env.CEREBRO_SLACK_USER_TOKEN = 'user-token';
const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { createServices } = await import('../server/services.ts');
const { SlackNotifier } = await import('../server/slack.ts');
const { projectSettings, projectSlackSettingsFrom } = await import('../server/slack-state.ts');
const { parseProject } = await import('../shared/types.ts');
const db = new CerebroDatabase(':memory:');
const manager = new SessionManager(db, createServices(db));
const peers = { ready: Promise.resolve(), owns: () => true, setSlackPoster: () => {} };
const notifier = new SlackNotifier(manager, db, peers);
clearInterval(notifier.pollTimer);
const posted = [];
mock.method(notifier, 'slackApi', async (method, body) => {
  if (method === 'chat.postMessage') posted.push(body);
  if (method === 'conversations.open') return { ok: true, channel: { id: 'DM' } };
  return { ok: true, ts: String(Date.now()), channel: 'DM' };
});
mock.method(manager, 'screenText', () => ['screen']);
// Machine : aucune alerte, remise des fils par injection puis DM.
notifier.updateSettings({ idle: false, waiting: false, agentMessages: true, delaySeconds: 0.02 });

const custom = {
  mode: 'custom',
  waiting: false,
  idle: true,
  agentMessages: false,
  watchDeliveryLive: ['inject', 'notify'],
  watchDeliveryEnded: ['notify'],
};
const off = { ...custom, mode: 'off' };
const machineProject = db.createProject('Machine', root);
const mutedProject = db.updateProject(db.createProject('Cerebro', root).id, { slackSettings: off });
const customProject = db.updateProject(db.createProject('ACME', root).id, { slackSettings: custom });

function session(id, project) {
  const s = db.createSession(
    {
      id,
      projectId: project.id,
      agent: 'codex',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: '',
      title: id,
      status: 'running',
      agentSessionId: id,
    },
    'token',
  );
  notifier.onSessionEvent({ type: 'session', session: s });
  return s;
}
const wait = () => new Promise((r) => setTimeout(r, 70));
after(() => {
  notifier.stop();
  mock.restoreAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('les réglages Slack d’un projet remplacent ceux de la machine, ou coupent tout envoi', () => {
  const machine = notifier.status();
  assert.equal(projectSettings(machine, null), machine);
  const muted = projectSettings(machine, off);
  assert.deepEqual(
    [muted.waiting, muted.idle, muted.agentMessages, muted.watchDeliveryLive, muted.watchDeliveryEnded],
    [false, false, false, ['inject'], []],
  );
  const own = projectSettings(machine, custom);
  assert.equal(own.idle, true);
  assert.deepEqual(own.watchDeliveryEnded, ['notify']);
  // Délai et lecture des fils restent ceux de la machine.
  assert.equal(own.delaySeconds, machine.delaySeconds);
  assert.equal(own.watchIntervalSec, machine.watchIntervalSec);
  assert.equal(own.mode, undefined);

  assert.deepEqual(projectSlackSettingsFrom({ ...custom, watchDeliveryLive: ['notify', 'inject'] }), custom);
  for (const invalid of [
    null,
    { ...custom, mode: 'on' },
    { ...custom, idle: 'oui' },
    { ...custom, watchDeliveryLive: [] },
    { ...custom, watchDeliveryEnded: ['inject'] },
    { mode: 'off' },
  ])
    assert.equal(projectSlackSettingsFrom(invalid), null);

  // Réglages enregistrés avec le projet et relus par l'interface ; absents d'un serveur plus ancien.
  assert.deepEqual(db.getProject(customProject.id).slackSettings, custom);
  assert.equal(db.getProject(machineProject.id).slackSettings, null);
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(customProject))).slackSettings, custom);
  const { slackSettings: _absent, ...older } = machineProject;
  assert.equal(parseProject(older).slackSettings, null);
});

test('alertes de fin de tour : machine, projet coupé et projet personnalisé', async () => {
  session('machine-turn', machineProject);
  session('muted-turn', mutedProject);
  session('custom-turn', customProject);
  const n = posted.length;
  for (const id of ['machine-turn', 'muted-turn', 'custom-turn']) manager.setReliableState(id, 'idle', 'Tour terminé');
  await wait();
  assert.equal(posted.length, n + 1, 'seul le projet personnalisé alerte en fin de tour');
  assert.match(posted.at(-1).text, /ACME/);

  notifier.updateSettings({ idle: true });
  session('muted-again', mutedProject);
  manager.setReliableState('muted-again', 'idle', 'Tour terminé');
  await wait();
  assert.equal(posted.length, n + 1, 'un projet coupé ignore les réglages de la machine');
  notifier.updateSettings({ idle: false });
});

test('messages des agents et résultats d’opération suivent le projet', async () => {
  session('machine-agent', machineProject);
  session('muted-agent', mutedProject);
  session('custom-agent', customProject);
  assert.equal(notifier.agentMessagesRefusal('machine-agent'), null);
  assert.match(notifier.agentMessagesRefusal('muted-agent'), /pour ce projet/);
  assert.match(notifier.agentMessagesRefusal('custom-agent'), /pour ce projet/);
  notifier.updateSettings({ agentMessages: false });
  assert.match(notifier.agentMessagesRefusal('machine-agent'), /réglages Slack de Cerebro/);
  notifier.updateSettings({ agentMessages: true });

  const result = (project, ok) => ({
    id: `${project.name}-${ok}`,
    projectId: project.id,
    sessionId: null,
    kind: 'command',
    summary: 'fini',
    ok,
    startedAt: 0,
    finishedAt: 1,
  });
  assert.equal(notifier.operations.wanted(result(machineProject, true)), false);
  assert.equal(notifier.operations.wanted(result(mutedProject, true)), false);
  assert.equal(notifier.operations.wanted(result(customProject, true)), true);
  assert.equal(notifier.operations.wanted(result(customProject, false)), false);
});

test('fils surveillés : un projet coupé n’est jamais posté, même avec une remise propre', async () => {
  const sent = [];
  const watchMessage = mock.method(notifier.alerts, 'watchMessage', async (sessionId, mode) => {
    sent.push(`${sessionId}:${mode}`);
  });
  const flush = mock.method(notifier.watcher, 'flush', async () => {});
  const item = (deliver) => ({
    watch: { id: 'w', channel: 'C1', threadTs: null, ...(deliver ? { deliver } : {}) },
    message: { ts: '1.000001', text: 'réponse', user: 'UPMO' },
    author: 'PMO',
    permalink: null,
  });

  session('muted-watch', mutedProject);
  session('custom-watch', customProject);
  await notifier.watcher.deliver('muted-watch', [item(['dm'])]);
  await notifier.watcher.deliver('custom-watch', [item()]);
  await wait();
  assert.deepEqual(sent, ['custom-watch:notify']);
  assert.equal(notifier.watcher.pending.get('muted-watch').length, 1, 'le message reste tapé dans la session');

  sent.length = 0;
  db.connection.prepare("UPDATE sessions SET status='exited' WHERE id IN ('muted-watch','custom-watch')").run();
  await notifier.watcher.deliver('muted-watch', [item()]);
  await notifier.watcher.deliver('custom-watch', [item()]);
  await wait();
  assert.deepEqual(sent, ['custom-watch:notify'], 'session terminée : remise du projet, rien pour le projet coupé');
  watchMessage.mock.restore();
  flush.mock.restore();
});
