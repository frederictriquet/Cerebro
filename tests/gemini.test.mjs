import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

// Gemini passe par la CLI agy (Antigravity). Aucun agent ni dossier personnel réel : tout vit dans un dossier temporaire.
const root = mkdtempSync(join(tmpdir(), 'cerebro-gemini-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
mkdirSync(process.env.CEREBRO_DATA_DIR);

const { buildAgentCommand, getGeminiHookSettings, workspaceArgs } = await import('../server/agents.ts');
const { parseGeminiModels } = await import('../server/catalog.ts');
const { CerebroDatabase } = await import('../server/db.ts');
const { geminiFinalAnswer, handleHook, installGeminiHook } = await import('../server/hooks.ts');
const { runHeadless } = await import('../server/headless.ts');
const { parseDmCommand } = await import('../server/slack-format.ts');
const { TokenAccumulator } = await import('../server/token-usage.ts');
const { parseTranscript } = await import('../server/transcripts.ts');
const { parseGeminiUsage } = await import('../server/usage.ts');
const { AGENT_COMMAND, isAgent } = await import('../shared/types.ts');

after(() => rmSync(root, { recursive: true, force: true }));

// Sortie réelle de `agy models` (1.5.8), abrégée.
const MODELS = [
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
  'gemini-pro-orchestrator\tOrchestrator (Carbon)',
  'gemini-pro-orchestrator-argon\tOrchestrator (Argon)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  '',
].join('\n');

test('agent gemini : lancé par la commande agy et reconnu partout où un agent est nommé', () => {
  assert.equal(AGENT_COMMAND.gemini, 'agy');
  assert.ok(isAgent('gemini'));
  assert.equal(parseDmCommand('cerebro/gemini: corrige le test')?.agent, 'gemini');
});

test('catalogue agy : une entrée par modèle, ses variantes devenant ses efforts', () => {
  const catalog = parseGeminiModels(MODELS, 'Gemini 4 Argon (Medium)');
  assert.deepEqual(
    catalog.models.map((m) => [m.value, m.label, m.efforts]),
    [
      ['gemini-4-argon', 'Gemini 4 Argon', ['low', 'medium', 'high']],
      ['gemini-4-hydrogen', 'Gemini 4 Hydrogen', ['xhigh']],
      ['gemini-pro-orchestrator', 'Orchestrator (Carbon)', []],
      ['gemini-pro-orchestrator-argon', 'Orchestrator (Argon)', []],
      ['claude-opus-5-5', 'Claude Opus 5.5', ['low', 'high']],
      ['gpt-oss-120b', 'GPT-OSS 120B', ['medium']],
    ],
  );
  assert.equal(catalog.defaultModel, 'gemini-4-argon');
  assert.deepEqual(catalog.efforts, ['low', 'medium', 'high']);
  // Modèle réglé inconnu ou absent : le premier listé.
  assert.equal(parseGeminiModels(MODELS, 'Disparu (High)').defaultModel, 'gemini-4-argon');
  assert.throws(() => parseGeminiModels('Fetching available models...\n', null), /aucun modèle/);
});

test('commande agy : prompt initial, reprise par identifiant de conversation, modes et réglages', () => {
  const tuning = { model: 'gemini-4-argon', effort: 'high' };
  const fresh = buildAgentCommand('gemini', 'acceptEdits', 'Corrige le test', 'cerebro-id', null, tuning);
  assert.equal(fresh.cmd, 'agy');
  // agy choisit l'identifiant de conversation : le hook SessionStart le transmet.
  assert.equal(fresh.agentSessionId, null);
  assert.deepEqual(fresh.args, [
    '--mode',
    'accept-edits',
    '--model',
    'gemini-4-argon',
    '--effort',
    'high',
    '--prompt-interactive',
    'Corrige le test',
  ]);
  const resumed = buildAgentCommand('gemini', 'bypass', 'ignoré', 'cerebro-id', 'conv-1', {
    model: null,
    effort: null,
  });
  assert.equal(resumed.agentSessionId, 'conv-1');
  assert.deepEqual(resumed.args, ['--conversation', 'conv-1', '--dangerously-skip-permissions']);
  assert.deepEqual(buildAgentCommand('gemini', 'plan', '', 'x', null).args, ['--mode', 'plan']);
  assert.deepEqual(buildAgentCommand('gemini', 'auto', '', 'x', null).args, ['--mode', 'auto']);
  assert.deepEqual(buildAgentCommand('gemini', 'default', '', 'x', null).args, []);
});

test('dossier de session agy : approuvé pour la session seulement, notifications d’autorisation activées', () => {
  const [flag, settings] = workspaceArgs('gemini', '/data/workspaces/s1');
  assert.equal(flag, '--settings');
  assert.deepEqual(JSON.parse(settings), { notifications: true, trustedWorkspaces: ['/data/workspaces/s1'] });
  for (const agent of ['claude', 'codex', 'grok']) assert.deepEqual(workspaceArgs(agent, '/x'), []);
});

test('plugin agy : installé seulement si agy l’est, hooks inertes hors des sessions Cerebro', () => {
  const plugin = join(root, 'plugin');
  installGeminiHook(plugin, join(root, 'absent'));
  assert.equal(existsSync(plugin), false);

  const home = join(root, 'agy-home');
  mkdirSync(home);
  installGeminiHook(plugin, home);
  assert.deepEqual(JSON.parse(readFileSync(join(plugin, 'plugin.json'), 'utf8')), { name: 'cerebro' });
  const injection = JSON.parse(readFileSync(join(plugin, 'session-start.json'), 'utf8'));
  assert.match(injection.injectSteps[0].systemMessage.systemMessage, /^Tu tournes dans Cerebro/);
  const hooks = JSON.parse(readFileSync(join(plugin, 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks, getGeminiHookSettings(join(plugin, 'session-start.json')));
  assert.deepEqual(Object.keys(hooks.cerebro), ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);
  assert.equal(hooks.cerebro.PreToolUse[0].matcher, '^ask_question$');
  const commands = [
    hooks.cerebro.SessionStart[0].command,
    hooks.cerebro.PreInvocation[0].command,
    hooks.cerebro.PreToolUse[0].hooks[0].command,
    hooks.cerebro.PostToolUse[0].hooks[0].command,
    hooks.cerebro.Stop[0].command,
  ];
  // Inertes hors des sessions agy de Cerebro, y compris pour un agy lancé depuis une autre session.
  for (const command of commands) assert.match(command, /^\[ "\$CEREBRO_AGENT" != gemini \] \|\| /);
  assert.match(
    hooks.cerebro.SessionStart[0].command,
    /cat '.*session-start\.json'; node '.*cerebro-hook\.mjs' gemini SessionStart;/,
  );
});

/** Étapes de transcript telles qu'agy 1.5.8 les écrit. */
function step(fields) {
  return JSON.stringify({ status: 'DONE', created_at: '2026-11-13T08:55:54Z', ...fields });
}
const TRANSCRIPT = [
  step({
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    content:
      '<USER_REQUEST>\nLance echo bonjour\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-13T09:55:54+01:00.\n</ADDITIONAL_METADATA>',
  }),
  step({
    step_index: 1,
    source: 'SYSTEM_SDK',
    type: 'SYSTEM_MESSAGE',
    content: '<SYSTEM_MESSAGE>Tu tournes dans Cerebro.</SYSTEM_MESSAGE>',
  }),
  step({
    step_index: 2,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    input_tokens: 9003,
    cache_read_tokens: 0,
    output_tokens: 42,
    tool_calls: [{ name: 'run_command', args: { CommandLine: '"echo bonjour"' } }],
    content: '',
  }),
  step({ step_index: 3, source: 'MODEL', type: 'GENERIC', content: 'Command exited with code 0.' }),
  step({
    step_index: 4,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    input_tokens: 5080,
    cache_read_tokens: 4052,
    output_tokens: 2,
    content: 'FINI',
  }),
].join('\n');

test('transcript agy : demande de l’utilisateur sans métadonnées, réponses du modèle, jetons par étape', () => {
  assert.deepEqual(parseTranscript('gemini', TRANSCRIPT), [
    { role: 'user', text: 'Lance echo bonjour' },
    { role: 'assistant', text: 'FINI' },
  ]);
  const tokens = new TokenAccumulator();
  // Une étape relue (fichier réécrit) ne compte qu'une fois.
  for (const line of [...TRANSCRIPT.split('\n'), TRANSCRIPT.split('\n').at(-1)])
    tokens.accept('gemini', JSON.parse(line));
  assert.deepEqual(tokens.total('gemini'), {
    inputTokens: 9003 + 5080 + 4052,
    outputTokens: 44,
    cachedInputTokens: 4052,
    cacheWriteInputTokens: 0,
  });
});

test('fin de tour agy : la réponse finale n’est lue qu’une fois écrite en dernière étape', () => {
  const lines = TRANSCRIPT.split('\n');
  assert.equal(geminiFinalAnswer(TRANSCRIPT), 'FINI');
  assert.equal(geminiFinalAnswer(`${TRANSCRIPT}\n`), 'FINI');
  // Au moment du hook Stop, la dernière réponse n'est pas encore écrite.
  assert.equal(geminiFinalAnswer(lines.slice(0, 2).join('\n')), undefined);
  assert.equal(geminiFinalAnswer(lines.slice(0, 3).join('\n')), undefined, 'étape qui appelle un outil');
  assert.equal(geminiFinalAnswer(`${TRANSCRIPT}\n{"step_index":5,"sou`), undefined, 'ligne en cours d’écriture');
  assert.equal(geminiFinalAnswer(''), undefined);
});

/** Ce que les hooks agy font de la session, sans PTY ni serveur. */
function recorder(agentSessionId = null) {
  const calls = [];
  const session = { agentSessionId };
  const sessions = {
    db: { getSession: () => session },
    setAgentSessionId: (_id, value) => {
      session.agentSessionId = value;
      calls.push(['agentSessionId', value]);
    },
    clearAsked: () => calls.push(['clearAsked']),
    setPendingQuestions: () => {},
    setRunning: () => calls.push(['running']),
    setReliableState: (_id, status, reason, detail) => calls.push([status, reason, detail]),
    reportTurnComplete: (_id, message) => calls.push(['turnComplete', message]),
  };
  return { calls, sessions };
}

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 8_000) {
        clearInterval(timer);
        reject(new Error('délai dépassé'));
      }
    }, 50);
  });
}

test('hooks agy : conversation retenue, tour en cours, question, fin de tour avec la réponse écrite après le Stop', async () => {
  const conversation = '7224c6ea-2a88-4a83-91da-d4aeec7e0046';
  const logs = join(root, '.gemini', 'antigravity-cli', 'brain', conversation, '.system_generated', 'logs');
  mkdirSync(logs, { recursive: true });
  const lines = TRANSCRIPT.split('\n');
  writeFileSync(join(logs, 'transcript.jsonl'), `${lines.slice(0, 4).join('\n')}\n`);

  const { calls, sessions } = recorder();
  const hook = (event, payload) =>
    handleHook(sessions, 'sid', 'gemini', event, { conversationId: conversation, ...payload });
  hook('SessionStart', {});
  // Un sous-agent démarre sa propre conversation : ni son identifiant ni ses événements ne comptent.
  hook('SessionStart', { conversationId: 'subagent' });
  hook('Stop', { conversationId: 'subagent', terminationReason: 'NO_TOOL_CALL' });
  hook('PreInvocation', { invocationNum: 0 });
  hook('PreToolUse', { toolCall: { name: 'run_command', args: {} } });
  hook('PreToolUse', { toolCall: { name: 'ask_question', args: { Question: 'Quelle base ?' } } });
  hook('PostToolUse', { toolCall: { name: 'ask_question' } });
  hook('Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true });
  assert.deepEqual(calls, [
    ['agentSessionId', conversation],
    ['clearAsked'],
    ['running'],
    ['waiting', 'Question', null],
    ['running'],
  ]);
  // agy écrit la réponse finale juste après son hook Stop.
  writeFileSync(join(logs, 'transcript.jsonl'), `${TRANSCRIPT}\n`);
  await waitFor(() => calls.some(([kind]) => kind === 'turnComplete'));
  assert.deepEqual(calls.slice(5), [
    ['idle', 'Tour terminé', { kind: 'turn', message: 'FINI' }],
    ['turnComplete', 'FINI'],
  ]);
});

test('hooks agy : un tour repris avant la lecture différée du Stop n’est pas déclaré terminé', async () => {
  const { calls, sessions } = recorder('conv-2');
  const hook = (event, payload) =>
    handleHook(sessions, 'sid-2', 'gemini', event, { conversationId: 'conv-2', ...payload });
  // Tour annulé : pas de réponse à attendre.
  hook('Stop', { terminationReason: 'USER_CANCELED' });
  await waitFor(() => calls.some(([kind]) => kind === 'turnComplete'));
  assert.deepEqual(calls, [
    ['idle', 'Tour terminé', undefined],
    ['turnComplete', null],
  ]);
  calls.length = 0;
  hook('Stop', { terminationReason: 'NO_TOOL_CALL' });
  hook('PreInvocation', { invocationNum: 0 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(calls, [['clearAsked'], ['running']]);
});

test('quotas agy : part consommée de chaque limite, par groupe de modèles', () => {
  const output = JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.75, reset_time: '2026-11-20T08:52:37Z' },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 1, reset_time: '2026-11-13T13:52:37Z' },
            ],
          },
          {
            name: 'Claude and GPT models',
            buckets: [{ id: '3p-5h', window: '5h', remaining_fraction: 0.1, reset_time: '2026-11-13T13:58:03Z' }],
          },
        ],
      },
    },
  });
  assert.deepEqual(parseGeminiUsage(output), [
    // agy donne la semaine en premier : la fenêtre de 5 h passe devant.
    { label: 'Gemini 5 h', percent: 0, minutes: 300, resetsAt: '2026-11-13T13:52:37.000Z' },
    { label: 'Gemini Semaine', percent: 25, minutes: 10_080, resetsAt: '2026-11-20T08:52:37.000Z' },
    { label: 'Claude/GPT 5 h', percent: 90, minutes: 300, resetsAt: '2026-11-13T13:58:03.000Z' },
  ]);
  assert.throws(() => parseGeminiUsage('{"status":"SUCCESS"}'), /illisible/);
});

test('migration : la contrainte des sessions accepte gemini et garde les sessions existantes', () => {
  const path = join(root, 'legacy.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex', 'grok')),
      mode TEXT NOT NULL CHECK (mode IN ('default', 'acceptEdits', 'plan', 'bypass')),
      prompt TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'waiting', 'idle', 'exited')),
      attention INTEGER NOT NULL DEFAULT 0,
      attention_reason TEXT,
      agent_session_id TEXT,
      exit_code INTEGER,
      hook_token TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      model TEXT,
      effort TEXT
    );
    INSERT INTO projects VALUES ('p', 'Projet', '/tmp/projet', 1);
    INSERT INTO sessions (id, project_id, agent, mode, prompt, title, status, created_at, updated_at)
      VALUES ('old', 'p', 'grok', 'plan', 'ancien', 'ancien', 'exited', 1, 1);
  `);
  legacy.close();

  const db = new CerebroDatabase(path);
  const sql = db.connection.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'").get().sql;
  assert.match(sql, /'grok', 'gemini'\)/);
  assert.match(sql, /'default', 'auto', 'acceptEdits'/);
  assert.equal(db.getSession('old')?.agent, 'grok');
  const created = db.createSession(
    {
      id: 'new',
      projectId: 'p',
      agent: 'gemini',
      mode: 'auto',
      model: 'gemini-4-argon',
      effort: 'high',
      prompt: 'nouveau',
      title: 'nouveau',
      status: 'starting',
      agentSessionId: null,
    },
    'token',
  );
  assert.equal(created.agent, 'gemini');
  db.connection.close();
  // Seconde ouverture : rien à reconstruire.
  const reopened = new CerebroDatabase(path);
  assert.equal(reopened.getSession('new')?.model, 'gemini-4-argon');
  reopened.connection.close();
});

test('headless agy : invite sur l’entrée standard, règles de permission selon l’accès, sortie structurée', async (t) => {
  const bin = join(root, 'headless-bin');
  const project = join(root, 'headless-project');
  const capture = join(root, 'headless-capture.json');
  mkdirSync(bin);
  mkdirSync(project);
  writeFileSync(
    join(bin, 'agy'),
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const stdin = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), stdin, session: process.env.CEREBRO_SESSION_ID ?? null }));
console.log(JSON.stringify({ event: 'init', init: { tools: [] } }));
const status = process.env.FAKE_AGY_STATUS ?? 'SUCCESS';
console.log(JSON.stringify({ event: 'result', result: { status, error: status === 'SUCCESS' ? undefined : 'quota épuisé', response: '{"answer":"ok"}', structured_output: { answer: 'ok' } } }));
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.CEREBRO_SESSION_ID = 'session-sentinel';
  t.after(() => {
    process.env.PATH = previousPath;
    delete process.env.CEREBRO_SESSION_ID;
    delete process.env.FAKE_AGY_STATUS;
  });
  const run = (access, web) =>
    runHeadless({
      agent: 'gemini',
      model: 'gemini-4-argon',
      effort: 'low',
      prompt: 'Réponds ok.\n'.repeat(20_000),
      cwd: project,
      access,
      web,
      schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

  assert.deepEqual(await run('read-only', false), { answer: 'ok' });
  let received = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(received.session, null, 'les hooks Cerebro restent inertes');
  assert.deepEqual(JSON.parse(received.stdin), { event: 'user', message: { content: 'Réponds ok.\n'.repeat(20_000) } });
  const args = received.args;
  assert.deepEqual(args.slice(0, 4), ['--input-format', 'stream-json', '--output-format', 'stream-json']);
  assert.ok(!args.includes('-p') && !args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(args.slice(-4), ['--model', 'gemini-4-argon', '--effort', 'low']);
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), {
    agentMode: '',
    permissions: {
      allow: [`read_file(${project}/)`],
      deny: ['write_file(*)', 'command(*)', 'mcp(*)', 'execute_url(*)', 'read_url(*)'],
    },
  });

  await run('none', true);
  received = JSON.parse(readFileSync(capture, 'utf8'));
  assert.deepEqual(JSON.parse(received.args[received.args.indexOf('--settings') + 1]).permissions, {
    allow: ['read_url(*)'],
    deny: ['write_file(*)', 'command(*)', 'mcp(*)', 'execute_url(*)', 'read_file(*)'],
  });

  process.env.FAKE_AGY_STATUS = 'ERROR';
  await assert.rejects(run('none', false), /quota épuisé/);
  await assert.rejects(
    runHeadless({
      agent: 'gemini',
      model: null,
      effort: null,
      prompt: 'x',
      access: 'none',
      images: [join(project, 'a.png')],
      schema: {},
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    }),
    /ne prend pas en charge les images/,
  );
});
