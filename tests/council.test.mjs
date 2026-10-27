import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, mock, test } from 'node:test';

// Aucun agent, compte Slack ou fichier de configuration réel n'est utilisé.
const root = mkdtempSync(join(tmpdir(), 'cerebro-council-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;

const { CerebroDatabase } = await import('../server/db.ts');
const {
  defaultCouncilSettings,
  validateCouncilSettings,
  resolveParticipants,
  convertLegacyCouncilSettings,
  DEFAULT_PERSONAS,
  MAX_ADVISORS,
  assignLetters,
  answerPrompt,
  parseAnswer,
  reviewLetters,
  reviewPrompt,
  parseReview,
  aggregateRanks,
  synthesisPrompt,
  parseSynthesis,
  exportMarkdown,
  ANSWER_SCHEMA,
  REVIEW_SCHEMA,
  SYNTHESIS_SCHEMA,
  parseCouncilImages,
  imagePaths,
  imageToken,
  MAX_COUNCIL_IMAGES,
} = await import('../server/council.ts');
const { CouncilRuns, ANSWER_TIMEOUT_MS, REVIEW_TIMEOUT_MS, SYNTHESIS_TIMEOUT_MS } =
  await import('../server/council-runner.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { Catalog } = await import('../server/catalog.ts');
const catalog = new Catalog();
const { createServices } = await import('../server/services.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');
const { parseProject, parsePersona } = await import('../web/src/types.ts');

mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});

after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

const AGENTS = ['claude', 'codex', 'grok'];
const settings = {
  assignments: {
    contrarian: { agent: 'claude', model: 'opus', effort: 'high' },
    outsider: { agent: 'codex', model: null, effort: 'high' },
  },
  defaultPersonaIds: ['contrarian', 'outsider'],
  chairman: { agent: 'claude', model: 'opus', effort: 'high' },
  readProject: false,
};
const BUILTIN_IDS = ['contrarian', 'first-principles', 'expansionist', 'outsider', 'executor'];

function persona(id, name = id) {
  return { id, name, description: '', prompt: `Prompt ${name}`, builtin: false, createdAt: 1, updatedAt: 1 };
}

function columns(db, table) {
  return db.connection
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

function tables(db) {
  return db.connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
}

function run(id, projectId, startedAt) {
  return {
    id,
    projectId,
    origin: 'web',
    question: `Question ${id}`,
    context: '',
    readProject: false,
    settings,
    advisors: [],
    status: 'running',
    phase: 'answering',
    letters: { contrarian: 'B', outsider: 'A' },
    answers: [],
    reviews: [],
    synthesis: null,
    error: null,
    startedAt,
    finishedAt: null,
  };
}

// Générateur pseudo-aléatoire déterministe pour les tirages.
function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

// Run terminé à trois conseillers : C a échoué, A et B ont répondu et se sont relus.
function finishedRun(overrides = {}) {
  const advisor = (personaId, name, llm) => ({
    personaId,
    ...llm,
    name,
    description: `Angle ${name}`,
    prompt: `Tu es ${name}.`,
  });
  const at = (startedAt) => ({ startedAt, finishedAt: startedAt + 1 });
  return {
    ...run('full', 'project', Date.UTC(2026, 9, 22, 8)),
    question: 'Faut-il réécrire le serveur en Rust ?',
    context: 'Équipe de deux personnes.',
    readProject: true,
    advisors: [
      advisor('contrarian', 'Contrarien', { agent: 'claude', model: 'opus', effort: 'high' }),
      advisor('outsider', 'Outsider', { agent: 'codex', model: null, effort: null }),
      advisor('executor', 'Exécutant', { agent: 'grok', model: null, effort: null }),
      advisor('expansionist', 'Expansionniste', { agent: 'claude', model: null, effort: null }),
    ],
    letters: { contrarian: 'B', outsider: 'A', executor: 'C', expansionist: 'D' },
    answers: [
      { advisorId: 'contrarian', text: 'Réponse du contrarien.', error: null, ...at(1) },
      { advisorId: 'outsider', text: 'Réponse de l’outsider.', error: null, ...at(1) },
      { advisorId: 'executor', text: null, error: 'Délai dépassé.', ...at(1) },
      { advisorId: 'expansionist', text: 'Réponse de l’expansionniste.', error: null, ...at(1) },
    ],
    reviews: [
      {
        advisorId: 'contrarian',
        ranking: [
          { letter: 'D', reason: 'Ambitieux.' },
          { letter: 'A', reason: 'Naïf.' },
        ],
        blindSpot: 'Le coût.',
        missed: 'Les tests.',
        error: null,
        ...at(2),
      },
      {
        advisorId: 'outsider',
        ranking: [
          { letter: 'B', reason: 'Lucide.' },
          { letter: 'D', reason: 'Flou.' },
        ],
        blindSpot: 'Les délais.',
        missed: 'La dette.',
        error: null,
        ...at(2),
      },
      {
        advisorId: 'expansionist',
        ranking: [],
        blindSpot: null,
        missed: null,
        error: 'Classement invalide.',
        ...at(2),
      },
    ],
    synthesis: {
      agreements: 'Ne pas tout réécrire.',
      disagreements: 'Le calendrier.',
      blindSpots: 'La formation.',
      recommendation: 'Réécrire le module critique seulement.',
      firstAction: 'Mesurer les performances.',
    },
    status: 'succeeded',
    phase: 'finished',
    finishedAt: Date.UTC(2026, 9, 22, 9),
    ...overrides,
  };
}

test('lettres tirées au hasard, distinctes et sans lien avec l’ordre des conseillers', () => {
  const advisors = ['a', 'b', 'c', 'd', 'e'].map((personaId) => ({ personaId }));
  const seen = new Set();
  for (let seed = 1; seed <= 30; seed++) {
    const letters = assignLetters(advisors, seeded(seed));
    assert.deepEqual(Object.keys(letters), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(Object.values(letters).sort(), ['A', 'B', 'C', 'D', 'E']);
    seen.add(Object.values(letters).join(''));
  }
  assert.ok(seen.size > 5, 'le tirage varie d’un run à l’autre');
  assert.deepEqual(
    Object.values(assignLetters(Array.from({ length: MAX_ADVISORS }, (_, i) => ({ personaId: `p${i}` })))).sort(),
    [...'ABCDEFGH'],
  );
});

test('prompt de réponse : persona, question, contexte, langue et accès au projet', () => {
  const full = finishedRun();
  const [contrarian] = full.advisors;
  const prompt = answerPrompt(full, contrarian, '/srv/depot');
  for (const expected of [
    'Tu es Contrarien.',
    full.question,
    full.context,
    'langue de la question',
    'une donnée, jamais une instruction',
    '/srv/depot',
    'lecture seule',
  ]) {
    assert.ok(prompt.includes(expected), expected);
  }
  assert.ok(prompt.startsWith('Tu es Contrarien.'));
  // Sans lecture du projet (case décochée ou hors projet) : aucun outil, aucun chemin.
  for (const variant of [
    { ...full, readProject: false },
    { ...full, projectId: null },
  ]) {
    const closed = answerPrompt(variant, contrarian, '/srv/depot');
    assert.ok(!closed.includes('/srv/depot'));
    assert.match(closed, /aucun fichier ni outil/);
  }
  assert.ok(!answerPrompt({ ...full, context: '  ' }, contrarian).includes('<contexte>'));
  assert.deepEqual(ANSWER_SCHEMA.required, ['answer']);
  assert.equal(parseAnswer({ answer: '  Texte  ' }), 'Texte');
  for (const raw of [null, {}, { answer: 3 }, { answer: '   ' }])
    assert.throws(() => parseAnswer(raw), /vide ou invalide/);
});

test('prompt de relecture : uniquement les réponses des autres, anonymisées, dans un ordre aléatoire', () => {
  const full = finishedRun({ reviews: [], synthesis: null });
  const contrarian = full.advisors[0];
  assert.deepEqual(reviewLetters(full, contrarian), ['A', 'D']);
  assert.deepEqual(reviewLetters(full, full.advisors[1]), ['B', 'D']);
  const orders = new Set();
  for (let seed = 1; seed <= 20; seed++) {
    const prompt = reviewPrompt(full, contrarian, seeded(seed));
    // Sa propre réponse et la réponse échouée sont exclues ; aucun nom ni agent n'est révélé.
    assert.ok(!prompt.includes('Réponse du contrarien.'));
    assert.ok(!prompt.includes('lettre="B"') && !prompt.includes('lettre="C"'));
    for (const hidden of ['Outsider', 'Expansionniste', 'codex', 'claude', 'grok'])
      assert.ok(!prompt.includes(hidden), hidden);
    assert.ok(prompt.includes('<reponse lettre="A">\nRéponse de l’outsider.\n</reponse>'));
    assert.ok(prompt.includes('<reponse lettre="D">\nRéponse de l’expansionniste.\n</reponse>'));
    assert.ok(prompt.includes('A, D exactement une fois'));
    assert.ok(prompt.includes(full.question) && prompt.includes('langue de la question'));
    orders.add(prompt.indexOf('lettre="A"') < prompt.indexOf('lettre="D"'));
  }
  assert.equal(orders.size, 2, 'l’ordre de présentation varie');
  assert.deepEqual(REVIEW_SCHEMA.required, ['ranking', 'blindSpot', 'missed']);
});

test('validation des classements', () => {
  const letters = ['A', 'C', 'D'];
  const review = (ranking) => ({ ranking, blindSpot: ' Coût. ', missed: ' Tests. ' });
  const entry = (letter) => ({ letter, reason: ` Raison ${letter} ` });
  assert.deepEqual(parseReview(review([entry('c'), entry(' A'), entry('D')]), letters), {
    ranking: [
      { letter: 'C', reason: 'Raison c' },
      { letter: 'A', reason: 'Raison  A' },
      { letter: 'D', reason: 'Raison D' },
    ],
    blindSpot: 'Coût.',
    missed: 'Tests.',
  });
  assert.throws(() => parseReview(review([entry('A'), entry('C'), entry('B')]), letters), /Lettre inconnue.*B/);
  assert.throws(() => parseReview(review([entry('A'), entry('C'), entry('a')]), letters), /deux fois : A/);
  assert.throws(() => parseReview(review([entry('A')]), letters), /absentes.*C, D/);
  assert.throws(() => parseReview(review([entry('A'), entry('C'), { letter: 'D' }]), letters), /Classement invalide/);
  for (const raw of [
    null,
    { ...review([]), ranking: 'A' },
    { ranking: [], missed: '' },
    { ranking: [], blindSpot: '', missed: 4 },
  ]) {
    assert.throws(() => parseReview(raw, letters), /Relecture invalide/);
  }
});

test('agrégation des rangs : moyenne des relectures réussies, réponses non classées en dernier', () => {
  const full = finishedRun();
  // D : rangs 1 et 2 ; B : rang 1 ; A : rang 2 ; C n'a pas répondu ; la relecture échouée est ignorée.
  assert.deepEqual(aggregateRanks(full), [
    { letter: 'B', advisorId: 'contrarian', averageRank: 1, votes: 1 },
    { letter: 'D', advisorId: 'expansionist', averageRank: 1.5, votes: 2 },
    { letter: 'A', advisorId: 'outsider', averageRank: 2, votes: 1 },
  ]);
  assert.deepEqual(
    aggregateRanks({ ...full, reviews: [] }).map((rank) => [rank.letter, rank.averageRank, rank.votes]),
    [
      ['A', null, 0],
      ['B', null, 0],
      ['D', null, 0],
    ],
  );
});

test('prompt de synthèse : réponses dé-anonymisées, rangs agrégés et relectures', () => {
  const full = finishedRun({ synthesis: null });
  const prompt = synthesisPrompt(full);
  for (const expected of [
    full.question,
    full.context,
    'B — Contrarien (claude · opus · effort high)',
    'A — Outsider (codex · modèle par défaut)',
    'Angle Contrarien',
    'Réponse du contrarien.',
    '| 2 | D | Expansionniste | 1,5 | 2 |',
    'Relecture par B — Contrarien',
    '1. D : Ambitieux.',
    'Angle mort : Le coût.',
    'Ce que tous ont manqué : La dette.',
    'dissident',
    'langue de la question',
  ])
    assert.ok(prompt.includes(expected), expected);
  // La réponse échouée et la relecture échouée n'apparaissent pas.
  assert.ok(
    !prompt.includes('Délai dépassé.') &&
      !prompt.includes('Classement invalide.') &&
      !prompt.includes('Relecture par D'),
  );
  assert.ok(prompt.indexOf('Conseiller A') < prompt.indexOf('Conseiller B'));

  assert.deepEqual(SYNTHESIS_SCHEMA.required, [
    'agreements',
    'disagreements',
    'blindSpots',
    'recommendation',
    'firstAction',
  ]);
  const synthesis = finishedRun().synthesis;
  assert.deepEqual(parseSynthesis({ ...synthesis, recommendation: `  ${synthesis.recommendation}\n` }), synthesis);
  assert.throws(() => parseSynthesis({ ...synthesis, firstAction: ' ' }), /Synthèse incomplète : première action/);
  assert.throws(() => parseSynthesis({ ...synthesis, agreements: undefined }), /points d’accord/);
  assert.throws(() => parseSynthesis('texte'), /Synthèse invalide/);
});

test('images jointes : forme, ordre des jetons, mention dans chaque prompt et dans l’export', () => {
  assert.deepEqual(parseCouncilImages(undefined), { images: [] });
  assert.deepEqual(
    parseCouncilImages([
      { n: 3, path: '/a/3.png' },
      { n: 1, path: '/a/1.png' },
    ]),
    {
      images: [
        { n: 1, path: '/a/1.png' },
        { n: 3, path: '/a/3.png' },
      ],
    },
  );
  for (const invalid of [
    'x',
    [null],
    [{ n: 0, path: '/a.png' }],
    [{ n: 1.5, path: '/a.png' }],
    [{ n: 1, path: '' }],
    [{ n: 1 }],
  ]) {
    assert.match(parseCouncilImages(invalid).error, /Images jointes invalides/, JSON.stringify(invalid));
  }
  assert.match(
    parseCouncilImages([
      { n: 2, path: '/a.png' },
      { n: 2, path: '/b.png' },
    ]).error,
    /en double : \[Image #2\]/,
  );
  assert.match(
    parseCouncilImages(Array.from({ length: MAX_COUNCIL_IMAGES + 1 }, (_, index) => ({ n: index + 1, path: '/a.png' })))
      .error,
    /10 images jointes au plus/,
  );
  assert.equal(imageToken(4), '[Image #4]');

  const images = [
    { n: 2, path: '/data/attachments/council/b.png' },
    { n: 1, path: '/data/attachments/council/a.png' },
  ];
  const full = finishedRun({ question: 'Que montre [Image #1] ?', context: 'Voir aussi [Image #2].', images });
  assert.deepEqual(imagePaths(full), ['/data/attachments/council/a.png', '/data/attachments/council/b.png']);
  // Les runs antérieurs n'ont pas de champ images.
  assert.deepEqual(imagePaths(finishedRun()), []);
  const [contrarian] = full.advisors;
  for (const prompt of [
    answerPrompt(full, contrarian),
    reviewPrompt(full, contrarian, seeded(1)),
    synthesisPrompt(full),
  ]) {
    assert.match(
      prompt,
      /Les images jointes à ce message sont désignées dans la question et le contexte par \[Image #1\], \[Image #2\], dans l’ordre d’attachement/,
    );
    assert.ok(prompt.indexOf('images jointes') < prompt.indexOf('<question>'));
  }
  const single = answerPrompt(finishedRun({ images: [images[1]] }), contrarian);
  assert.match(
    single,
    /L’image jointe à ce message est désignée .* par \[Image #1\], dans l’ordre d’attachement\. Examine-la/,
  );
  assert.ok(!answerPrompt(finishedRun(), contrarian).includes('jointe'));

  const markdown = exportMarkdown(full);
  const section = markdown.indexOf(
    '## Images jointes\n\n- [Image #1] : /data/attachments/council/a.png\n- [Image #2] : /data/attachments/council/b.png',
  );
  assert.ok(section > markdown.indexOf('## Contexte') && section < markdown.indexOf('## Synthèse'));
  assert.ok(!exportMarkdown(finishedRun()).includes('## Images jointes'));
});

test('export Markdown : synthèse, avis, relectures puis classement', () => {
  const markdown = exportMarkdown(finishedRun());
  const position = (text) => {
    const index = markdown.indexOf(text);
    assert.ok(index >= 0, text);
    return index;
  };
  assert.ok(markdown.startsWith('# Council : Faut-il réécrire le serveur en Rust ?\n'));
  assert.ok(
    markdown.includes(
      '2026-10-22T08:00:00.000Z · statut : succeeded · chairman : claude · opus · effort high · lecture du projet',
    ),
  );
  const order = [
    '## Question',
    '## Contexte',
    '## Synthèse',
    '### Points d’accord',
    'Ne pas tout réécrire.',
    '### Première action',
    'Mesurer les performances.',
    '## Avis',
    '### A — Outsider (codex · modèle par défaut)',
    '### B — Contrarien',
    '### C — Exécutant (grok · modèle par défaut)',
    '_Aucune réponse : Délai dépassé._',
    '### D — Expansionniste',
    '## Relectures',
    '### Relecture par B — Contrarien',
    '1. D : Ambitieux.',
    '### Relecture par A — Outsider',
    '### Relecture par D — Expansionniste',
    '_Relecture échouée : Classement invalide._',
    '## Classement agrégé',
    '| 1 | B | Contrarien | 1 | 1 |',
  ];
  order.reduce((previous, text) => {
    const index = position(text);
    assert.ok(index > previous, `${text} après l’élément précédent`);
    return index;
  }, -1);

  // Run échoué avant la synthèse et sans relecture.
  const failed = exportMarkdown(
    finishedRun({ synthesis: null, reviews: [], error: 'Le chairman a échoué.', context: '', readProject: false }),
  );
  assert.ok(failed.includes('_Aucune synthèse : Le chairman a échoué._'));
  assert.ok(
    !failed.includes('## Contexte') && !failed.includes('## Relectures') && !failed.includes('lecture du projet'),
  );
  assert.ok(failed.includes('| 1 | A | Outsider | — | 0 |'));
});

test('réglages par défaut : toutes les personas cochées, agents en tourniquet', () => {
  const personas = BUILTIN_IDS.map((id) => persona(id));
  const defaults = defaultCouncilSettings(catalog, personas, ['codex', 'grok']);
  assert.deepEqual(defaults.defaultPersonaIds, BUILTIN_IDS);
  assert.deepEqual(
    BUILTIN_IDS.map((id) => defaults.assignments[id].agent),
    ['codex', 'grok', 'codex', 'grok', 'codex'],
  );
  // Défauts calculés : effort explicite (high), modèle sans défaut catalogué pour codex et grok.
  assert.ok(Object.values(defaults.assignments).every((llm) => llm.model === null && llm.effort === 'high'));
  assert.equal(defaults.readProject, true);
  assert.equal(defaults.chairman.agent, 'codex');
  assert.deepEqual(defaultCouncilSettings(catalog, personas, AGENTS).chairman, {
    agent: 'claude',
    model: 'opus',
    effort: 'high',
  });
  assert.ok(
    Object.values(defaultCouncilSettings(catalog, personas, []).assignments).every((llm) => llm.agent === 'claude'),
  );
  // Au-delà de 8 personas, seules les 8 premières sont cochées.
  const many = Array.from({ length: MAX_ADVISORS + 2 }, (_, i) => persona(`p${i}`));
  assert.equal(defaultCouncilSettings(catalog, many, AGENTS).defaultPersonaIds.length, MAX_ADVISORS);
  // Les réglages par défaut passent leur propre validation.
  // Validation : l'effort absent devient explicite (high, proposé par codex et grok).
  const validated = validateCouncilSettings(catalog, defaults, personas, ['codex', 'grok']);
  assert.equal(validated.error, undefined);
  assert.ok(Object.values(validated.settings.assignments).every((llm) => llm.effort === 'high'));
});

test('personas par défaut semées une seule fois, jamais réinsérées après suppression', () => {
  const path = join(root, 'seed.db');
  let db = new CerebroDatabase(path);
  try {
    const personas = db.listPersonas();
    assert.deepEqual(
      personas.map((p) => p.id),
      BUILTIN_IDS,
    );
    assert.deepEqual(
      personas.map((p) => p.name),
      ['Contrarien', 'Premiers principes', 'Expansionniste', 'Outsider', 'Exécutant'],
    );
    for (const p of personas) {
      assert.equal(p.builtin, true);
      assert.ok(p.description.length > 0 && p.description.length <= 300);
      assert.match(p.prompt, /150 à 300 mots/);
      assert.deepEqual(parsePersona(JSON.parse(JSON.stringify(p))), p);
    }
    assert.equal(db.getSetting('personas_seeded'), true);
    assert.equal(db.deletePersona('outsider'), true);
  } finally {
    db.close();
  }
  db = new CerebroDatabase(path);
  try {
    assert.deepEqual(
      db.listPersonas().map((p) => p.id),
      ['contrarian', 'first-principles', 'expansionist', 'executor'],
    );
  } finally {
    db.close();
  }
});

test('migration sur base vide puis réouverture idempotente', () => {
  const path = join(root, 'empty.db');
  let db = new CerebroDatabase(path);
  assert.ok(tables(db).includes('settings'));
  assert.ok(tables(db).includes('council_runs'));
  assert.deepEqual(columns(db, 'personas'), [
    'id',
    'name',
    'description',
    'prompt',
    'builtin',
    'created_at',
    'updated_at',
  ]);
  assert.ok(columns(db, 'projects').includes('council_settings'));
  assert.equal(db.createProject('Neuf', root).councilSettings, null);
  db.close();
  db = new CerebroDatabase(path);
  assert.equal(db.listProjects()[0].councilSettings, null);
  assert.equal(db.listPersonas().length, DEFAULT_PERSONAS.length);
  db.close();
});

test('migration d’une base existante : les projets héritent des réglages globaux', () => {
  const path = join(root, 'legacy.db');
  let db = new CerebroDatabase(path);
  const project = db.createProject('Ancien', root);
  db.close();
  const legacy = new DatabaseSync(path);
  legacy.exec(
    'ALTER TABLE projects DROP COLUMN council_settings; DROP TABLE settings; DROP TABLE council_runs; DROP TABLE personas;',
  );
  legacy.close();

  db = new CerebroDatabase(path);
  try {
    assert.ok(columns(db, 'projects').includes('council_settings'));
    assert.deepEqual(columns(db, 'council_runs'), ['id', 'project_id', 'data']);
    assert.deepEqual(columns(db, 'settings'), ['key', 'data']);
    assert.deepEqual(
      db.listPersonas().map((p) => p.id),
      BUILTIN_IDS,
    );
    const migrated = db.getProject(project.id);
    assert.equal(migrated.councilSettings, null);
    assert.equal(migrated.name, 'Ancien');
  } finally {
    db.close();
  }
});

test('conversion des réglages au format advisors[] (global et projet)', () => {
  const contrarian = DEFAULT_PERSONAS[0];
  const legacyGlobal = {
    advisors: [
      { id: 'a', name: 'Contrarien', persona: `  ${contrarian.prompt} `, agent: 'codex', model: null, effort: null },
      {
        id: 'b',
        name: 'Juriste',
        persona: 'Tu es le juriste du conseil.',
        agent: 'claude',
        model: 'opus',
        effort: 'high',
      },
    ],
    chairman: { agent: 'codex', model: null, effort: null },
    readProject: false,
  };
  const legacyProject = {
    advisors: [
      {
        id: 'x',
        name: 'Juriste bis',
        persona: 'Tu es le juriste du conseil.',
        agent: 'grok',
        model: null,
        effort: null,
      },
      { id: 'y', name: 'Inconnu', persona: 'Persona sans agent valide.', agent: 'gemini' },
    ],
    chairman: { agent: 'gemini' },
  };
  const path = join(root, 'convert.db');
  let db = new CerebroDatabase(path);
  const project = db.createProject('Projet', root);
  const untouched = db.createProject('Sans surcharge', root);
  db.putSetting('council', legacyGlobal);
  db.connection
    .prepare('UPDATE projects SET council_settings = ? WHERE id = ?')
    .run(JSON.stringify(legacyProject), project.id);
  db.close();

  db = new CerebroDatabase(path);
  try {
    const personas = db.listPersonas();
    // Le texte du Contrarien existe déjà : seuls le juriste (une fois) et la persona inconnue sont créés.
    assert.equal(personas.length, BUILTIN_IDS.length + 2);
    const jurist = personas.find((p) => p.name === 'Juriste');
    const unknown = personas.find((p) => p.name === 'Inconnu');
    assert.equal(jurist.prompt, 'Tu es le juriste du conseil.');
    assert.equal(jurist.builtin, false);
    assert.equal(jurist.description, '');

    assert.deepEqual(db.getSetting('council'), {
      assignments: {
        contrarian: { agent: 'codex', model: null, effort: 'high' },
        [jurist.id]: { agent: 'claude', model: 'opus', effort: 'high' },
      },
      defaultPersonaIds: ['contrarian', jurist.id],
      chairman: { agent: 'codex', model: null, effort: 'high' },
      readProject: false,
    });
    assert.deepEqual(db.getProject(project.id).councilSettings, {
      assignments: {
        [jurist.id]: { agent: 'grok', model: null, effort: 'high' },
        [unknown.id]: { agent: 'claude', model: 'opus', effort: 'high' },
      },
      defaultPersonaIds: [jurist.id, unknown.id],
      chairman: { agent: 'claude', model: 'opus', effort: 'high' },
      readProject: true,
    });
    assert.equal(db.getProject(untouched.id).councilSettings, null);
    // Les réglages convertis sont valides.
    assert.ok(validateCouncilSettings(catalog, db.getSetting('council'), personas, AGENTS).settings);
  } finally {
    db.close();
  }
  // Réouverture : rien n'est converti ni créé deux fois.
  db = new CerebroDatabase(path);
  try {
    assert.equal(db.listPersonas().length, BUILTIN_IDS.length + 2);
  } finally {
    db.close();
  }

  // Un seul conseiller : complété jusqu'à deux participants par défaut avec le catalogue.
  const single = convertLegacyCouncilSettings(
    catalog,
    { advisors: [{ name: 'Seul', persona: 'Prompt Seul', agent: 'claude' }] },
    [persona('p1'), persona('p2')],
    7,
  );
  assert.equal(single.created.length, 1);
  assert.deepEqual(single.created[0], {
    ...single.created[0],
    name: 'Seul',
    prompt: 'Prompt Seul',
    createdAt: 7,
    updatedAt: 7,
    builtin: false,
  });
  assert.deepEqual(single.settings.defaultPersonaIds, [single.created[0].id, 'p1']);
});

test('aller-retour des réglages globaux et de la surcharge projet', () => {
  const path = join(root, 'roundtrip.db');
  let db = new CerebroDatabase(path);
  assert.equal(db.getSetting('council'), null);
  db.putSetting('council', defaultCouncilSettings(catalog, db.listPersonas(), AGENTS));
  db.putSetting('council', settings);
  const project = db.createProject('Projet', root);
  assert.deepEqual(db.updateProject(project.id, { councilSettings: settings }).councilSettings, settings);
  // Les autres changements préservent la surcharge.
  db.updateProject(project.id, { name: 'Renommé' });
  db.close();

  db = new CerebroDatabase(path);
  try {
    assert.deepEqual(db.getSetting('council'), settings);
    assert.deepEqual(db.getProject(project.id).councilSettings, settings);
    db.updateProject(project.id, { councilSettings: null });
    assert.equal(db.getProject(project.id).councilSettings, null);
    assert.equal(
      db.connection.prepare('SELECT council_settings FROM projects WHERE id = ?').get(project.id).council_settings,
      null,
    );
  } finally {
    db.close();
  }
});

test('CRUD des personas : la suppression nettoie les réglages globaux et projet', async () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const created = db.createPersona({
      name: 'Juriste',
      description: 'Risques juridiques.',
      prompt: 'Tu es le juriste.',
    });
    assert.equal(created.builtin, false);
    assert.deepEqual(db.getPersona(created.id), created);
    assert.equal(db.listPersonas().at(-1).id, created.id);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = db.updatePersona(created.id, { prompt: 'Tu es la juriste.' });
    assert.equal(updated.prompt, 'Tu es la juriste.');
    assert.equal(updated.name, 'Juriste');
    assert.ok(updated.updatedAt > created.updatedAt);
    assert.deepEqual(db.getPersona(created.id), updated);
    assert.equal(db.updatePersona('absent', { name: 'x' }), null);
    // Une persona fournie reste modifiable et garde son badge.
    assert.equal(db.updatePersona('outsider', { name: 'Naïf' }).builtin, true);

    const project = db.createProject('Projet', root);
    const other = db.createProject('Autre', root);
    db.putSetting('council', {
      ...settings,
      assignments: { ...settings.assignments, [created.id]: { agent: 'grok', model: null, effort: null } },
      defaultPersonaIds: ['outsider', created.id],
    });
    db.updateProject(project.id, { councilSettings: settings });
    assert.equal(db.deletePersona(created.id), true);
    assert.equal(db.deletePersona(created.id), false);
    assert.equal(db.getPersona(created.id), null);
    // Le minimum de deux participants est rétabli avec la première persona du catalogue.
    assert.deepEqual(db.getSetting('council'), { ...settings, defaultPersonaIds: ['outsider', 'contrarian'] });
    assert.equal(db.deletePersona('outsider'), true);
    assert.deepEqual(db.getProject(project.id).councilSettings, {
      ...settings,
      assignments: { contrarian: settings.assignments.contrarian },
      defaultPersonaIds: ['contrarian', 'first-principles'],
    });
    assert.equal(db.getProject(other.id).councilSettings, null);
  } finally {
    db.close();
  }
});

test('runs du council : upsert, filtres par projet et suppression avec le projet', () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Projet', root);
    db.saveCouncilRun(run('old', project.id, 1));
    db.saveCouncilRun(run('new', project.id, 3));
    db.saveCouncilRun(run('home', null, 2));
    db.saveCouncilRun({ ...run('old', project.id, 1), status: 'succeeded', phase: 'finished', finishedAt: 5 });
    assert.equal(db.getCouncilRun('old').status, 'succeeded');
    assert.equal(db.getCouncilRun('absent'), null);
    assert.deepEqual(
      db.listCouncilRuns().map((r) => r.id),
      ['new', 'home', 'old'],
    );
    assert.deepEqual(
      db.listCouncilRuns(project.id).map((r) => r.id),
      ['new', 'old'],
    );
    assert.deepEqual(
      db.listCouncilRuns(null).map((r) => r.id),
      ['home'],
    );
    assert.equal(db.deleteCouncilRun('new'), true);
    assert.equal(db.deleteCouncilRun('new'), false);
    assert.equal(db.deleteProject(project.id), true);
    assert.deepEqual(
      db.listCouncilRuns().map((r) => r.id),
      ['home'],
    );
  } finally {
    db.close();
  }
});

test('runs du council : une sauvegarde tardive ne recrée pas de rapport pour un projet supprimé', () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Projet', root);
    const active = run('late', project.id, 1);
    db.saveCouncilRun(active);
    assert.equal(db.deleteProject(project.id), true);
    db.saveCouncilRun({ ...active, status: 'succeeded', phase: 'finished', finishedAt: 5 });
    db.saveCouncilRun(run('never-started', project.id, 2));
    assert.equal(db.getProject(project.id), null);
    assert.deepEqual(db.listCouncilRuns(), []);

    // Les councils hors projet conservent leur fonctionnement normal.
    db.saveCouncilRun(run('home', null, 3));
    db.saveCouncilRun({ ...run('home', null, 3), status: 'succeeded', phase: 'finished', finishedAt: 6 });
    assert.equal(db.getCouncilRun('home').status, 'succeeded');
  } finally {
    db.close();
  }
});

test('validation des réglages du council', () => {
  const personas = BUILTIN_IDS.map((id) => persona(id));
  const error = (raw, agents = AGENTS) => validateCouncilSettings(catalog, raw, personas, agents).error;

  // Normalisation : champs inconnus ignorés, model/effort absents = null, readProject absent = true.
  assert.deepEqual(
    validateCouncilSettings(
      catalog,
      {
        assignments: { contrarian: { agent: 'codex', extra: 1 } },
        defaultPersonaIds: ['contrarian', 'executor'],
        chairman: { agent: 'codex' },
      },
      personas,
      AGENTS,
    ),
    {
      settings: {
        assignments: { contrarian: { agent: 'codex', model: null, effort: 'high' } },
        defaultPersonaIds: ['contrarian', 'executor'],
        chairman: { agent: 'codex', model: null, effort: 'high' },
        readProject: true,
      },
    },
  );
  assert.deepEqual(validateCouncilSettings(catalog, settings, personas, AGENTS), { settings });

  for (const raw of [
    null,
    [],
    'x',
    { ...settings, assignments: null },
    { ...settings, defaultPersonaIds: 'contrarian' },
    { ...settings, chairman: null },
    { ...settings, readProject: 'oui' },
  ]) {
    assert.ok(error(raw), JSON.stringify(raw));
  }
  // Ancien format refusé.
  assert.ok(error({ advisors: [], chairman: settings.chairman }));
  assert.match(error({ ...settings, defaultPersonaIds: ['contrarian'] }), /2 à 8/);
  const many = Array.from({ length: MAX_ADVISORS + 1 }, (_, i) => persona(`p${i}`));
  assert.match(
    validateCouncilSettings(
      catalog,
      { ...settings, defaultPersonaIds: many.map((p) => p.id) },
      [...personas, ...many],
      AGENTS,
    ).error,
    /2 à 8/,
  );
  assert.match(error({ ...settings, defaultPersonaIds: ['contrarian', 'absent'] }), /inconnu/);
  assert.match(error({ ...settings, defaultPersonaIds: ['contrarian', 'contrarian'] }), /double/);
  assert.match(error({ ...settings, assignments: { absent: { agent: 'claude' } } }), /Persona inconnue/);
  assert.match(error({ ...settings, assignments: { contrarian: 'claude' } }), /contrarian.*invalide/);
  assert.match(error({ ...settings, assignments: { contrarian: { agent: 'gemini' } } }), /agent/);
  // Agent connu mais absent de la liste acceptée (par exemple non installé).
  assert.match(error(settings, ['claude']), /outsider.*agent/);
  assert.match(
    error({ ...settings, assignments: { contrarian: { agent: 'claude', model: 'inconnu' } } }),
    /modèle ou effort/,
  );
  assert.match(error({ ...settings, assignments: { contrarian: { agent: 'claude', model: 42 } } }), /modèle invalide/);
  assert.match(
    error({ ...settings, assignments: { contrarian: { agent: 'claude', effort: 'ultra' } } }),
    /modèle ou effort/,
  );
  assert.match(error({ ...settings, chairman: { agent: 'claude', effort: 'enorme' } }), /Chairman/);
  assert.match(error({ ...settings, chairman: { agent: 'grok' } }, ['claude', 'codex']), /Chairman : agent/);
});

test('résolution des participants d’un run', () => {
  const personas = BUILTIN_IDS.map((id) => persona(id));
  const advisor = (id, llm) => ({ personaId: id, ...llm, name: id, description: '', prompt: `Prompt ${id}` });
  const resolve = (requested, agents) => resolveParticipants(catalog, settings, personas, requested, agents);

  // Sans demande : participants par défaut avec leurs assignations.
  assert.deepEqual(resolve(), {
    advisors: [
      advisor('contrarian', settings.assignments.contrarian),
      advisor('outsider', settings.assignments.outsider),
    ],
  });
  // Demande explicite : surcharge de l'agent, sinon assignation, sinon agent du chairman.
  assert.deepEqual(
    resolve([
      { personaId: 'outsider', agent: 'grok', model: null },
      { personaId: 'contrarian' },
      { personaId: 'executor', agent: null },
    ]),
    {
      advisors: [
        advisor('outsider', { agent: 'grok', model: null, effort: 'high' }),
        advisor('contrarian', settings.assignments.contrarian),
        advisor('executor', { agent: 'claude', model: 'opus', effort: 'high' }),
      ],
    },
  );
  assert.match(resolve([{ personaId: 'contrarian' }]).error, /2 à 8/);
  assert.match(resolve(Array.from({ length: MAX_ADVISORS + 1 }, () => ({ personaId: 'contrarian' }))).error, /2 à 8/);
  assert.match(
    resolve([{ personaId: 'contrarian' }, { personaId: 'contrarian' }]).error,
    /Conseiller 2 : persona en double/,
  );
  assert.match(
    resolve([{ personaId: 'contrarian' }, { personaId: 'absent' }]).error,
    /Conseiller 2 : persona inconnue/,
  );
  assert.match(resolve([{ personaId: 'contrarian' }, 'outsider']).error, /Conseiller 2 : invalide/);
  assert.match(resolve('contrarian').error, /Participants invalides/);
  assert.match(
    resolve([{ personaId: 'contrarian' }, { personaId: 'outsider', agent: 'gemini' }]).error,
    /Conseiller 2 : agent/,
  );
  assert.match(
    resolve([{ personaId: 'contrarian' }, { personaId: 'outsider', agent: 'grok' }], ['claude', 'codex']).error,
    /Conseiller 2 : agent/,
  );
  assert.match(
    resolve([{ personaId: 'contrarian' }, { personaId: 'outsider', agent: 'claude', effort: 'ultra' }]).error,
    /modèle ou effort/,
  );
  // Une persona par défaut supprimée du catalogue est ignorée : il n'en reste qu'une.
  assert.match(
    resolveParticipants(
      catalog,
      settings,
      personas.filter((p) => p.id !== 'outsider'),
    ).error,
    /2 à 8/,
  );
});

test('API : catalogue des personas', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    let response = await send('GET', '/api/personas');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.json().map((p) => p.id),
      BUILTIN_IDS,
    );

    response = await send('POST', '/api/personas', { name: '  Juriste ', prompt: ' Tu es le juriste. ' });
    assert.equal(response.statusCode, 201);
    const created = response.json();
    assert.deepEqual(
      { ...created, id: 'x', createdAt: 0, updatedAt: 0 },
      {
        id: 'x',
        name: 'Juriste',
        description: '',
        prompt: 'Tu es le juriste.',
        builtin: false,
        createdAt: 0,
        updatedAt: 0,
      },
    );
    for (const [payload, pattern] of [
      [{ prompt: 'p' }, /Nom/],
      [{ name: '', prompt: 'p' }, /Nom/],
      [{ name: 'x'.repeat(81), prompt: 'p' }, /Nom/],
      [{ name: 'n' }, /Prompt/],
      [{ name: 'n', prompt: '  ' }, /Prompt/],
      [{ name: 'n', prompt: 'x'.repeat(4001) }, /Prompt/],
      [{ name: 'n', prompt: 'p', description: 'x'.repeat(301) }, /Description/],
      [{ name: 'n', prompt: 'p', description: 3 }, /Description/],
      [['texte'], /Persona invalide/],
    ]) {
      response = await send('POST', '/api/personas', payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.match(response.json().error, pattern);
    }
    response = await send('POST', '/api/personas', {
      name: 'x'.repeat(80),
      description: 'd'.repeat(300),
      prompt: 'p'.repeat(4000),
    });
    assert.equal(response.statusCode, 201);

    response = await send('PATCH', `/api/personas/${created.id}`, { description: ' Risques juridiques. ' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().description, 'Risques juridiques.');
    assert.equal(response.json().prompt, 'Tu es le juriste.');
    response = await send('PATCH', `/api/personas/${created.id}`, {});
    assert.equal(response.statusCode, 400);
    response = await send('PATCH', `/api/personas/${created.id}`, { name: '' });
    assert.equal(response.statusCode, 400);
    response = await send('PATCH', '/api/personas/absent', { name: 'x' });
    assert.equal(response.statusCode, 404);
    assert.ok(response.json().error);

    response = await send('DELETE', '/api/personas/absent');
    assert.equal(response.statusCode, 404);
    const ids = (await send('GET', '/api/personas')).json().map((p) => p.id);
    for (const id of ids.slice(2)) assert.equal((await send('DELETE', `/api/personas/${id}`)).statusCode, 204);
    response = await send('DELETE', `/api/personas/${ids[0]}`);
    assert.equal(response.statusCode, 409);
    assert.match(response.json().error, /au moins 2/);
    assert.deepEqual(
      (await send('GET', '/api/personas')).json().map((p) => p.id),
      ids.slice(0, 2),
    );
  } finally {
    await app.close();
  }
});

test('API : surcharge projet validée, retour au global et lecture côté client', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    const personaIds = (await send('GET', '/api/personas')).json().map((p) => p.id);
    const projectSettings = {
      ...settings,
      assignments: { [personaIds[0]]: { agent: 'claude', model: 'opus', effort: 'high' } },
      defaultPersonaIds: personaIds.slice(0, 2),
    };
    let response = await send('POST', '/api/projects', { name: 'Council', path: root });
    const created = response.json();
    assert.equal(created.councilSettings, null);
    assert.equal(parseProject(created).councilSettings, null);
    const url = `/api/projects/${created.id}`;

    response = await send('PATCH', url, { councilSettings: { ...projectSettings, extra: true } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().councilSettings, projectSettings);
    assert.deepEqual(parseProject(response.json()).councilSettings, projectSettings);

    response = await send('PATCH', url, {
      councilSettings: { ...projectSettings, defaultPersonaIds: [personaIds[0]] },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /2 à 8/);
    response = await send('PATCH', url, {
      councilSettings: { ...projectSettings, assignments: { absent: { agent: 'claude' } } },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /Persona inconnue/);
    response = await send('PATCH', url, { councilSettings: 'global' });
    assert.equal(response.statusCode, 400);
    response = await send('GET', '/api/projects');
    assert.deepEqual(response.json().find((p) => p.id === created.id).councilSettings, projectSettings);

    response = await send('PATCH', url, { councilSettings: null });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().councilSettings, null);
  } finally {
    await app.close();
  }
});

// --- Gestionnaire d'exécution : lanceur headless moqué ---

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Répond selon le schéma demandé ; `fail(kind, options)` fait échouer un appel.
function fakeInvoke(calls, fail = () => false) {
  return async (options) => {
    const kind =
      options.schema === ANSWER_SCHEMA
        ? 'answer'
        : options.schema === REVIEW_SCHEMA
          ? 'review'
          : options.schema === SYNTHESIS_SCHEMA
            ? 'synthesis'
            : 'unknown';
    calls.push({ ...options, kind });
    if (fail(kind, options)) throw new Error(`${options.agent} en échec`);
    if (kind === 'answer') return { answer: `Avis via ${options.agent}` };
    if (kind === 'review') {
      const letters = [...options.prompt.matchAll(/<reponse lettre="([A-H])">/g)].map((match) => match[1]);
      return {
        ranking: letters.map((letter) => ({ letter, reason: 'Solide.' })),
        blindSpot: 'Le coût.',
        missed: 'Les tests.',
      };
    }
    return {
      agreements: 'Accord.',
      disagreements: 'Désaccord.',
      blindSpots: 'Angle mort.',
      recommendation: 'Recommandation finale.',
      firstAction: 'Mesurer.',
    };
  };
}

function councilRuns(db, calls, fail) {
  const runs = new CouncilRuns(db, catalog);
  runs.invoke = fakeInvoke(calls, fail);
  runs.availableAgents = async () => AGENTS;
  const completed = [];
  runs.onComplete = (run) => completed.push(structuredClone(run));
  return { runs, completed };
}

const personaIs = (name) => (kind, options) =>
  kind === 'answer' && options.prompt.startsWith(DEFAULT_PERSONAS.find((p) => p.name === name).prompt);

test('council : succès complet avec participants explicites et lecture du projet', async () => {
  const db = new CerebroDatabase(':memory:');
  try {
    db.putSetting('council', settings);
    const project = db.createProject('Projet', root);
    const calls = [];
    const { runs, completed } = councilRuns(db, calls);
    const input = {
      projectId: project.id,
      origin: 'web',
      question: '  Faut-il découper le serveur ?  ',
      context: 'Deux développeurs.',
      readProject: true,
      participants: [
        { personaId: 'contrarian', agent: 'codex', model: null, effort: null },
        { personaId: 'outsider' },
        { personaId: 'executor', agent: 'grok' },
      ],
    };
    const started = await runs.start(input, uuid(1));
    assert.equal(started.status, 'running');
    assert.equal(started.phase, 'answering');
    assert.equal(started.question, 'Faut-il découper le serveur ?');
    const run = await runs.finished(uuid(1));
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(run.phase, 'finished');
    assert.equal(run.readProject, true);
    assert.deepEqual(
      run.advisors.map((a) => [a.personaId, a.name, a.agent]),
      [
        ['contrarian', 'Contrarien', 'codex'],
        ['outsider', 'Outsider', 'codex'],
        ['executor', 'Exécutant', 'grok'],
      ],
    );
    assert.equal(run.advisors[0].prompt, DEFAULT_PERSONAS[0].prompt);
    assert.deepEqual(Object.values(run.letters).sort(), ['A', 'B', 'C']);
    assert.ok(run.answers.every((a) => a.text?.startsWith('Avis via') && a.error === null && a.finishedAt !== null));
    assert.equal(run.reviews.length, 3);
    assert.ok(run.reviews.every((r) => r.error === null && r.ranking.length === 2 && r.blindSpot === 'Le coût.'));
    assert.equal(run.synthesis.recommendation, 'Recommandation finale.');
    assert.deepEqual(db.getCouncilRun(uuid(1)), run);
    const answers = calls.filter((c) => c.kind === 'answer');
    assert.equal(answers.length, 3);
    assert.ok(answers.every((c) => c.access === 'read-only' && c.cwd === root && c.timeoutMs === ANSWER_TIMEOUT_MS));
    const reviews = calls.filter((c) => c.kind === 'review');
    assert.equal(reviews.length, 3);
    assert.ok(reviews.every((c) => c.access === 'none' && c.cwd === undefined && c.timeoutMs === REVIEW_TIMEOUT_MS));
    const synthesis = calls.filter((c) => c.kind === 'synthesis');
    assert.deepEqual(
      synthesis.map((c) => [c.agent, c.access, c.timeoutMs]),
      [['claude', 'none', SYNTHESIS_TIMEOUT_MS]],
    );
    assert.deepEqual(
      completed.map((r) => r.status),
      ['succeeded'],
    );
    assert.deepEqual(
      runs.list(project.id).map((r) => r.id),
      [uuid(1)],
    );
    // Même requestId : le run existant est rendu, rien n'est relancé.
    assert.deepEqual(await runs.start(input, uuid(1)), run);
    assert.equal(calls.length, 7);
    await assert.rejects(runs.start({ ...input, question: 'Autre' }, uuid(1)), /autre council/);
    await assert.rejects(runs.start(input, 'pas-un-uuid'), /Identifiant/);
    await assert.rejects(runs.start({ ...input, question: '  ' }, uuid(2)), /Question requise/);
    await assert.rejects(runs.start({ ...input, participants: [{ personaId: 'contrarian' }] }, uuid(3)), /2 à 8/);
    await assert.rejects(runs.start({ ...input, projectId: 'absent' }, uuid(4)), (error) => error.statusCode === 404);
    assert.throws(() => runs.cancel(uuid(1)), /déjà terminé/);
  } finally {
    db.close();
  }
});

test('council : participants par défaut, surcharge projet et run hors projet sans outils', async () => {
  const db = new CerebroDatabase(':memory:');
  try {
    db.putSetting('council', settings);
    const project = db.createProject('Projet', root);
    db.updateProject(project.id, {
      councilSettings: {
        ...settings,
        defaultPersonaIds: ['expansionist', 'executor', 'outsider'],
        readProject: true,
        chairman: { agent: 'grok', model: null, effort: null },
      },
    });
    const calls = [];
    const { runs } = councilRuns(db, calls);
    await runs.start({ projectId: project.id, origin: 'web', question: 'Q ?' }, uuid(10));
    let run = await runs.finished(uuid(10));
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(run.readProject, true);
    // Personas sans assignation : agent du chairman.
    assert.deepEqual(
      run.advisors.map((a) => [a.personaId, a.agent]),
      [
        ['expansionist', 'grok'],
        ['executor', 'grok'],
        ['outsider', 'codex'],
      ],
    );
    assert.equal(run.settings.chairman.agent, 'grok');
    assert.equal(calls.find((c) => c.kind === 'synthesis').agent, 'grok');

    calls.length = 0;
    await runs.start({ projectId: null, origin: 'slack', question: 'Q ?', readProject: true }, uuid(11));
    run = await runs.finished(uuid(11));
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(run.projectId, null);
    assert.equal(run.origin, 'slack');
    assert.equal(run.readProject, false);
    assert.deepEqual(
      run.advisors.map((a) => [a.personaId, a.agent, a.model]),
      [
        ['contrarian', 'claude', 'opus'],
        ['outsider', 'codex', null],
      ],
    );
    assert.ok(calls.every((c) => c.access === 'none' && c.cwd === undefined));
    assert.deepEqual(
      runs.list(null).map((r) => r.id),
      [uuid(11)],
    );

    // Sans réglages enregistrés : défauts calculés sur les personas du catalogue.
    db.connection.prepare("DELETE FROM settings WHERE key = 'council'").run();
    await runs.start({ projectId: null, origin: 'web', question: 'Q ?' }, uuid(12));
    run = await runs.finished(uuid(12));
    assert.deepEqual(
      run.advisors.map((a) => [a.personaId, a.agent]),
      BUILTIN_IDS.map((id, index) => [id, AGENTS[index % AGENTS.length]]),
    );
    assert.equal(run.status, 'succeeded', run.error);
  } finally {
    db.close();
  }
});

test('council : un conseiller en échec est toléré, une synthèse en échec garde les avis', async () => {
  const db = new CerebroDatabase(':memory:');
  try {
    db.putSetting('council', { ...settings, defaultPersonaIds: ['contrarian', 'outsider', 'executor'] });
    const calls = [];
    const { runs } = councilRuns(db, calls, personaIs('Outsider'));
    await runs.start({ projectId: null, origin: 'web', question: 'Q ?' }, uuid(20));
    let run = await runs.finished(uuid(20));
    assert.equal(run.status, 'succeeded', run.error);
    const failed = run.answers.find((a) => a.advisorId === 'outsider');
    assert.equal(failed.text, null);
    assert.match(failed.error, /codex en échec/);
    assert.deepEqual(
      run.reviews.map((r) => r.advisorId),
      ['contrarian', 'executor'],
    );
    assert.ok(run.reviews.every((r) => r.ranking.length === 1));

    const { runs: chairless, completed } = councilRuns(db, [], (kind) => kind === 'synthesis');
    await chairless.start({ projectId: null, origin: 'web', question: 'Q ?' }, uuid(21));
    run = await chairless.finished(uuid(21));
    assert.equal(run.status, 'failed');
    assert.match(run.error, /^Synthèse impossible : claude en échec/);
    assert.equal(run.synthesis, null);
    assert.equal(run.answers.filter((a) => a.text !== null).length, 3);
    assert.equal(run.reviews.length, 3);
    assert.deepEqual(
      completed.map((r) => r.status),
      ['failed'],
    );
  } finally {
    db.close();
  }
});

test('council : moins de deux réponses fait échouer le run avant la relecture', async () => {
  const db = new CerebroDatabase(':memory:');
  try {
    db.putSetting('council', settings);
    const calls = [];
    const { runs, completed } = councilRuns(db, calls, personaIs('Outsider'));
    await runs.start({ projectId: null, origin: 'web', question: 'Q ?' }, uuid(30));
    const run = await runs.finished(uuid(30));
    assert.equal(run.status, 'failed');
    assert.equal(run.phase, 'finished');
    assert.match(run.error, /1 réponse obtenue : il en faut au moins 2/);
    assert.deepEqual(run.reviews, []);
    assert.equal(run.synthesis, null);
    assert.deepEqual(
      calls.map((c) => c.kind),
      ['answer', 'answer'],
    );
    assert.equal(completed.length, 1);
  } finally {
    db.close();
  }
});

test('council : annulation pendant les réponses', async () => {
  const db = new CerebroDatabase(':memory:');
  try {
    db.putSetting('council', settings);
    const calls = [];
    const { runs, completed } = councilRuns(db, calls);
    runs.invoke = (options) => {
      calls.push(options);
      return new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('Exécution annulée.')), { once: true }),
      );
    };
    await runs.start({ projectId: null, origin: 'web', question: 'Q ?' }, uuid(40));
    while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(runs.cancel(uuid(40)).id, uuid(40));
    const run = await runs.finished(uuid(40));
    assert.equal(run.status, 'cancelled');
    assert.equal(run.phase, 'finished');
    assert.equal(run.error, 'Council annulé.');
    assert.ok(run.answers.every((a) => a.text === null && a.error === 'Exécution annulée.'));
    assert.equal(calls.length, 2);
    assert.deepEqual(
      completed.map((r) => r.status),
      ['cancelled'],
    );
    assert.throws(() => runs.cancel(uuid(40)), /déjà terminé/);
    assert.throws(
      () => runs.cancel(uuid(41)),
      (error) => error.statusCode === 404,
    );
  } finally {
    db.close();
  }
});

test('council : supprimer un projet annule et attend ses appels dans chaque phase', async (t) => {
  for (const [phase, schema] of [
    ['answering', ANSWER_SCHEMA],
    ['reviewing', REVIEW_SCHEMA],
    ['synthesizing', SYNTHESIS_SCHEMA],
  ]) {
    await t.test(phase, async () => {
      const db = new CerebroDatabase(':memory:');
      db.putSetting('council', settings);
      const project = db.createProject('À supprimer', root);
      const other = db.createProject('À conserver', root);
      const session = db.createSession(
        {
          id: uuid(60),
          projectId: project.id,
          agent: 'codex',
          mode: 'default',
          model: null,
          effort: null,
          prompt: '',
          title: 'Conversation',
          status: 'exited',
          agentSessionId: null,
        },
        'test-token',
      );
      const calls = [];
      const { runs, completed } = councilRuns(db, calls);
      const manager = new SessionManager(db, createServices(db));
      manager.withProjectDeletion = (id, remove) => runs.withProjectDeletion(id, remove);
      const reached = Promise.withResolvers();
      const releaseCalls = Promise.withResolvers();
      const stoppingSession = Promise.withResolvers();
      const releaseSession = Promise.withResolvers();
      t.mock.method(manager, 'stopProcesses', async () => {
        stoppingSession.resolve();
        await releaseSession.promise;
      });
      const respond = fakeInvoke(calls);
      let targetSignal;
      runs.invoke = async (options) => {
        targetSignal ??= options.signal;
        if (options.signal === targetSignal && options.schema === schema) {
          reached.resolve();
          // Simule le délai de fermeture du processus après l'annulation, puis une réponse tardive.
          await releaseCalls.promise;
        }
        return respond(options);
      };
      let deletion;
      try {
        await runs.start({ projectId: project.id, origin: 'web', question: 'À supprimer ?' }, uuid(61));
        await reached.promise;
        assert.equal(runs.get(uuid(61)).phase, phase);
        manager.setProtected(session.id, true);
        await assert.rejects(manager.deleteProject(project.id), /protégées/);
        assert.equal(targetSignal.aborted, false);
        manager.setProtected(session.id, false);

        let deleted = false;
        deletion = manager.deleteProject(project.id).then((result) => {
          deleted = true;
          return result;
        });
        assert.equal(targetSignal.aborted, true);
        assert.equal(deleted, false);
        assert.ok(db.getProject(project.id));
        assert.ok(db.getCouncilRun(uuid(61)));
        await assert.rejects(
          runs.start({ projectId: project.id, origin: 'slack', question: 'Trop tard ?' }, uuid(62)),
          (error) => error.statusCode === 409,
        );

        // Les autres projets et les councils sans projet restent utilisables.
        await runs.start({ projectId: other.id, origin: 'web', question: 'À conserver ?' }, uuid(63));
        await runs.start({ projectId: null, origin: 'web', question: 'Hors projet ?' }, uuid(64));
        assert.equal((await runs.finished(uuid(63))).status, 'succeeded');
        assert.equal((await runs.finished(uuid(64))).status, 'succeeded');

        releaseCalls.resolve();
        await stoppingSession.promise;
        const cancelled = runs.get(uuid(61));
        assert.equal(cancelled.status, 'cancelled');
        assert.equal(cancelled.phase, 'finished');
        assert.equal(cancelled.synthesis, null);
        const targetCalls = calls.filter((call) => call.signal === targetSignal).length;
        // Le verrou persiste après la fin des councils, pendant l'arrêt des sessions.
        await assert.rejects(
          runs.start({ projectId: project.id, origin: 'web', question: 'Encore trop tôt ?' }, uuid(65)),
          (error) => error.statusCode === 409,
        );
        assert.equal(deleted, false);
        releaseSession.resolve();
        assert.equal(await deletion, true);
        assert.equal(db.getProject(project.id), null);
        assert.equal(db.getSession(session.id), null);
        assert.equal(runs.get(uuid(61)), null);
        assert.deepEqual(runs.list(project.id), []);
        assert.equal(calls.filter((call) => call.signal === targetSignal).length, targetCalls);
        assert.equal(completed.find((run) => run.id === uuid(61)).status, 'cancelled');
        assert.equal(runs.get(uuid(63)).status, 'succeeded');
        assert.equal(runs.get(uuid(64)).status, 'succeeded');
        await assert.rejects(
          runs.start({ projectId: project.id, origin: 'web', question: 'Projet disparu ?' }, uuid(66)),
          (error) => error.statusCode === 404,
        );
      } finally {
        releaseCalls.resolve();
        releaseSession.resolve();
        await deletion?.catch(() => {});
        await runs.shutdown();
        db.close();
      }
    });
  }
});

test('council : un lancement en attente des réglages ne survit pas à la suppression du projet', async () => {
  const db = new CerebroDatabase(':memory:');
  const project = db.createProject('Projet', root);
  const calls = [];
  const { runs } = councilRuns(db, calls);
  const settingsRead = Promise.withResolvers();
  const releaseSettings = Promise.withResolvers();
  runs.settingsFor = async () => {
    settingsRead.resolve();
    await releaseSettings.promise;
    return settings;
  };
  try {
    const pending = runs.start({ projectId: project.id, origin: 'slack', question: 'Q ?' }, uuid(70));
    const rejected = assert.rejects(pending, (error) => error.statusCode === 404);
    await settingsRead.promise;
    await runs.withProjectDeletion(project.id, async () => {
      db.deleteProject(project.id);
    });
    releaseSettings.resolve();
    await rejected;
    assert.equal(calls.length, 0);
    assert.equal(runs.get(uuid(70)), null);
  } finally {
    releaseSettings.resolve();
    await runs.shutdown();
    db.close();
  }
});

test('council : lancements concurrents de même identifiant mais de question ou projet différents', async () => {
  const db = new CerebroDatabase(':memory:');
  db.putSetting('council', settings);
  const first = db.createProject('Projet', root);
  const second = db.createProject('Autre projet', root);
  const calls = [];
  const { runs } = councilRuns(db, calls);
  const original = runs.settingsFor;
  // Les deux lancements franchissent le premier contrôle avant qu'aucun run n'existe.
  let waiting = 0;
  let bothWaiting;
  runs.settingsFor = async (project) => {
    if (++waiting === 2) bothWaiting.resolve();
    await bothWaiting.promise;
    return original.call(runs, project);
  };
  try {
    for (const [index, other] of [
      [80, { projectId: first.id, origin: 'web', question: 'Autre question' }],
      [81, { projectId: second.id, origin: 'web', question: 'Première question' }],
    ]) {
      waiting = 0;
      bothWaiting = Promise.withResolvers();
      const results = await Promise.allSettled([
        runs.start({ projectId: first.id, origin: 'web', question: 'Première question' }, uuid(index)),
        runs.start(other, uuid(index)),
      ]);
      assert.equal(results[0].status, 'fulfilled', results[0].reason?.message);
      assert.equal(results[0].value.question, 'Première question');
      assert.equal(results[1].status, 'rejected');
      assert.equal(results[1].reason.statusCode, 409);
      assert.match(results[1].reason.message, /autre council/);
      const run = await runs.finished(uuid(index));
      assert.equal(run.projectId, first.id);
      assert.equal(run.question, 'Première question');
    }
    assert.deepEqual(
      runs
        .list(first.id)
        .map((r) => r.id)
        .sort(),
      [uuid(80), uuid(81)],
    );
    assert.deepEqual(runs.list(second.id), []);
  } finally {
    await runs.shutdown();
    db.close();
  }
});

test('council : un échec de suppression libère le verrou du projet', async () => {
  const db = new CerebroDatabase(':memory:');
  const { runs } = councilRuns(db, []);
  try {
    db.putSetting('council', settings);
    const project = db.createProject('Projet', root);
    await assert.rejects(
      runs.withProjectDeletion(project.id, async () => {
        throw new Error('Arrêt de session impossible.');
      }),
      /Arrêt de session impossible/,
    );
    await runs.start({ projectId: project.id, origin: 'web', question: 'Q ?' }, uuid(71));
    assert.equal((await runs.finished(uuid(71))).status, 'succeeded');
  } finally {
    await runs.shutdown();
    db.close();
  }
});

test('council : runs en cours passés à interrupted après redémarrage, arrêt du serveur', async () => {
  const path = join(root, 'council-restart.db');
  let db = new CerebroDatabase(path);
  db.saveCouncilRun({
    ...run('restart', null, 1),
    answers: [
      { advisorId: 'contrarian', text: 'Avis.', error: null, startedAt: 1, finishedAt: 2 },
      { advisorId: 'outsider', text: null, error: null, startedAt: 1, finishedAt: null },
    ],
  });
  db.saveCouncilRun({ ...run('done', null, 2), status: 'succeeded', phase: 'finished', finishedAt: 3 });
  db.close();
  db = new CerebroDatabase(path);
  try {
    db.putSetting('council', settings);
    const calls = [];
    const { runs } = councilRuns(db, calls);
    const restarted = runs.get('restart');
    assert.equal(restarted.status, 'interrupted');
    assert.equal(restarted.phase, 'finished');
    assert.ok(restarted.finishedAt >= 1);
    assert.match(restarted.error, /Serveur redémarré/);
    assert.equal(restarted.answers[0].text, 'Avis.');
    assert.match(restarted.answers[1].error, /Interrompu/);
    assert.equal(runs.get('done').status, 'succeeded');

    runs.invoke = (options) => {
      calls.push(options);
      return new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('Exécution annulée.')), { once: true }),
      );
    };
    await runs.start({ projectId: null, origin: 'web', question: 'Q ?' }, uuid(50));
    while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    await runs.shutdown();
    assert.equal(runs.get(uuid(50)).status, 'interrupted');
    await assert.rejects(runs.start({ projectId: null, origin: 'web', question: 'Q ?' }, uuid(51)), /arrêt/);
  } finally {
    db.close();
  }
});
