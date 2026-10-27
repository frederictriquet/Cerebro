import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-route-errors-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
mock.method(os, 'homedir', () => root);
syncBuiltinESMExports();

const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');

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

test('une route en erreur renvoie le message brut de l’exception, sans préfixe « Error: »', async () => {
  const app = await buildServer();
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Erreurs', path: root } })).json();
    const invalid = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/commands`, payload: { name: 'Vérifier' } });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json(), { error: 'Configuration de commande invalide (argv explicite, cwd relatif, durée 1–86400 s).' });

    const missing = await app.inject({ method: 'POST', url: '/api/epic-runs/inconnue/stop' });
    assert.equal(missing.statusCode, 409);
    assert.deepEqual(missing.json(), { error: 'Exécution introuvable.' });
  } finally {
    await app.close();
  }
});
