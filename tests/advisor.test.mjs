import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Aucun agent ni configuration réels : tout vit dans un dossier temporaire.
const root = mkdtempSync(join(tmpdir(), 'cerebro-advisor-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;

const { buildAgentCommand } = await import('../server/agents.ts');
const { buildServer } = await import('../server/index.ts');
const { CerebroDatabase } = await import('../server/db.ts');
const { normalizeAdvisorModel } = await import('../shared/machine.ts');

after(() => rmSync(root, { recursive: true, force: true }));

test('--advisor n’est ajouté qu’aux commandes Claude, au lancement comme à la reprise', () => {
  const tuning = { model: 'claude-sonnet-5-5', effort: null };
  for (const resume of [null, 'previous']) {
    const { args } = buildAgentCommand('claude', 'auto', '', 'id', resume, tuning, 'claude-fable-5-1');
    const index = args.indexOf('--advisor');
    assert.notEqual(index, -1);
    assert.equal(args[index + 1], 'claude-fable-5-1');
    assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  }
  assert.ok(!buildAgentCommand('claude', 'auto', '', 'id', null, tuning).args.includes('--advisor'));
  assert.ok(!buildAgentCommand('claude', 'auto', '', 'id', null, tuning, null).args.includes('--advisor'));
  for (const agent of ['codex', 'grok']) {
    const { args } = buildAgentCommand(agent, 'auto', '', 'id', null, tuning, 'claude-fable-5-1');
    assert.ok(!args.includes('--advisor'), agent);
  }
});

test('normalizeAdvisorModel refuse tout ce qui pourrait passer pour une option ou plusieurs arguments', () => {
  assert.equal(normalizeAdvisorModel(null), null);
  assert.equal(normalizeAdvisorModel('  '), null);
  assert.equal(normalizeAdvisorModel(' claude-fable-5-1 '), 'claude-fable-5-1');
  assert.equal(normalizeAdvisorModel('claude-opus-4-7[1m]'), 'claude-opus-4-7[1m]');
  for (const bad of ['--model', '-x', 'a b', 'a\nb', 'x'.repeat(101), 42, {}, true]) {
    assert.equal(normalizeAdvisorModel(bad), undefined, String(bad));
  }
});

test('API : l’advisor est enregistré globalement, retiré par null et validé', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    assert.deepEqual((await send('GET', '/api/advisor')).json(), { model: null });
    let response = await send('PUT', '/api/advisor', { model: ' claude-fable-5-1 ' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { model: 'claude-fable-5-1' });
    assert.deepEqual((await send('GET', '/api/advisor')).json(), { model: 'claude-fable-5-1' });

    // Une valeur invalide laisse le réglage en place.
    for (const model of ['--model', 'a b', 7]) {
      response = await send('PUT', '/api/advisor', { model });
      assert.equal(response.statusCode, 400);
    }
    assert.equal((await send('PUT', '/api/advisor', {})).statusCode, 400);
    assert.deepEqual((await send('GET', '/api/advisor')).json(), { model: 'claude-fable-5-1' });

    // Il survit à un redémarrage (même base), puis se désactive par null.
    const db = new CerebroDatabase();
    try {
      assert.equal(db.getAdvisorModel(), 'claude-fable-5-1');
    } finally {
      db.close();
    }
    response = await send('PUT', '/api/advisor', { model: null });
    assert.deepEqual(response.json(), { model: null });
    assert.deepEqual((await send('GET', '/api/advisor')).json(), { model: null });
  } finally {
    await app.close();
  }
});
