import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-council-api-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
const { CouncilRuns, UPLOAD_RETENTION_MS } = await import('../server/council-runner.ts');
const { Catalog } = await import('../server/catalog.ts');
const { ANSWER_SCHEMA, REVIEW_SCHEMA } = await import('../server/council.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');
const { getAgentAvailability } = await import('../server/agents.ts');
mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});
// Agents installés, modifiables par test.
let installed = ['claude', 'codex', 'grok'];
mock.method(CouncilRuns.prototype, 'availableAgents', async () => installed);
// Réponses canoniques ; `hold` suspend les réponses jusqu'à l'annulation.
const calls = [];
let hold = false;
mock.method(CouncilRuns.prototype, 'invoke', async (options) => {
  const kind = options.schema === ANSWER_SCHEMA ? 'answer' : options.schema === REVIEW_SCHEMA ? 'review' : 'synthesis';
  calls.push({ ...options, kind });
  if (hold)
    await new Promise((_, reject) =>
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
  if (kind === 'answer') return { answer: `Avis via ${options.agent}` };
  if (kind === 'review')
    return {
      ranking: [...options.prompt.matchAll(/<reponse lettre="([A-H])">/g)].map((match) => ({
        letter: match[1],
        reason: 'Solide.',
      })),
      blindSpot: 'Le coût.',
      missed: 'Les tests.',
    };
  return {
    agreements: 'Accord.',
    disagreements: 'Désaccord.',
    blindSpots: 'Angle mort.',
    recommendation: 'Recommandation finale.',
    firstAction: 'Mesurer.',
  };
});
after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});
const settled = async (send, id) => {
  let run;
  for (let i = 0; i < 300; i++) {
    run = (await send('GET', `/api/councils/${id}`)).json();
    if (run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return run;
};

test('council API: settings, project override, runs, cancel, export and persistence', async () => {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  let app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    // Réglages globaux calculés : toutes les personas, agents disponibles en tourniquet, chairman claude.
    let response = await send('GET', '/api/council/settings');
    assert.equal(response.statusCode, 200);
    const defaults = response.json();
    const personas = (await send('GET', '/api/personas')).json();
    assert.deepEqual(
      Object.keys(defaults.assignments),
      personas.map((persona) => persona.id),
    );
    assert.deepEqual(defaults.assignments[personas[1].id], { agent: 'codex', model: null, effort: 'high' });
    assert.deepEqual(
      defaults.defaultPersonaIds,
      personas.map((persona) => persona.id),
    );
    assert.deepEqual(defaults.chairman, { agent: 'claude', model: 'opus', effort: 'high' });
    assert.equal(defaults.readProject, true);
    const global = {
      assignments: {
        contrarian: { agent: 'codex', model: null, effort: 'high' },
        outsider: { agent: 'grok', model: null, effort: 'high' },
      },
      defaultPersonaIds: ['contrarian', 'outsider'],
      chairman: { agent: 'claude', model: 'sonnet', effort: 'low' },
      readProject: false,
    };
    response = await send('PUT', '/api/council/settings', global);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), global);
    for (const invalid of [
      null,
      { ...global, defaultPersonaIds: ['contrarian'] },
      { ...global, defaultPersonaIds: ['contrarian', 'unknown'] },
      { ...global, assignments: { unknown: { agent: 'claude' } } },
      { ...global, chairman: { agent: 'unknown' } },
      { ...global, readProject: 'yes' },
    ]) {
      response = await send('PUT', '/api/council/settings', invalid);
      assert.equal(response.statusCode, 400);
      assert.equal(typeof response.json().error, 'string');
    }
    assert.deepEqual((await send('GET', '/api/council/settings')).json(), global);

    // Surcharge projet puis retour aux réglages globaux.
    const project = (await send('POST', '/api/projects', { name: 'Council', path: repo })).json();
    assert.deepEqual((await send('GET', `/api/council/settings/effective?projectId=${project.id}`)).json(), global);
    const override = {
      ...global,
      defaultPersonaIds: ['executor', 'first-principles', 'contrarian'],
      readProject: true,
    };
    response = await send('PATCH', `/api/projects/${project.id}`, { councilSettings: override });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().councilSettings, override);
    assert.deepEqual((await send('GET', `/api/council/settings/effective?projectId=${project.id}`)).json(), override);
    assert.deepEqual((await send('GET', '/api/council/settings/effective?projectId=none')).json(), global);
    assert.deepEqual((await send('GET', '/api/council/settings/effective')).json(), global);
    assert.equal((await send('GET', `/api/council/settings/effective?projectId=${randomUUID()}`)).statusCode, 404);
    assert.equal(
      (
        await send('PATCH', `/api/projects/${project.id}`, {
          councilSettings: { ...override, defaultPersonaIds: ['executor'] },
        })
      ).statusCode,
      400,
    );
    response = await send('PATCH', `/api/projects/${project.id}`, { councilSettings: null });
    assert.equal(response.json().councilSettings, null);
    assert.deepEqual((await send('GET', `/api/council/settings/effective?projectId=${project.id}`)).json(), global);
    assert.equal((await send('PATCH', `/api/projects/${project.id}`, { councilSettings: override })).statusCode, 200);

    // Run projet avec participants explicites et lecture du dépôt.
    const projectRequest = randomUUID();
    const projectBody = {
      requestId: projectRequest,
      projectId: project.id,
      question: '  Faut-il découper le serveur ?  ',
      context: 'Deux développeurs.',
      readProject: true,
      participants: [
        { personaId: 'contrarian', agent: 'claude', model: 'sonnet', effort: 'low' },
        { personaId: 'outsider' },
        { personaId: 'executor', agent: 'codex' },
      ],
    };
    response = await send('POST', '/api/councils', projectBody);
    assert.equal(response.statusCode, 202, response.body);
    let run = response.json();
    assert.equal(run.id, projectRequest);
    assert.equal(run.status, 'running');
    assert.equal(run.origin, 'web');
    assert.equal(run.question, 'Faut-il découper le serveur ?');
    assert.equal(run.readProject, true);
    assert.deepEqual(
      run.advisors.map((advisor) => [advisor.personaId, advisor.agent, advisor.model]),
      [
        ['contrarian', 'claude', 'sonnet'],
        ['outsider', 'grok', null],
        ['executor', 'codex', null],
      ],
    );
    run = await settled(send, projectRequest);
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(run.synthesis.recommendation, 'Recommandation finale.');
    assert.equal(run.reviews.length, 3);
    const answers = calls.filter((call) => call.kind === 'answer');
    assert.equal(answers.length, 3);
    for (const call of answers) {
      assert.equal(call.access, 'read-only');
      assert.equal(call.cwd, repo);
    }
    for (const call of calls.filter((call) => call.kind !== 'answer')) {
      assert.equal(call.access, 'none');
      assert.equal(call.cwd, undefined);
    }
    assert.equal((await send('POST', '/api/councils', projectBody)).json().id, projectRequest);
    assert.equal(calls.length, 7);
    assert.equal((await send('POST', '/api/councils', { ...projectBody, question: 'Autre question' })).statusCode, 409);

    // Run hors projet : participants par défaut des réglages globaux, sans outils.
    calls.length = 0;
    const homeRequest = randomUUID();
    response = await send('POST', '/api/councils', {
      requestId: homeRequest,
      question: 'Quelle priorité ce trimestre ?',
      readProject: true,
    });
    assert.equal(response.statusCode, 202, response.body);
    run = response.json();
    assert.equal(run.projectId, null);
    assert.equal(run.readProject, false);
    assert.deepEqual(
      run.advisors.map((advisor) => [advisor.personaId, advisor.agent]),
      [
        ['contrarian', 'codex'],
        ['outsider', 'grok'],
      ],
    );
    run = await settled(send, homeRequest);
    assert.equal(run.status, 'succeeded', run.error);
    for (const call of calls) {
      assert.equal(call.access, 'none');
      assert.equal(call.cwd, undefined);
    }
    assert.deepEqual(
      (await send('GET', `/api/councils?projectId=${project.id}`)).json().map((item) => item.id),
      [projectRequest],
    );
    assert.deepEqual(
      (await send('GET', '/api/councils?projectId=none')).json().map((item) => item.id),
      [homeRequest],
    );
    assert.deepEqual(
      new Set((await send('GET', '/api/councils')).json().map((item) => item.id)),
      new Set([projectRequest, homeRequest]),
    );

    // Refus : participants, question, contexte, projet, identifiant.
    const refused = [
      [{ participants: [{ personaId: 'contrarian' }, { personaId: 'unknown' }] }, 400, /persona inconnue/],
      [{ participants: [{ personaId: 'contrarian' }] }, 400, /de 2 à 8 conseillers/],
      [{ participants: [{ personaId: 'contrarian' }, { personaId: 'contrarian' }] }, 400, /en double/],
      [{ participants: [{ personaId: 'contrarian', agent: 'unknown' }, { personaId: 'outsider' }] }, 400, /./],
      [{ question: '   ' }, 400, /Question requise/],
      [{ question: 'x'.repeat(10_001) }, 400, /Question requise/],
      [{ context: 'x'.repeat(100_001) }, 400, /Contexte invalide/],
      [{ projectId: randomUUID() }, 404, /Projet introuvable/],
      [{ projectId: 42 }, 400, /Projet invalide/],
      [{ requestId: 'not-a-uuid' }, 400, /Identifiant/],
    ];
    calls.length = 0;
    for (const [patch, status, message] of refused) {
      response = await send('POST', '/api/councils', { requestId: randomUUID(), question: 'Question ?', ...patch });
      assert.equal(response.statusCode, status, JSON.stringify(patch));
      assert.match(response.json().error, message);
    }
    assert.equal(calls.length, 0);
    assert.equal((await send('GET', '/api/councils')).json().length, 2);

    // Annulation, suppression refusée pendant l'exécution puis acceptée.
    hold = true;
    const cancelRequest = randomUUID();
    assert.equal(
      (await send('POST', '/api/councils', { requestId: cancelRequest, question: 'À annuler ?' })).statusCode,
      202,
    );
    assert.equal((await send('DELETE', `/api/councils/${cancelRequest}`)).statusCode, 409);
    response = await send('POST', `/api/councils/${cancelRequest}/cancel`);
    assert.equal(response.statusCode, 200);
    run = await settled(send, cancelRequest);
    hold = false;
    assert.equal(run.status, 'cancelled');
    assert.equal(run.error, 'Council annulé.');
    assert.equal((await send('POST', `/api/councils/${cancelRequest}/cancel`)).statusCode, 409);
    assert.equal((await send('POST', `/api/councils/${randomUUID()}/cancel`)).statusCode, 404);
    assert.equal((await send('DELETE', `/api/councils/${cancelRequest}`)).statusCode, 204);
    assert.equal((await send('GET', `/api/councils/${cancelRequest}`)).statusCode, 404);
    assert.equal((await send('DELETE', `/api/councils/${cancelRequest}`)).statusCode, 404);

    // Export Markdown.
    response = await send('GET', `/api/councils/${projectRequest}/export`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/markdown; charset=utf-8');
    assert.match(response.headers['content-disposition'], /^attachment; filename="council-[\da-f]{8}\.md"$/);
    assert.match(response.body, /^# Council : Faut-il découper le serveur \?/);
    assert.match(response.body, /## Synthèse[\s\S]*Recommandation finale\./);
    assert.match(response.body, /Avis via codex/);
    assert.equal((await send('GET', `/api/councils/${randomUUID()}/export`)).statusCode, 404);

    // Persistance après reconstruction du serveur.
    await app.close();
    app = await buildServer();
    run = (await send('GET', `/api/councils/${projectRequest}`)).json();
    assert.equal(run.status, 'succeeded');
    assert.equal(run.synthesis.firstAction, 'Mesurer.');
    assert.deepEqual((await send('GET', '/api/council/settings')).json(), global);
    assert.deepEqual((await send('GET', `/api/council/settings/effective?projectId=${project.id}`)).json(), override);
    const operations = (await send('GET', '/api/operations'))
      .json()
      .filter((operation) => operation.kind === 'council');
    assert.deepEqual(
      new Set(operations.map((operation) => operation.id)),
      new Set([`council:${projectRequest}`, `council:${homeRequest}`, `council:${cancelRequest}`]),
    );
  } finally {
    hold = false;
    await app.close();
  }
});

test('council API: attached images are uploaded, validated, owned by the run, passed to every call, served and deleted with it', async () => {
  const { existsSync } = await import('node:fs');
  let app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  try {
    // Dépôt hors projet, puis dans un projet.
    let response = await app.inject({
      method: 'POST',
      url: '/api/council/attachments',
      payload: png,
      headers: { 'content-type': 'image/png' },
    });
    assert.equal(response.statusCode, 201, response.body);
    const { path } = response.json();
    assert.match(path, /\/attachments\/council\/[^/]+\.png$/);
    assert.ok(existsSync(path));
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/council/attachments',
          payload: Buffer.from('x'),
          headers: { 'content-type': 'text/plain' },
        })
      ).statusCode,
      400,
    );
    const project = (await send('POST', '/api/projects', { name: 'Images', path: join(root, 'repo') })).json();
    response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/attachments`,
      payload: png,
      headers: { 'content-type': 'image/png' },
    });
    assert.equal(response.statusCode, 201);
    const projectPath = response.json().path;
    assert.match(projectPath, new RegExp(`/attachments/project-${project.id}/`));

    // Refus : chemin hors du dossier des pièces jointes, fichier absent, forme, agent incompatible (conseiller puis chairman).
    const participants = [
      { personaId: 'contrarian', agent: 'claude' },
      { personaId: 'executor', agent: 'codex' },
    ];
    const outside = join(root, 'outside.png');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(outside, png);
    const refused = [
      [{ images: [{ n: 1, path: outside }] }, /\[Image #1\] : hors du dossier des pièces jointes/],
      [{ images: [{ n: 1, path: `${path}.missing.png` }] }, /\[Image #1\] : fichier introuvable/],
      [{ images: [{ n: 1, path: path.replace(/\.png$/, '.txt') }] }, /\[Image #1\] : format non pris en charge/],
      [{ images: { n: 1, path } }, /Images jointes invalides/],
      [
        {
          images: [
            { n: 1, path },
            { n: 1, path },
          ],
        },
        /en double/,
      ],
      [
        {
          images: [{ n: 1, path }],
          participants: [
            { personaId: 'contrarian', agent: 'claude' },
            { personaId: 'outsider', agent: 'grok' },
          ],
        },
        /Outsider \(grok\) ne prend pas en charge les images/,
      ],
    ];
    calls.length = 0;
    for (const [patch, message] of refused) {
      response = await send('POST', '/api/councils', {
        requestId: randomUUID(),
        question: 'Que montre [Image #1] ?',
        participants,
        ...patch,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(patch));
      assert.match(response.json().error, message);
    }
    await send('PUT', '/api/council/settings', {
      assignments: {},
      defaultPersonaIds: ['contrarian', 'executor'],
      chairman: { agent: 'grok', model: null, effort: null },
      readProject: false,
    });
    response = await send('POST', '/api/councils', {
      requestId: randomUUID(),
      question: 'Que montre [Image #1] ?',
      participants,
      images: [{ n: 1, path }],
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /chairman \(grok\) ne prend pas en charge/);
    await send('PUT', '/api/council/settings', {
      assignments: {},
      defaultPersonaIds: ['contrarian', 'executor'],
      chairman: { agent: 'claude', model: null, effort: null },
      readProject: false,
    });
    assert.equal(calls.length, 0);

    // Run avec deux images : chaque appel (réponses, relectures, synthèse) les reçoit dans l'ordre des jetons.
    const requestId = randomUUID();
    response = await send('POST', '/api/councils', {
      requestId,
      projectId: project.id,
      question: 'Que montre [Image #2] ?',
      context: 'Comparer avec [Image #1].',
      readProject: false,
      participants,
      images: [
        { n: 2, path: projectPath },
        { n: 1, path },
      ],
    });
    assert.equal(response.statusCode, 202, response.body);
    let run = await settled(send, requestId);
    assert.equal(run.status, 'succeeded', run.error);
    // Le run référence ses propres fichiers, rangés sous le projet, et non ceux déposés.
    const ownDir = new RegExp(`/attachments/project-${project.id}/council-${requestId}/`);
    assert.deepEqual(
      run.images.map((image) => image.n),
      [1, 2],
    );
    for (const image of run.images) {
      assert.match(image.path, ownDir);
      assert.ok(existsSync(image.path));
    }
    const owned = run.images.map((image) => image.path);
    assert.equal(calls.length, 5);
    for (const call of calls) {
      assert.deepEqual(call.images, owned);
      assert.match(call.prompt, /\[Image #1\], \[Image #2\]/);
    }
    // Le même fichier déposé repris par un second council (brouillon rejoué) : chacun a sa propre image.
    calls.length = 0;
    const replay = randomUUID();
    assert.equal(
      (
        await send('POST', '/api/councils', {
          requestId: replay,
          question: 'Et [Image #1] ?',
          participants,
          images: [{ n: 1, path }],
        })
      ).statusCode,
      202,
    );
    run = await settled(send, replay);
    assert.equal(run.status, 'succeeded', run.error);
    assert.match(run.images[0].path, new RegExp(`/attachments/council/council-${replay}/1\\.png$`));
    // Sans image, l'option n'est pas transmise.
    calls.length = 0;
    const plain = randomUUID();
    assert.equal(
      (await send('POST', '/api/councils', { requestId: plain, question: 'Sans image ?', participants })).statusCode,
      202,
    );
    run = await settled(send, plain);
    assert.equal(run.status, 'succeeded', run.error);
    assert.deepEqual(run.images, []);
    for (const call of calls) assert.equal(call.images, undefined);

    // Lecture des images du rapport et export.
    response = await send('GET', `/api/councils/${requestId}/images/1`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.deepEqual(response.rawPayload, png);
    assert.equal((await send('GET', `/api/councils/${requestId}/images/3`)).statusCode, 404);
    assert.equal((await send('GET', `/api/councils/${randomUUID()}/images/1`)).statusCode, 404);
    assert.match(
      (await send('GET', `/api/councils/${requestId}/export`)).body,
      new RegExp(`## Images jointes\\n\\n- \\[Image #1\\] : ${owned[0]}\\n- \\[Image #2\\] : ${owned[1]}`),
    );

    // La suppression du run efface ses images, pas les fichiers déposés ni celles de l'autre council.
    assert.equal((await send('DELETE', `/api/councils/${requestId}`)).statusCode, 204);
    assert.ok(owned.every((file) => !existsSync(file)));
    assert.ok(existsSync(path) && existsSync(projectPath) && existsSync(outside));
    response = await send('GET', `/api/councils/${replay}/images/1`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, png);
    assert.equal((await send('DELETE', `/api/councils/${replay}`)).statusCode, 204);
    assert.ok(!existsSync(join(root, 'data', 'attachments', 'council', `council-${replay}`)) && existsSync(path));

    // Le dépôt hors projet, désormais sans run, est purgé au démarrage une fois son délai de grâce écoulé ;
    // un dépôt récent est conservé pour un brouillon rejoué.
    const { utimesSync } = await import('node:fs');
    response = await app.inject({
      method: 'POST',
      url: '/api/council/attachments',
      payload: png,
      headers: { 'content-type': 'image/png' },
    });
    const recent = response.json().path;
    const old = new Date(Date.now() - UPLOAD_RETENTION_MS - 60_000);
    utimesSync(path, old, old);
    await app.close();
    app = await buildServer();
    assert.ok(!existsSync(path) && existsSync(recent) && existsSync(projectPath));
  } finally {
    await app.close();
  }
});

test('upload purge removes stale council uploads unless a legacy run still references them', async () => {
  const { existsSync, writeFileSync, utimesSync } = await import('node:fs');
  const { CerebroDatabase } = await import('../server/db.ts');
  const db = new CerebroDatabase(join(root, 'purge-uploads.db'));
  try {
    const dir = join(root, 'data', 'attachments', 'council');
    mkdirSync(join(dir, 'council-kept'), { recursive: true });
    const stale = join(dir, 'stale.png');
    const legacyShared = join(dir, 'legacy.png');
    const fresh = join(dir, 'fresh.png');
    const owned = join(dir, 'council-kept', '1.png');
    for (const file of [stale, legacyShared, fresh, owned]) writeFileSync(file, 'png');
    const old = new Date(Date.now() - UPLOAD_RETENTION_MS - 60_000);
    for (const file of [stale, legacyShared, owned]) utimesSync(file, old, old);
    db.saveCouncilRun({
      id: randomUUID(),
      projectId: null,
      origin: 'web',
      question: '?',
      context: '',
      images: [{ n: 1, path: legacyShared }],
      readProject: false,
      advisors: [],
      status: 'succeeded',
      phase: 'finished',
      letters: {},
      answers: [],
      reviews: [],
      synthesis: null,
      error: null,
      startedAt: 1,
      finishedAt: 2,
    });
    const councils = new CouncilRuns(db, new Catalog());
    assert.equal(councils.purgeUploads(), 1);
    assert.ok(!existsSync(stale) && existsSync(legacyShared) && existsSync(fresh) && existsSync(owned));
    councils.purgeUploads(Date.now() + UPLOAD_RETENTION_MS + 60_000);
    assert.ok(!existsSync(fresh) && existsSync(legacyShared) && existsSync(owned));
  } finally {
    db.close();
  }
});

test('deleting a run saved before run-owned images keeps an upload another council still references', async () => {
  const { existsSync, writeFileSync } = await import('node:fs');
  const { CerebroDatabase } = await import('../server/db.ts');
  const db = new CerebroDatabase(join(root, 'legacy-images.db'));
  try {
    const dir = join(root, 'data', 'attachments', 'council');
    mkdirSync(dir, { recursive: true });
    const shared = join(dir, 'shared.png');
    const alone = join(dir, 'alone.png');
    writeFileSync(shared, 'png');
    writeFileSync(alone, 'png');
    const legacy = (images) => ({
      id: randomUUID(),
      projectId: null,
      origin: 'web',
      question: '?',
      context: '',
      images,
      readProject: false,
      advisors: [],
      status: 'succeeded',
      phase: 'finished',
      letters: {},
      answers: [],
      reviews: [],
      synthesis: null,
      error: null,
      startedAt: 1,
      finishedAt: 2,
    });
    const first = legacy([
      { n: 1, path: shared },
      { n: 2, path: alone },
    ]);
    const second = legacy([{ n: 1, path: shared }]);
    db.saveCouncilRun(first);
    db.saveCouncilRun(second);
    const councils = new CouncilRuns(db, new Catalog());
    councils.delete(first.id);
    assert.ok(existsSync(shared) && !existsSync(alone));
    councils.delete(second.id);
    assert.ok(!existsSync(shared));
  } finally {
    db.close();
  }
});

test('project deletion cancels and awaits all its councils before removing their reports', async (t) => {
  const release = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const activeCalls = [];
  let abortCount = 0;
  t.mock.method(CouncilRuns.prototype, 'invoke', async (options) => {
    activeCalls.push(options);
    options.signal.addEventListener(
      'abort',
      () => {
        if (++abortCount === 4) aborted.resolve();
      },
      { once: true },
    );
    await release.promise;
    return { answer: 'Réponse tardive.' };
  });
  let app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  let deletion;
  try {
    const project = (await send('POST', '/api/projects', { name: 'Council à supprimer', path: root })).json();
    const participants = [{ personaId: 'contrarian' }, { personaId: 'outsider' }];
    const ids = [randomUUID(), randomUUID()];
    for (const requestId of ids) {
      const response = await send('POST', '/api/councils', {
        requestId,
        projectId: project.id,
        question: 'Q ?',
        participants,
        readProject: true,
      });
      assert.equal(response.statusCode, 202, response.body);
    }
    assert.equal(activeCalls.length, 4);
    assert.ok(activeCalls.every((call) => call.access === 'read-only' && call.cwd === root));
    let deleted = false;
    deletion = send('DELETE', `/api/projects/${project.id}`).then((response) => {
      deleted = true;
      return response;
    });
    await aborted.promise;
    assert.equal(deleted, false);
    assert.ok(activeCalls.every((call) => call.signal.aborted));
    assert.ok((await send('GET', '/api/projects')).json().some((item) => item.id === project.id));
    for (const id of ids) assert.equal((await send('GET', `/api/councils/${id}`)).statusCode, 200);
    let response = await send('POST', '/api/councils', {
      requestId: randomUUID(),
      projectId: project.id,
      question: 'Pendant la suppression ?',
      participants,
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal((await send('DELETE', `/api/projects/${project.id}`)).statusCode, 409);

    release.resolve();
    response = await deletion;
    assert.equal(response.statusCode, 204, response.body);
    assert.ok(!(await send('GET', '/api/projects')).json().some((item) => item.id === project.id));
    for (const id of ids) assert.equal((await send('GET', `/api/councils/${id}`)).statusCode, 404);
    assert.deepEqual((await send('GET', `/api/councils?projectId=${project.id}`)).json(), []);
    response = await send('POST', '/api/councils', {
      requestId: randomUUID(),
      projectId: project.id,
      question: 'Après la suppression ?',
      participants,
    });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(activeCalls.length, 4);

    await app.close();
    app = await buildServer();
    for (const id of ids) assert.equal((await send('GET', `/api/councils/${id}`)).statusCode, 404);
  } finally {
    release.resolve();
    await deletion;
    await app.close();
  }
});

test('council API: an agent that is not installed is refused at launch, before any call', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    // Les réglages acceptent une CLI absente ; le lancement la refuse avant les 2N appels.
    let response = await send('PUT', '/api/council/settings', {
      assignments: {},
      defaultPersonaIds: ['contrarian', 'outsider'],
      chairman: { agent: 'grok', model: null, effort: null },
      readProject: false,
    });
    assert.equal(response.statusCode, 200, response.body);
    installed = ['claude', 'codex'];
    calls.length = 0;
    const requestId = randomUUID();
    response = await send('POST', '/api/councils', {
      requestId,
      question: 'Q ?',
      participants: [
        { personaId: 'contrarian', agent: 'claude' },
        { personaId: 'outsider', agent: 'codex' },
      ],
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'Agent non installé : chairman (grok).');
    response = await send('POST', '/api/councils', {
      requestId: randomUUID(),
      question: 'Q ?',
      participants: [
        { personaId: 'contrarian', agent: 'grok' },
        { personaId: 'outsider', agent: 'codex' },
      ],
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().error, /^Agent non installé : Contrarien \(grok\), chairman \(grok\)\.$/);
    assert.equal(calls.length, 0);
    assert.equal((await send('GET', `/api/councils/${requestId}`)).statusCode, 404);
  } finally {
    installed = ['claude', 'codex', 'grok'];
    await app.close();
  }
});

test('agent availability is cached and shared, and only re-detected on demand', async () => {
  const first = getAgentAvailability();
  assert.equal(getAgentAvailability(), first);
  const refreshed = getAgentAvailability(true);
  assert.notEqual(refreshed, first);
  assert.equal(getAgentAvailability(), refreshed);
  assert.deepEqual(
    (await refreshed).map((entry) => entry.agent),
    ['claude', 'codex', 'grok'],
  );
});
