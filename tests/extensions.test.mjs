import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

// Fully isolated environment: no real HOME, agents, Slack credentials or user config files are touched.
const root = mkdtempSync(join(tmpdir(), 'cerebro-ext-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
process.env.GROK_HOME = join(root, 'grok');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
mkdirSync(process.env.CEREBRO_DATA_DIR, { recursive: true });
mkdirSync(process.env.GROK_HOME, { recursive: true });

const { workspaceArgs } = await import('../server/agents.ts');
const { Catalog } = await import('../server/catalog.ts');
const { SESSIONS_DIR } = await import('../server/config.ts');
const { buildServer } = await import('../server/index.ts');
const { cleanupSessionExtensions, prepareSessionExtensions, sessionExtensionsDir } = await import('../server/mcp.ts');
const { PeerSync } = await import('../server/peers.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { parseEventsMessage, parseExtensionList, parseProject, parseSession } = await import('../shared/types.ts');
const { applyEventsMessage } = await import('../web/src/machine-data.ts');

mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});

const catalog = new Catalog({
  claude: {
    models: [{ value: 'claude-sonnet-4-6', label: 'Sonnet', description: '', efforts: ['medium', 'high'] }],
    efforts: ['low', 'medium', 'high'],
    defaultModel: 'claude-sonnet-4-6',
  },
  codex: {
    models: [{ value: 'gpt-5', label: 'GPT-5', description: '', efforts: ['high'] }],
    efforts: ['medium', 'high'],
    defaultModel: 'gpt-5',
  },
  gemini: {
    models: [{ value: 'gemini-4-argon', label: 'Argon', description: '', efforts: ['high'] }],
    efforts: ['low', 'medium', 'high'],
    defaultModel: 'gemini-4-argon',
  },
  grok: {
    models: [{ value: 'grok-4', label: 'Grok 4', description: '', efforts: ['high'] }],
    efforts: ['low', 'high'],
    defaultModel: 'grok-4',
  },
});

// Capture every launch invocation (agent, resolved extensionIds, prepared artifacts) without spawning a real PTY.
const launched = [];
mock.method(
  SessionManager.prototype,
  'launch',
  async function (
    project,
    { agent, mode, tuning, prompt, resumeSessionId = null, existingId = null, epicId = null, extensionIds = [] },
  ) {
    const id = existingId ?? `sess-${launched.length + 1}`;
    const storedExtensions = this.db.getStoredExtensionsByIds(extensionIds);
    const prepared = prepareSessionExtensions(agent, storedExtensions, SESSIONS_DIR, id);
    launched.push({
      id,
      projectId: project.id,
      agent,
      resumeSessionId,
      extensionIds: storedExtensions.map((ext) => ext.id),
      extensionNames: storedExtensions.map((ext) => ext.name),
      prepared,
    });
    if (existingId !== null) {
      return this.db.updateSession(existingId, { status: 'exited', exitCode: 0 });
    }
    return this.db.createSession(
      {
        id,
        projectId: project.id,
        agent,
        mode,
        ...tuning,
        prompt,
        title: prompt || `${agent} session`,
        status: 'exited',
        agentSessionId: `agent-${id}`,
        extensionIds: storedExtensions.map((ext) => ext.id),
      },
      'hook-token',
      epicId,
    );
  },
);

after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

test('prepareSessionExtensions : injection par agent sans polluer le dépôt Git ni exposer les secrets sur la CLI', () => {
  const projectRepo = join(root, 'clean-repo');
  mkdirSync(projectRepo, { recursive: true });
  writeFileSync(join(projectRepo, 'index.js'), 'console.log("ok");\n');

  const grokHome = join(root, 'grok-unit');
  mkdirSync(grokHome, { recursive: true });
  writeFileSync(join(grokHome, 'config.toml'), 'theme = "dark"\n');
  writeFileSync(join(grokHome, 'auth.json'), '{"token":"initial"}', { mode: 0o600 });
  writeFileSync(join(grokHome, 'sandbox-blocked.1234'), 'ignored');

  const sessionsDir = join(root, 'sessions-unit');
  mkdirSync(sessionsDir, { recursive: true });

  const extensions = [
    {
      id: 'ext-http',
      kind: 'mcp',
      name: 'data-gouv',
      description: 'Open data',
      transport: {
        type: 'http',
        url: 'https://mcp.data.gouv.fr/mcp',
        headers: { Authorization: 'Bearer super-secret-http-token' },
      },
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'ext-stdio',
      kind: 'mcp',
      name: 'local_db',
      description: 'SQLite local',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@mcp/sqlite', '/data/app.db'],
        env: { DB_PASSWORD: 'super-secret-db-pass' },
      },
      createdAt: 2,
      updatedAt: 2,
    },
  ];

  // Empty list touches nothing on disk.
  for (const agent of ['claude', 'codex', 'gemini', 'grok']) {
    const empty = prepareSessionExtensions(agent, [], sessionsDir, 'none', grokHome);
    assert.deepEqual(empty, { args: [], env: {}, trustedDirs: [] });
    assert.equal(existsSync(sessionExtensionsDir(sessionsDir, 'none')), false);
  }

  // 1. Claude: 0600 JSON file passed via --mcp-config, no secret in CLI args.
  const claudePrep = prepareSessionExtensions('claude', extensions, sessionsDir, 's-claude', grokHome);
  assert.equal(claudePrep.args[0], '--mcp-config');
  assert.equal(claudePrep.args.join(' ').includes('super-secret'), false);
  const claudeFile = claudePrep.args[1];
  assert.equal(statSync(claudeFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(claudeFile, 'utf8')), {
    mcpServers: {
      'data-gouv': {
        type: 'http',
        url: 'https://mcp.data.gouv.fr/mcp',
        headers: { Authorization: 'Bearer super-secret-http-token' },
      },
      local_db: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@mcp/sqlite', '/data/app.db'],
        env: { DB_PASSWORD: 'super-secret-db-pass' },
      },
    },
  });
  cleanupSessionExtensions(sessionsDir, 's-claude', grokHome);
  assert.equal(existsSync(claudeFile), false);

  // 2. Codex: -c overrides; HTTP auth header value goes into PTY env (`CEREBRO_MCP_HDR_0`), never on CLI args.
  const codexPrep = prepareSessionExtensions('codex', extensions, sessionsDir, 's-codex', grokHome);
  assert.equal(codexPrep.args.join(' ').includes('super-secret-http-token'), false);
  assert.equal(codexPrep.env.CEREBRO_MCP_HDR_0, 'Bearer super-secret-http-token');
  assert.deepEqual(codexPrep.args, [
    '-c',
    'mcp_servers.data-gouv={url="https://mcp.data.gouv.fr/mcp",env_http_headers={Authorization="CEREBRO_MCP_HDR_0"}}',
    '-c',
    'mcp_servers.local_db={command="npx",args=["-y","@mcp/sqlite","/data/app.db"],env={DB_PASSWORD="super-secret-db-pass"}}',
  ]);

  // 3. Gemini (agy): isolated plugin passed via --add-dir and trusted via workspaceArgs.
  const geminiPrep = prepareSessionExtensions('gemini', extensions, sessionsDir, 's-gemini', grokHome);
  assert.equal(geminiPrep.args[0], '--add-dir');
  const agyDir = geminiPrep.args[1];
  assert.deepEqual(geminiPrep.trustedDirs, [agyDir]);
  const [settingsFlag, settingsJson] = workspaceArgs('gemini', projectRepo, geminiPrep.trustedDirs);
  assert.equal(settingsFlag, '--settings');
  assert.deepEqual(JSON.parse(settingsJson), {
    notifications: true,
    trustedWorkspaces: [projectRepo, agyDir],
  });
  const agyMcpPath = join(agyDir, '.agents', 'plugins', 'cerebro-mcp', 'mcp_config.json');
  assert.equal(statSync(agyMcpPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(agyMcpPath, 'utf8')), {
    mcpServers: {
      'data-gouv': {
        url: 'https://mcp.data.gouv.fr/mcp',
        headers: { Authorization: 'Bearer super-secret-http-token' },
      },
      local_db: {
        command: 'npx',
        args: ['-y', '@mcp/sqlite', '/data/app.db'],
        env: { DB_PASSWORD: 'super-secret-db-pass' },
      },
    },
  });
  cleanupSessionExtensions(sessionsDir, 's-gemini', grokHome);
  assert.equal(existsSync(agyDir), false);

  // 4. Grok: isolated GROK_HOME with shared symlinks, merged 0600 config.toml, short leader socket, OAuth sync on cleanup.
  const grokPrep = prepareSessionExtensions('grok', extensions, sessionsDir, 's-grok', grokHome);
  assert.equal(grokPrep.args[0], '--leader-socket');
  assert.ok(Buffer.byteLength(`${grokPrep.args[1]}.daemon`) < 108, 'leader socket path fits in Linux sun_path');
  const isolatedGrok = grokPrep.env.GROK_HOME;
  assert.ok(isolatedGrok);
  assert.ok(lstatSync(join(isolatedGrok, 'sessions')).isSymbolicLink());
  assert.ok(lstatSync(join(isolatedGrok, 'hooks')).isSymbolicLink());
  assert.ok(lstatSync(join(isolatedGrok, 'auth.json')).isSymbolicLink());
  assert.equal(existsSync(join(isolatedGrok, 'sandbox-blocked.1234')), false);
  const grokToml = readFileSync(join(isolatedGrok, 'config.toml'), 'utf8');
  assert.equal(statSync(join(isolatedGrok, 'config.toml')).mode & 0o777, 0o600);
  assert.match(grokToml, /^theme = "dark"/);
  assert.match(grokToml, /\[mcp_servers\.data-gouv\]\nurl = "https:\/\/mcp\.data\.gouv\.fr\/mcp"\nenabled = true/);
  assert.match(grokToml, /\[mcp_servers\.data-gouv\.headers\]\nAuthorization = "Bearer super-secret-http-token"/);
  assert.match(
    grokToml,
    /\[mcp_servers\.local_db\]\ncommand = "npx"\nargs = \["-y", "@mcp\/sqlite", "\/data\/app\.db"\]/,
  );

  // Simulate Grok atomically replacing auth.json during an OAuth refresh: cleanup syncs it back to base grokHome.
  rmSync(join(isolatedGrok, 'auth.json'));
  writeFileSync(join(isolatedGrok, 'auth.json'), '{"token":"refreshed"}', { mode: 0o600 });
  cleanupSessionExtensions(sessionsDir, 's-grok', grokHome);
  assert.equal(readFileSync(join(grokHome, 'auth.json'), 'utf8'), '{"token":"refreshed"}');
  assert.equal(existsSync(isolatedGrok), false);

  // Project repository was never touched by any agent's MCP preparation.
  assert.deepEqual(readdirSync(projectRepo), ['index.js']);
});

test('API /api/extensions, réglages par projet, surcharge ponctuelle par session et reprise', async (t) => {
  const projectDirA = join(root, 'proj-a');
  const projectDirB = join(root, 'proj-b');
  mkdirSync(projectDirA, { recursive: true });
  mkdirSync(projectDirB, { recursive: true });

  const app = await buildServer({ catalog });
  t.after(async () => {
    await app.close();
  });

  // Validation errors on invalid extension payloads.
  const badName = await app.inject({
    method: 'POST',
    url: '/api/extensions',
    payload: { kind: 'mcp', name: 'bad space!', transport: { type: 'http', url: 'https://mcp.data.gouv.fr/mcp' } },
  });
  assert.equal(badName.statusCode, 400);

  const badUrl = await app.inject({
    method: 'POST',
    url: '/api/extensions',
    payload: { kind: 'mcp', name: 'ftp-srv', transport: { type: 'http', url: 'ftp://example.com/mcp' } },
  });
  assert.equal(badUrl.statusCode, 400);

  const reservedEnv = await app.inject({
    method: 'POST',
    url: '/api/extensions',
    payload: {
      kind: 'mcp',
      name: 'stdio-bad',
      transport: { type: 'stdio', command: 'npx', env: { CEREBRO_TOKEN: 'spoof' } },
    },
  });
  assert.equal(reservedEnv.statusCode, 400);

  // Create HTTP extension (`data-gouv`) with a secret header: response exposes headerNames, never secret values.
  const createHttp = await app.inject({
    method: 'POST',
    url: '/api/extensions',
    payload: {
      kind: 'mcp',
      name: 'data-gouv',
      description: 'Open data FR',
      transport: {
        type: 'http',
        url: 'https://mcp.data.gouv.fr/mcp',
        headers: { Authorization: 'Bearer secret-value-1' },
      },
    },
  });
  assert.equal(createHttp.statusCode, 201);
  assert.equal(createHttp.body.includes('secret-value-1'), false);
  const dataGouv = createHttp.json();
  assert.equal(dataGouv.name, 'data-gouv');
  assert.deepEqual(dataGouv.transport, {
    type: 'http',
    url: 'https://mcp.data.gouv.fr/mcp',
    headerNames: ['Authorization'],
  });

  // Case-insensitive duplicate name rejected with 409.
  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/extensions',
    payload: { kind: 'mcp', name: 'DATA-GOUV', transport: { type: 'http', url: 'https://mcp.data.gouv.fr/mcp' } },
  });
  assert.equal(duplicate.statusCode, 409);

  // Create stdio extension.
  const createStdio = await app.inject({
    method: 'POST',
    url: '/api/extensions',
    payload: {
      kind: 'mcp',
      name: 'sqlite',
      description: 'Base locale',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@mcp/sqlite'],
        env: { SQLITE_KEY: 'secret-sqlite-key' },
      },
    },
  });
  assert.equal(createStdio.statusCode, 201);
  assert.equal(createStdio.body.includes('secret-sqlite-key'), false);
  const sqliteExt = createStdio.json();
  assert.deepEqual(sqliteExt.transport.envNames, ['SQLITE_KEY']);

  // Update `data-gouv` keeping saved secret (`Authorization: null`) while adding a second header.
  const updateKeepSecret = await app.inject({
    method: 'PUT',
    url: `/api/extensions/${dataGouv.id}`,
    payload: {
      kind: 'mcp',
      name: 'data-gouv',
      description: 'Portail data.gouv.fr',
      transport: {
        type: 'http',
        url: 'https://mcp.data.gouv.fr/mcp',
        headers: { Authorization: null, 'X-Client': 'cerebro' },
      },
    },
  });
  assert.equal(updateKeepSecret.statusCode, 200);
  assert.deepEqual(updateKeepSecret.json().transport.headerNames, ['Authorization', 'X-Client']);

  // Passing `null` for an unknown header key fails with 400.
  const badKeep = await app.inject({
    method: 'PUT',
    url: `/api/extensions/${dataGouv.id}`,
    payload: {
      kind: 'mcp',
      name: 'data-gouv',
      transport: { type: 'http', url: 'https://mcp.data.gouv.fr/mcp', headers: { UnknownHeader: null } },
    },
  });
  assert.equal(badKeep.statusCode, 400);

  // GET /api/extensions lists extensions sorted by name without leaking secrets.
  const listed = await app.inject({ method: 'GET', url: '/api/extensions' });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.includes('secret-value-1'), false);
  assert.deepEqual(
    parseExtensionList(listed.json()).map((e) => e.name),
    ['data-gouv', 'sqlite'],
  );

  // Create two projects: Project A enables `data-gouv` by default; Project B leaves extensions empty.
  const projARes = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'Projet OpenData', path: projectDirA, workspaceMode: 'shared' },
  });
  const projA = projARes.json();
  assert.deepEqual(projA.extensionIds, []);

  const projBRes = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'Projet Backend', path: projectDirB, workspaceMode: 'shared' },
  });
  const projB = projBRes.json();

  // Unknown extensionId on PATCH /api/projects/:id returns 400.
  const unknownPatch = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${projA.id}`,
    payload: { extensionIds: ['missing-id'] },
  });
  assert.equal(unknownPatch.statusCode, 400);

  const patchProjA = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${projA.id}`,
    payload: { extensionIds: [dataGouv.id] },
  });
  assert.equal(patchProjA.statusCode, 200);
  assert.deepEqual(patchProjA.json().extensionIds, [dataGouv.id]);

  launched.length = 0;

  // 1) Launch in Project A without explicit extensionIds -> inherits Project A's default (`data-gouv`), including preserved secret!
  const s1Res = await app.inject({
    method: 'POST',
    url: `/api/projects/${projA.id}/sessions`,
    payload: { agent: 'codex', prompt: 'Analyse les jeux de données' },
  });
  assert.equal(s1Res.statusCode, 201);
  assert.deepEqual(s1Res.json().extensionIds, [dataGouv.id]);
  assert.deepEqual(launched[0].extensionNames, ['data-gouv']);
  assert.equal(launched[0].prepared.env.CEREBRO_MCP_HDR_0, 'Bearer secret-value-1');
  assert.equal(launched[0].prepared.env.CEREBRO_MCP_HDR_1, 'cerebro');

  // 2) Launch in Project B without explicit extensionIds -> no MCP injected (`[]`).
  const s2Res = await app.inject({
    method: 'POST',
    url: `/api/projects/${projB.id}/sessions`,
    payload: { agent: 'claude', prompt: 'Refactorise le routeur' },
  });
  assert.equal(s2Res.statusCode, 201);
  assert.deepEqual(s2Res.json().extensionIds, []);
  assert.deepEqual(launched[1].prepared.args, []);

  // 3) One-off launch in Project B WITH explicit `extensionIds: [sqliteExt.id]` -> activates `sqlite` ONLY for this session,
  //    without modifying Project B's default (`extensionIds` stays `[]`).
  const s3Res = await app.inject({
    method: 'POST',
    url: `/api/projects/${projB.id}/sessions`,
    payload: { agent: 'claude', prompt: 'Inspecte la base locale', extensionIds: [sqliteExt.id] },
  });
  assert.equal(s3Res.statusCode, 201);
  const s3 = s3Res.json();
  assert.deepEqual(s3.extensionIds, [sqliteExt.id]);
  assert.equal(launched[2].prepared.args[0], '--mcp-config');

  const projBAfter = (await app.inject({ method: 'GET', url: '/api/projects' })).json().find((p) => p.id === projB.id);
  assert.deepEqual(projBAfter.extensionIds, [], 'one-off session launch must not alter project default extensions');

  // 4) Resuming s3 keeps its one-off `sqlite` extension even though Project B's default is empty.
  const resumedRes = await app.inject({ method: 'POST', url: `/api/sessions/${s3.id}/resume` });
  assert.equal(resumedRes.statusCode, 200);
  assert.deepEqual(launched[3].extensionNames, ['sqlite']);
  assert.equal(launched[3].resumeSessionId, `agent-${s3.id}`);

  // 5) Deleting `data-gouv` removes it from Project A's default `extensionIds`.
  const delRes = await app.inject({ method: 'DELETE', url: `/api/extensions/${dataGouv.id}` });
  assert.equal(delRes.statusCode, 204);
  const projAAfterDelete = (await app.inject({ method: 'GET', url: '/api/projects' }))
    .json()
    .find((p) => p.id === projA.id);
  assert.deepEqual(projAAfterDelete.extensionIds, []);
});

test('rétrocompatibilité : parseurs et store tolèrent les serveurs distants sans extensions', () => {
  const legacyProject = parseProject({ id: 'p1', name: 'Legacy', path: '/tmp/p1', createdAt: 10 });
  assert.deepEqual(legacyProject?.extensionIds, []);

  const legacySession = parseSession({
    id: 's1',
    projectId: 'p1',
    agent: 'claude',
    mode: 'auto',
    prompt: '',
    title: 'claude session',
    status: 'idle',
    attention: false,
    attentionReason: null,
    agentSessionId: null,
    exitCode: null,
    createdAt: 10,
    updatedAt: 10,
  });
  assert.deepEqual(legacySession?.extensionIds, []);

  const legacySnapshot = parseEventsMessage({
    type: 'snapshot',
    projects: [],
    sessions: [],
    tasks: [],
    epics: [],
    runEvents: true,
  });
  assert.equal(legacySnapshot?.type, 'snapshot');
  assert.deepEqual(legacySnapshot?.extensions, []);

  const state = applyEventsMessage(null, legacySnapshot);
  const updated = applyEventsMessage(
    state,
    parseEventsMessage({
      type: 'extensions',
      extensions: [
        {
          id: 'e1',
          kind: 'mcp',
          name: 'data-gouv',
          description: '',
          transport: { type: 'http', url: 'https://mcp.data.gouv.fr/mcp', headerNames: [] },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
  );
  assert.deepEqual(
    updated?.extensions.map((e) => e.name),
    ['data-gouv'],
  );
});

test('layout CSS des extensions : case à cocher et métadonnées alignées en ligne sans marges parasites', () => {
  const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');
  const toggleRule = css.match(/\.project-extension-toggle\s*\{[^}]*\}/)?.[0] ?? '';
  // Global `label` is `flex-direction: column`: `.project-extension-toggle` must explicitly force `row` + `center`.
  assert.match(toggleRule, /flex-direction:\s*row/);
  assert.match(toggleRule, /align-items:\s*center/);
  const checkboxRule = css.match(/\.project-extension-toggle input\[type='checkbox'\]\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(checkboxRule, /width:\s*auto/);
  assert.match(checkboxRule, /margin:\s*0/);
  const headRule = css.match(/\.project-extensions-head\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(headRule, /justify-content:\s*space-between/);
  assert.match(headRule, /align-items:\s*center/);
});
