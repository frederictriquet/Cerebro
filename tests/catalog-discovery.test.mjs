import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

// Fausses CLI : codex répond lentement à `codex debug models`, grok échoue ; claude est absent.
const root = mkdtempSync(join(tmpdir(), 'cerebro-catalog-'));
const bin = join(root, 'bin');
mkdirSync(bin);
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
process.env.PATH = `${bin}:/usr/bin:/bin`;
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
const models = { models: [{ slug: 'gpt-saved', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'high' }, { effort: 'xhigh' }] }] };
writeFileSync(join(root, 'models.json'), JSON.stringify(models));
writeFileSync(join(bin, 'codex'), `#!/bin/sh\nsleep 0.5\ncat '${join(root, 'models.json')}'\n`);
writeFileSync(join(bin, 'grok'), '#!/bin/sh\nexit 1\n');
chmodSync(join(bin, 'codex'), 0o755);
chmodSync(join(bin, 'grok'), 0o755);

const { SessionManager } = await import('../server/sessions.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { refreshCatalog } = await import('../server/catalog.ts');
const { buildServer } = await import('../server/index.ts');

mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});
mock.method(SessionManager.prototype, 'launch', async function (project, { agent, mode, tuning, prompt, existingId = null, epicId = null }) {
  const id = existingId ?? randomUUID();
  return this.db.createSession({
    id, projectId: project.id, agent, mode, ...tuning, prompt, title: prompt, status: 'exited', agentSessionId: id,
  }, 'test-token', epicId);
});
mock.method(console, 'warn', () => {});

after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

test('modèles mémorisés acceptés pendant la découverte du catalogue et après son échec', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    const { id } = (await send('POST', '/api/projects', { name: 'Catalogue', path: root })).json();
    const saved = { agent: 'codex', mode: 'acceptEdits', model: 'gpt-saved', effort: 'xhigh', prompt: '' };

    // Découverte en cours : le repli codex ne liste aucun modèle, la route attend le catalogue réel.
    const discovery = refreshCatalog();
    let response = await send('PATCH', `/api/projects/${id}`, { sessionDefaults: saved });
    assert.equal(response.statusCode, 200, response.body);
    await discovery;
    void refreshCatalog();
    response = await send('POST', `/api/projects/${id}/sessions`, {});
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().model, 'gpt-saved');
    assert.equal(response.json().effort, 'xhigh');

    // Catalogue découvert : un modèle qu'il ne propose pas reste refusé.
    response = await send('POST', `/api/projects/${id}/sessions`, { model: 'inconnu' });
    assert.equal(response.statusCode, 400);

    // Découverte grok échouée : le repli est incomplet, le modèle mémorisé est conservé.
    response = await send('POST', `/api/projects/${id}/sessions`, { agent: 'grok', model: 'grok-saved', effort: 'high' });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().model, 'grok-saved');
    response = await send('POST', `/api/projects/${id}/sessions`, { agent: 'grok', model: 'grok-saved', effort: 'ultra' });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('un rafraîchissement périodique du catalogue ne bloque pas les lancements', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    const { id } = (await send('POST', '/api/projects', { name: 'Rafraîchissement', path: root })).json();
    await refreshCatalog();
    // Redécouverte lente qui apporte un nouveau modèle : le lancement n'attend pas sa fin.
    writeFileSync(join(root, 'models.json'), JSON.stringify({ models: [...models.models, { slug: 'gpt-new', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'high' }] }] }));
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nsleep 2\ncat '${join(root, 'models.json')}'\n`);
    const codexModels = (r) => r.json().find((a) => a.agent === 'codex').models;
    let refreshed = false;
    const refresh = refreshCatalog().then(() => { refreshed = true; });
    const response = await send('POST', `/api/projects/${id}/sessions`, { agent: 'codex', model: 'gpt-saved', effort: 'high', prompt: '' });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(refreshed, false);
    assert.equal(codexModels(await send('GET', '/api/agents')).some((m) => m.value === 'gpt-new'), false);
    await refresh;
    assert.equal(codexModels(await send('GET', '/api/agents')).some((m) => m.value === 'gpt-new'), true);
  } finally {
    await app.close();
  }
});
