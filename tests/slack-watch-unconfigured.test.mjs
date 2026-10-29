import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-slack-watch-unconfigured-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
delete process.env.CEREBRO_SLACK_USER_TOKEN;
mock.method(os, 'homedir', () => root);
syncBuiltinESMExports();

const { CerebroDatabase } = await import('../server/db.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');
const { SLACK_WATCH_UNCONFIGURED } = await import('../server/config.ts');
mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
});

test('sans jeton utilisateur Slack, les routes de surveillance répondent 503 explicitement', async () => {
  const app = await buildServer();
  const db = new CerebroDatabase();
  try {
    const project = db.createProject('Demo', root);
    const session = db.createSession(
      {
        id: randomUUID(),
        projectId: project.id,
        agent: 'claude',
        mode: 'auto',
        model: null,
        effort: null,
        prompt: '',
        title: 'Session',
        status: 'idle',
        agentSessionId: 'fake',
      },
      'token',
    );
    const send = (method, path, payload) =>
      app.inject({
        method,
        url: `/api/slack-watch/${session.id}${path}`,
        headers: { 'x-cerebro-token': 'token' },
        ...(payload === undefined ? {} : { payload }),
      });
    for (const response of [
      await send('POST', '', { channel: 'C0C7TN7UBKL', threadTs: '1700000000.000100' }),
      // Le jeton manquant est signalé d'abord, même pour un corps invalide.
      await send('POST', '', {}),
      await send('GET', ''),
      await send('DELETE', '/1700000000.000100'),
    ]) {
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error, SLACK_WATCH_UNCONFIGURED);
    }
    // L'interface web n'affiche rien et explique le jeton manquant dans le panneau Slack.
    assert.equal((await app.inject({ method: 'GET', url: '/api/slack' })).json().watchEnabled, false);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/slack/watches' })).json(), {
      enabled: false,
      defaultDeliver: ['inject'],
      botEnabled: false,
      watches: [],
    });
    const removed = await app.inject({ method: 'DELETE', url: `/api/slack/watches/${session.id}/abc` });
    assert.equal(removed.statusCode, 503);
    assert.equal(removed.json().error, SLACK_WATCH_UNCONFIGURED);
  } finally {
    db.close();
    await app.close();
  }
});
