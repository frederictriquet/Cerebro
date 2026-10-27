import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Un faux « claude » relève l'environnement réellement reçu par le PTY de la session, ainsi que celui
// de son parent direct (le holder), que l'agent peut lire dans /proc/$PPID/environ.
const root = mkdtempSync(join(tmpdir(), 'cerebro-session-env-'));
const bin = join(root, 'bin');
const project = join(root, 'project');
const capture = join(root, 'env.json');
mkdirSync(bin);
mkdirSync(project);
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
const holder = fs.readFileSync('/proc/' + process.ppid + '/environ', 'utf8');
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ env: process.env, holder }));
`, { mode: 0o755 });
const secrets = {
  CEREBRO_BIND_TOKEN: 'bind-token-sentinel', CEREBRO_SLACK_TOKEN: 'slack-token-sentinel',
  CEREBRO_SLACK_USER: 'slack-user-sentinel', CEREBRO_FUTURE_SECRET: 'future-secret-sentinel',
};
Object.assign(process.env, secrets, {
  HOME: root, CEREBRO_DATA_DIR: join(root, 'data'), PATH: `${bin}:${process.env.PATH}`,
  CEREBRO_SESSION_ID: 'parent-session', CEREBRO_TOKEN: 'parent-token', CEREBRO_URL: 'http://parent.invalid',
});

const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { INTERNAL_URL, ROOT } = await import('../server/config.ts');

after(() => rmSync(root, { recursive: true, force: true }));

test('le PTY d’une session ne reçoit que les variables Cerebro de la liste blanche', async () => {
  const db = new CerebroDatabase(join(root, 'cerebro.db'));
  const manager = new SessionManager(db);
  try {
    const created = db.createProject('Projet', project);
    db.updateProject(created.id, { workspaceMode: 'shared' });
    const session = await manager.create(db.getProject(created.id), { agent: 'claude', mode: 'default', prompt: 'env' }, undefined, undefined, undefined, { rememberDefaults: false });
    const deadline = Date.now() + 10_000;
    while (!existsSync(capture) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const { env, holder } = JSON.parse(readFileSync(capture, 'utf8'));
    const cerebro = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('CEREBRO_')));
    assert.deepEqual(cerebro, {
      CEREBRO_SESSION_ID: session.id,
      CEREBRO_TOKEN: db.getHookToken(session.id),
      CEREBRO_URL: INTERNAL_URL,
      CEREBRO_NOTIFY: join(ROOT, 'bin', 'cerebro-notify'),
      CEREBRO_BACKLOG: join(ROOT, 'bin', 'cerebro-backlog'),
    });
    for (const value of Object.values(secrets)) assert.ok(!JSON.stringify(env).includes(value));
    assert.ok(holder.includes(`HOME=${root}`), 'L’environnement relevé est bien celui du holder.');
    assert.deepEqual(holder.split('\0').filter((entry) => entry.startsWith('CEREBRO_')), [], 'Le holder ne porte aucune variable Cerebro.');
    for (const [key, value] of Object.entries(secrets)) assert.equal(process.env[key], value, 'L’environnement du serveur reste intact.');
  } finally {
    await manager.shutdown();
    db.close();
  }
});
