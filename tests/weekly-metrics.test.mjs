import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-weekly-metrics-'));
const claudeDir = join(root, 'claude');
const metricsDir = join(claudeDir, 'metrics');

process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.GROK_HOME = join(root, 'grok');
process.env.CEREBRO_BIND_TOKEN = 'jeton-test-hebdo';
process.env.CEREBRO_MACHINE_NAME = 'PC';
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
delete process.env.CEREBRO_SLACK_USER_TOKEN;
mkdirSync(process.env.CEREBRO_DATA_DIR, { recursive: true });

const write = (path, value) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
};

const week = (id, extra = {}) => ({
  semaine: id,
  debut: '2026-11-02',
  fin: '2026-11-08',
  terminee: true,
  debut_tronque: false,
  volume: { messages_tapes: 297, sessions_interactives: 37 },
  friction: { plaintes_haiku: { pct: 10.4, categories: { exactitude: 12, clarte: 6, repetition: 2, autre: 1 } } },
  ...extra,
});

write(
  join(metricsDir, 'weeks', '2026-W45.json'),
  week('2026-W45', { outils_externes: { appels: { cerebro: 394 }, erreurs: {} } }),
);
write(join(metricsDir, 'weeks', '2026-W44.json'), week('2026-W44'));
write(join(metricsDir, 'weeks', '2026-W43.json'), '{ pas du json');
write(join(metricsDir, 'weeks', 'notes.json'), { ignore: true });
write(join(metricsDir, 'manual.json'), { '2026-W44': { plaintes: 11, messages_tapes: 179 } });
write(join(metricsDir, 'machines', 'macbook', 'weeks', '2026-W45.json'), week('2026-W45'));
const syntheses = { semaine: '2026-W45', redige_le: '2026-11-14', textes: { messages: 'Volume en hausse.' } };
write(join(metricsDir, 'syntheses.json'), syntheses);
write(join(metricsDir, 'machines', 'macbook', 'syntheses.json'), { semaine: '2026-W45', textes: { messages: 3 } });
mkdirSync(join(metricsDir, 'machines', 'sans-releve'), { recursive: true });

const { PeerSync } = await import('../server/peers.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { buildServer } = await import('../server/index.ts');
const { readWeeklyMetrics, machineSlug } = await import('../server/weekly-metrics.ts');
const { parseWeeklyMetricsReport } = await import('../shared/weekly-metrics.ts');
const metrics = await import('../web/src/weekly-metrics.ts');

mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});

let app;

before(async () => {
  app = await buildServer();
});

after(async () => {
  if (app) await app.close();
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

test('GET /api/weekly-metrics : jeton exigé, relevés du PC et des machines copiées', async () => {
  const denied = await app.inject({ method: 'GET', url: '/api/weekly-metrics' });
  assert.equal(denied.statusCode, 401);

  const response = await app.inject({
    method: 'GET',
    url: '/api/weekly-metrics',
    headers: { authorization: 'Bearer jeton-test-hebdo' },
  });
  assert.equal(response.statusCode, 200);
  const report = parseWeeklyMetricsReport(response.json());
  assert.ok(report, 'réponse conforme au contrat partagé');
  assert.equal(report.directory, metricsDir);
  assert.deepEqual(
    report.machines.map((m) => [m.id, m.name, m.weeks.map((w) => w.semaine)]),
    [
      ['local', 'PC', ['2026-W44', '2026-W45']],
      ['macbook', 'macbook', ['2026-W45']],
    ],
  );
  assert.deepEqual(report.machines[0].manual, { '2026-W44': { plaintes: 11, messages_tapes: 179 } });
  assert.deepEqual(report.machines[1].manual, {});
  assert.deepEqual(report.machines[0].syntheses, syntheses);
  assert.equal(report.machines[1].syntheses, null, 'synthèses mal formées : écartées');
  assert.equal(report.problems.length, 2);
  assert.match(report.problems[0], /2026-W43\.json : /);
  assert.match(report.problems[1], /macbook\/syntheses\.json : synthèses mal formées/);
});

test('nom d’une machine copiée : celui de remotes.json dont le dossier porte le slug', async () => {
  assert.equal(machineSlug('MacBook Pro (Fred)'), 'macbook-pro-fred');
  const remotes = join(process.env.CEREBRO_DATA_DIR, 'remotes.json');
  writeFileSync(remotes, JSON.stringify([{ id: 'mac', name: 'MacBook', url: 'http://127.0.0.1:9' }]));
  try {
    const report = await readWeeklyMetrics(metricsDir);
    assert.deepEqual(
      report.machines.map((m) => m.name),
      ['PC', 'MacBook'],
    );
  } finally {
    rmSync(remotes);
  }
});

test('aucun relevé sur la machine : liste vide, sans erreur', async () => {
  assert.deepEqual(await readWeeklyMetrics(join(root, 'absent')), {
    directory: join(root, 'absent'),
    machines: [],
    problems: [],
  });
});

test('indicateurs : mêmes calculs que le rapport, « — » pour une rubrique absente', () => {
  const machine = {
    id: 'local',
    name: 'PC',
    syntheses: null,
    manual: { '2026-W44': { plaintes: 11, messages_tapes: 179 } },
    weeks: [
      week('2026-W44'),
      week('2026-W45', {
        terminee: false,
        outils_externes: {
          appels: { cerebro: 394, 'mcp:claude_ai_Slack': 76, 'mcp:aida-mcp': 6 },
          erreurs: { cerebro: 8 },
        },
      }),
    ],
  };
  const [w44, w45] = metrics.weekViews(machine);
  assert.equal(w44.label, 'S44');
  assert.equal(metrics.weekLabel('2026-W05'), 'S5');
  assert.equal(w45.complete, false);
  const I = metrics.INDICATORS;
  assert.equal(I.complaintsManual.get(w44), 6.1);
  assert.equal(I.complaintsManual.get(w45), null);
  assert.equal(I.complaintsHaiku.get(w44), 10.4);
  assert.equal(I.cerebroCli.get(w44), null, 'outils externes absents : pas de zéro inventé');
  assert.equal(I.cerebroCli.get(w45), 394);
  assert.equal(I.cerebroErrors.get(w45), 8);
  assert.equal(I.glab.get(w45), 0);
  assert.equal(I.mcpSlack.get(w45), 76);
  assert.equal(I.mcpOther.get(w45), 6);
  assert.equal(I.mcpServers.get(w45), 2);
  // ne marche pas, exactitude, clarté, incomplet, qualité du rendu, agi sans demande, autres (répétition + autre)
  assert.deepEqual(metrics.complaintCategories(w44), [0, 12, 6, 0, 0, 0, 3]);
  assert.deepEqual(metrics.headlineWeeks([w44, w45]), { current: w44, previous: null });
});
