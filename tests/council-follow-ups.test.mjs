import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

// Aucun agent ni transcript réel : HOME, données Cerebro et dossiers des CLI sont temporaires.
const root = mkdtempSync(join(tmpdir(), 'cerebro-council-follow-ups-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
process.env.GROK_HOME = join(root, 'grok');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
mkdirSync(process.env.CEREBRO_DATA_DIR);

const { CerebroDatabase } = await import('../server/db.ts');
const { councilSessionPrompt, exportMarkdown } = await import('../server/council.ts');
const { findTranscript, parseTranscript, transcriptContext } = await import('../server/transcripts.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { PeerSync } = await import('../server/peers.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { buildServer } = await import('../server/index.ts');
const { ATTACHMENTS_DIR } = await import('../server/config.ts');
mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});
const launches = [];
mock.method(SessionManager.prototype, 'launch', async (project, options) => {
  launches.push({ project, options });
  return db.createSession(
    {
      id: randomUUID(),
      projectId: project.id,
      agent: options.agent,
      mode: options.mode,
      ...options.tuning,
      prompt: options.prompt,
      title: options.title ?? 'Session de test',
      status: 'idle',
      agentSessionId: null,
    },
    'token',
  );
});

const repo = join(root, 'repo');
mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
const db = new CerebroDatabase();
const project = db.createProject('Suites', repo);
after(() => {
  mock.restoreAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

function council(overrides = {}) {
  const advisor = (personaId, name, llm) => ({
    personaId,
    ...llm,
    name,
    description: `Angle ${name}`,
    prompt: `Tu es ${name}.`,
  });
  return {
    id: randomUUID(),
    projectId: project.id,
    origin: 'web',
    question: 'Faut-il réécrire le serveur en Rust ?\nDétail de la question.',
    context: 'Équipe de deux personnes.',
    images: [],
    readProject: true,
    settings: {
      assignments: {},
      defaultPersonaIds: ['contrarian', 'outsider'],
      chairman: { agent: 'claude', model: 'opus', effort: 'high' },
      readProject: true,
    },
    advisors: [
      advisor('contrarian', 'Contrarien', { agent: 'claude', model: 'opus', effort: 'high' }),
      advisor('outsider', 'Outsider', { agent: 'codex', model: null, effort: null }),
    ],
    status: 'succeeded',
    phase: 'finished',
    letters: { contrarian: 'B', outsider: 'A' },
    answers: [
      { advisorId: 'contrarian', text: 'Réponse du contrarien.', error: null, startedAt: 1, finishedAt: 2 },
      { advisorId: 'outsider', text: 'Réponse de l’outsider.', error: null, startedAt: 1, finishedAt: 2 },
    ],
    reviews: [
      {
        advisorId: 'contrarian',
        ranking: [{ letter: 'A', reason: 'Naïf.' }],
        blindSpot: 'Le coût.',
        missed: 'Les tests.',
        error: null,
        startedAt: 3,
        finishedAt: 4,
      },
    ],
    synthesis: {
      agreements: 'Ne pas tout réécrire.',
      disagreements: 'Le calendrier.',
      blindSpots: 'La formation.',
      recommendation: 'Réécrire le module critique seulement.',
      firstAction: 'Mesurer les performances.',
    },
    error: null,
    startedAt: Date.UTC(2026, 9, 22, 8),
    finishedAt: Date.UTC(2026, 9, 22, 9),
    ...overrides,
  };
}

test('prompt de reprise d’un council : déroulé, protagonistes, compte-rendu complet puis consigne', () => {
  const run = council();
  const prompt = councilSessionPrompt(run, '  Commence par la première action.  ');
  const position = (text) => {
    const index = prompt.indexOf(text);
    assert.ok(index >= 0, text);
    return index;
  };
  assert.match(prompt, /^Tu prends la suite d’un council Cerebro/);
  // Protagonistes dans l'ordre des lettres, avec leur angle et leur LLM, puis le chairman.
  assert.ok(
    position('- Conseiller A — Outsider (codex · modèle par défaut) : Angle Outsider') <
      position('- Conseiller B — Contrarien (claude · opus · effort high) : Angle Contrarien'),
  );
  assert.ok(position('- Chairman (claude · opus · effort high)') > position('- Conseiller B'));
  assert.match(prompt, /lire le dépôt du projet/);
  // Le compte-rendu est l'export Markdown complet : question, contexte, synthèse, avis, relectures.
  assert.ok(prompt.includes(`<compte_rendu>\n${exportMarkdown(run).trim()}\n</compte_rendu>`));
  for (const text of ['Équipe de deux personnes.', 'Réponse du contrarien.', 'Le coût.', 'Mesurer les performances.'])
    position(text);
  assert.ok(position('## Consigne de l’utilisateur') > position('</compte_rendu>'));
  assert.ok(prompt.endsWith('## Consigne de l’utilisateur\n\nCommence par la première action.'));

  // Sans consigne : la session résume et attend.
  const idle = councilSessionPrompt(run, '   ');
  assert.ok(!idle.includes('## Consigne'));
  assert.match(idle, /attends la consigne de l’utilisateur\.$/);

  // Compte-rendu dans un fichier : question et synthèse restent, pas les avis.
  const short = councilSessionPrompt(run, 'Suite.', '/data/compte-rendu.md');
  assert.ok(short.includes('/data/compte-rendu.md'));
  assert.ok(!short.includes('<compte_rendu>'));
  assert.ok(!short.includes('Réponse du contrarien.'));
  assert.ok(short.includes('<question>\nFaut-il réécrire le serveur en Rust ?'));
  assert.ok(short.includes('### Recommandation\n\nRéécrire le module critique seulement.'));
  assert.match(
    councilSessionPrompt(council({ synthesis: null, status: 'failed', error: 'Chairman muet.' }), '', '/f.md'),
    /Aucune synthèse : Chairman muet\./,
  );
});

test('POST /api/councils/:id/session : la session reçoit le compte-rendu et la consigne avec le LLM choisi', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    const run = council();
    db.saveCouncilRun(run);
    const launch = { agent: 'codex', mode: 'plan', model: null, effort: 'high', prompt: 'Approfondis le désaccord.' };
    let response = await send('POST', `/api/councils/${run.id}/session`, { launch });
    assert.equal(response.statusCode, 201, response.body);
    const session = response.json();
    assert.equal(session.projectId, project.id);
    assert.equal(session.title, 'Council · Faut-il réécrire le serveur en Rust ?');
    const { options } = launches.at(-1);
    assert.equal(options.agent, 'codex');
    assert.equal(options.mode, 'plan');
    assert.equal(options.tuning.effort, 'high');
    assert.equal(options.prompt, councilSessionPrompt(run, launch.prompt));
    // Le choix du LLM est mémorisé pour le projet, pas le prompt généré.
    const remembered = db.getProject(project.id).sessionDefaults;
    assert.equal(remembered.agent, 'codex');
    assert.ok(!remembered.prompt.includes('council'));

    // Council hors projet : le projet de la session est requis.
    const outside = council({ projectId: null });
    db.saveCouncilRun(outside);
    response = await send('POST', `/api/councils/${outside.id}/session`, { launch });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /projet/);
    response = await send('POST', `/api/councils/${outside.id}/session`, { projectId: project.id, launch });
    assert.equal(response.statusCode, 201, response.body);

    // Compte-rendu trop long pour un argument de commande : il passe par un fichier du projet.
    const long = council({ context: 'x'.repeat(150_000) });
    db.saveCouncilRun(long);
    response = await send('POST', `/api/councils/${long.id}/session`, { launch });
    assert.equal(response.statusCode, 201, response.body);
    const path = join(ATTACHMENTS_DIR, `project-${project.id}`, `council-${long.id}`, 'compte-rendu.md');
    assert.equal(readFileSync(path, 'utf8'), exportMarkdown(long));
    const prompt = launches.at(-1).options.prompt;
    assert.ok(prompt.includes(path));
    assert.ok(Buffer.byteLength(prompt) < 20_000);

    // Council en cours ou inconnu : refusé.
    const running = council({ status: 'running', phase: 'answering', finishedAt: null, synthesis: null });
    db.saveCouncilRun(running);
    assert.equal((await send('POST', `/api/councils/${running.id}/session`, { launch })).statusCode, 409);
    assert.equal((await send('POST', '/api/councils/inconnu/session', { launch })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('transcripts : seuls les échanges lisibles de l’utilisateur et de l’agent sont repris', () => {
  const claude = parseTranscript(
    'claude',
    jsonl([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Première demande' } },
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Première demande' } },
      { type: 'user', uuid: 'm', isMeta: true, message: { role: 'user', content: 'Caveat: méta' } },
      { type: 'user', uuid: 'c', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] } },
      {
        type: 'assistant',
        uuid: 'a2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Je regarde.' }] },
      },
      {
        type: 'assistant',
        uuid: 'a3',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
      },
      {
        type: 'user',
        uuid: 'r',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'sortie' }] },
      },
      { type: 'assistant', uuid: 'a4', message: { role: 'assistant', content: [{ type: 'text', text: 'Voilà.' }] } },
      { type: 'assistant', uuid: 's', isSidechain: true, message: { role: 'assistant', content: 'sous-agent' } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'text', text: 'Merci' }] } },
      'ligne invalide',
    ]),
  );
  assert.deepEqual(claude, [
    { role: 'user', text: 'Première demande' },
    { role: 'assistant', text: 'Je regarde.\n\nVoilà.' },
    { role: 'user', text: 'Merci' },
  ]);

  const item = (type, text) => ({
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type, content: [{ type: 'text', text }] } },
  });
  assert.deepEqual(
    parseTranscript(
      'codex',
      jsonl([
        {
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md' }] },
        },
        item('UserMessage', 'Demande codex'),
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution' } } },
        {
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Fait.' }] },
          },
        },
        // Les deux formats coexistent parfois : les éléments priment.
        { type: 'event_msg', payload: { type: 'user_message', message: 'Demande codex' } },
      ]),
    ),
    [
      { role: 'user', text: 'Demande codex' },
      { role: 'assistant', text: 'Fait.' },
    ],
  );
  assert.deepEqual(
    parseTranscript(
      'codex',
      jsonl([
        { type: 'event_msg', payload: { type: 'user_message', message: 'Ancienne demande' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'Ancienne réponse' } },
      ]),
    ),
    [
      { role: 'user', text: 'Ancienne demande' },
      { role: 'assistant', text: 'Ancienne réponse' },
    ],
  );
  assert.deepEqual(
    parseTranscript(
      'grok',
      jsonl([
        { type: 'system', content: 'You are Grok.' },
        { type: 'user', content: [{ type: 'text', text: '<user_info>…</user_info>' }] },
        {
          type: 'user',
          content: [{ type: 'text', text: '<user_query>\nDemande grok\n</user_query>' }],
          prompt_index: 0,
        },
        { type: 'reasoning', summary: [] },
        { type: 'assistant', content: 'Je lis.', tool_calls: [] },
        { type: 'tool_result', content: 'sortie' },
        { type: 'assistant', content: 'Terminé.' },
      ]),
    ),
    [
      { role: 'user', text: 'Demande grok' },
      { role: 'assistant', text: 'Je lis.\n\nTerminé.' },
    ],
  );
});

test('transcripts : fichier de chaque CLI retrouvé par l’identifiant de conversation', async () => {
  const claudeDir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-repo');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'c1.jsonl'), '');
  const codexDir = join(process.env.CODEX_HOME, 'sessions', '2026', '10', '22');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, 'rollout-2026-10-22T08-00-00-x1.jsonl'), '');
  const grokDir = join(process.env.GROK_HOME, 'sessions', '%2Frepo', 'g1');
  mkdirSync(grokDir, { recursive: true });
  writeFileSync(join(grokDir, 'chat_history.jsonl'), '');
  assert.equal(await findTranscript('claude', 'c1'), join(claudeDir, 'c1.jsonl'));
  assert.equal(await findTranscript('codex', 'x1'), join(codexDir, 'rollout-2026-10-22T08-00-00-x1.jsonl'));
  assert.equal(await findTranscript('grok', 'g1'), join(grokDir, 'chat_history.jsonl'));
  assert.equal(await findTranscript('claude', 'absent'), null);
  assert.ok(existsSync(join(grokDir, 'chat_history.jsonl')));
});

test('contexte de council tiré d’une session : demande initiale gardée, derniers échanges, milieu omis', () => {
  const session = { title: 'Ma session', agent: 'claude', model: 'opus', prompt: 'Demande initiale' };
  const messages = [
    { role: 'user', text: 'Demande initiale' },
    ...Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'assistant' : 'user',
      text: `Message ${index} ${'x'.repeat(200)}`,
    })),
  ];
  const full = transcriptContext(session, messages, 100_000);
  assert.equal(full.truncated, false);
  assert.equal(full.complete, true);
  assert.match(full.text, /^Conversation de la session Cerebro « Ma session » \(claude · opus\)/);
  assert.ok(full.text.includes('### Utilisateur\n\nDemande initiale'));
  assert.ok(full.text.includes('### Agent (claude · opus)\n\nMessage 0'));

  const short = transcriptContext(session, messages, 1500);
  assert.equal(short.truncated, true);
  assert.ok(short.text.length <= 1500, String(short.text.length));
  assert.ok(short.text.includes('Demande initiale'));
  assert.ok(short.text.includes('Message 19'));
  assert.ok(!short.text.includes('Message 0 '));
  assert.match(short.text, /messages intermédiaires omis/);

  // Transcript introuvable : seule la demande initiale de la session.
  const fallback = transcriptContext(session, null, 100_000);
  assert.equal(fallback.complete, false);
  assert.match(fallback.text, /Transcript de la conversation introuvable/);
  assert.ok(fallback.text.endsWith('### Utilisateur\n\nDemande initiale'));
});

test('GET /api/sessions/:id/transcript : conversation mise en forme pour un council', async () => {
  const agentSessionId = randomUUID();
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${agentSessionId}.jsonl`),
    jsonl([
      { type: 'user', message: { role: 'user', content: 'Analyse ce module' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Il est fragile.' }] } },
    ]),
  );
  const session = db.createSession(
    {
      id: randomUUID(),
      projectId: project.id,
      agent: 'claude',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: 'Analyse ce module',
      title: 'Analyse',
      status: 'exited',
      agentSessionId,
    },
    'token',
  );
  const app = await buildServer();
  try {
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/transcript` });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.complete, true);
    assert.equal(body.truncated, false);
    assert.ok(body.text.includes('### Utilisateur\n\nAnalyse ce module\n\n### Agent (claude)\n\nIl est fragile.'));
    assert.equal((await app.inject({ method: 'GET', url: '/api/sessions/inconnue/transcript' })).statusCode, 404);
  } finally {
    await app.close();
  }
});
