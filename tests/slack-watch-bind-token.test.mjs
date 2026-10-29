import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-slack-watch-bind-token-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CEREBRO_BIND_TOKEN = 'browser-token';
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

test('avec un jeton de liaison, cerebro-slack-watch passe par le seul jeton de session', async () => {
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
    const list = (token) =>
      app.inject({ method: 'GET', url: `/api/slack-watch/${session.id}`, headers: { 'x-cerebro-token': token } });
    // Le jeton de session franchit le contrôle global : la route répond elle-même (ici, surveillance non configurée).
    const accepted = await list('token');
    assert.equal(accepted.statusCode, 503);
    assert.equal(accepted.json().error, SLACK_WATCH_UNCONFIGURED);
    assert.equal((await list('wrong')).statusCode, 403);
    // Les routes de l'interface restent protégées par le jeton de liaison.
    assert.equal((await app.inject({ method: 'GET', url: '/api/slack/watches' })).statusCode, 401);
  } finally {
    db.close();
    await app.close();
  }
});
