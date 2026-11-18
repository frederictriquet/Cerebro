import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

// Environnement entièrement isolé : aucun fichier utilisateur réel touché.
const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'cerebro-trust-'));
process.env.HOME = join(root, 'home');
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
process.env.GROK_HOME = join(root, 'grok');
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.CEREBRO_DATA_DIR, { recursive: true });
mkdirSync(process.env.CODEX_HOME, { recursive: true });
mkdirSync(process.env.GROK_HOME, { recursive: true });

(await import('../server/config.ts')).ensureDataDirs();
const { workspaceArgs } = await import('../server/agents.ts');
const { SESSIONS_DIR } = await import('../server/config.ts');
const { CerebroDatabase } = await import('../server/db.ts');
const { resolveTrustedPaths, trustClaudeFolders, trustGrokFolders } = await import('../server/folder-trust.ts');
const { holderPaths } = await import('../server/holder-protocol.ts');
const { buildServer } = await import('../server/index.ts');
const { sessionExtensionsDir } = await import('../server/mcp.ts');
const { PeerSync } = await import('../server/peers.ts');
const { createServices } = await import('../server/services.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { UpdateManager } = await import('../server/updates.ts');

mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});

after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

test('API /api/trust-folders : activé par défaut, persistant, validé strictement', async () => {
  const app = await buildServer();
  const send = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  try {
    assert.deepEqual((await send('GET', '/api/trust-folders')).json(), { enabled: true });

    let res = await send('PUT', '/api/trust-folders', { enabled: false });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { enabled: false });
    assert.deepEqual((await send('GET', '/api/trust-folders')).json(), { enabled: false });

    for (const invalid of [{}, { enabled: null }, { enabled: 'true' }, { enabled: 1 }]) {
      res = await send('PUT', '/api/trust-folders', invalid);
      assert.equal(res.statusCode, 400);
    }
    assert.deepEqual((await send('GET', '/api/trust-folders')).json(), { enabled: false });

    const db = new CerebroDatabase();
    try {
      assert.equal(db.getTrustFolders(), false);
    } finally {
      db.close();
    }

    res = await send('PUT', '/api/trust-folders', { enabled: true });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { enabled: true });
  } finally {
    await app.close();
  }
});

test('workspaceArgs : flags éphémères pour codex et gemini selon trustFolders', () => {
  assert.deepEqual(workspaceArgs('codex', '/data/workspaces/s1'), [
    '-c',
    'projects={"/data/workspaces/s1"={trust_level="trusted"}}',
  ]);
  assert.deepEqual(workspaceArgs('codex', '/data/workspaces/s1/sub', [], true, ['/data/workspaces/s1']), [
    '-c',
    'projects={"/data/workspaces/s1/sub"={trust_level="trusted"},"/data/workspaces/s1"={trust_level="trusted"}}',
  ]);
  assert.deepEqual(workspaceArgs('codex', '/data/workspaces/s1', [], false), []);

  const [flagOn, settingsOn] = workspaceArgs('gemini', '/data/workspaces/s1', ['/ext/agy'], true, ['/real/s1']);
  assert.equal(flagOn, '--settings');
  assert.deepEqual(JSON.parse(settingsOn), {
    notifications: true,
    trustedWorkspaces: ['/data/workspaces/s1', '/real/s1', '/ext/agy'],
  });

  const [, settingsOffWithExt] = workspaceArgs('gemini', '/data/workspaces/s1', ['/ext/agy'], false, ['/real/s1']);
  assert.deepEqual(JSON.parse(settingsOffWithExt), {
    notifications: true,
    trustedWorkspaces: ['/ext/agy'],
  });

  const [, settingsOffNoExt] = workspaceArgs('gemini', '/data/workspaces/s1', [], false);
  assert.deepEqual(JSON.parse(settingsOffNoExt), { notifications: true });

  assert.deepEqual(workspaceArgs('claude', '/data/workspaces/s1'), []);
  assert.deepEqual(workspaceArgs('grok', '/data/workspaces/s1'), []);
});

test('resolveTrustedPaths, trustClaudeFolders et trustGrokFolders : préservation, idempotence et cas limites', () => {
  const realRepo = join(root, 'real-repo');
  const subDir = join(realRepo, 'packages', 'web');
  const symRepo = join(root, 'sym-repo');
  mkdirSync(subDir, { recursive: true });
  symlinkSync(realRepo, symRepo, 'dir');

  const resolved = resolveTrustedPaths(join(symRepo, 'packages', 'web'), symRepo);
  assert.ok(resolved.includes(join(symRepo, 'packages', 'web')));
  assert.ok(resolved.includes(subDir));
  assert.ok(resolved.includes(symRepo));
  assert.ok(resolved.includes(realRepo));

  // Claude : création, fusion sans écraser les champs existants, idempotence, JSON corrompu ignoré.
  const claudeFile = join(root, 'claude-test.json');
  writeFileSync(
    claudeFile,
    JSON.stringify({
      numStartups: 12,
      projects: {
        '/existing': { allowedTools: ['Read'], hasTrustDialogAccepted: true },
        '/target': { allowedTools: ['Bash(git status)'], lastCost: 0.42 },
      },
    }),
  );
  trustClaudeFolders(['/target', '/brand-new'], claudeFile);
  const parsedClaude = JSON.parse(readFileSync(claudeFile, 'utf8'));
  assert.equal(parsedClaude.numStartups, 12);
  assert.deepEqual(parsedClaude.projects['/existing'], { allowedTools: ['Read'], hasTrustDialogAccepted: true });
  assert.deepEqual(parsedClaude.projects['/target'], {
    allowedTools: ['Bash(git status)'],
    lastCost: 0.42,
    hasTrustDialogAccepted: true,
  });
  assert.deepEqual(parsedClaude.projects['/brand-new'], { hasTrustDialogAccepted: true });

  const fixedTime = new Date('2025-01-01T00:00:00Z');
  utimesSync(claudeFile, fixedTime, fixedTime);
  trustClaudeFolders(['/target', '/brand-new'], claudeFile);
  assert.equal(statSync(claudeFile).mtimeMs, fixedTime.getTime());

  const badClaudeFile = join(root, 'claude-corrupt.json');
  writeFileSync(badClaudeFile, '{not valid json');
  trustClaudeFolders(['/x'], badClaudeFile);
  assert.equal(readFileSync(badClaudeFile, 'utf8'), '{not valid json');

  // Grok : création, bascule de trusted = false vers true, chemins avec crochets/espaces, idempotence.
  const grokFile = join(root, 'grok-trusted.toml');
  writeFileSync(
    grokFile,
    [
      '[folders."/already-trusted"]',
      'trusted = true',
      'decided_at = 1700000000',
      '',
      '[folders."/was-refused [v2]"]',
      'trusted = false',
      'decided_at = 1700000001',
      '',
    ].join('\n'),
  );
  trustGrokFolders(['/already-trusted', '/was-refused [v2]', '/fresh-dir'], grokFile, 1795000000);
  const grokContent = readFileSync(grokFile, 'utf8');
  assert.match(grokContent, /\[folders\."\/already-trusted"\]\ntrusted = true\ndecided_at = 1700000000/);
  assert.match(grokContent, /\[folders\."\/was-refused \[v2\]"\]\ntrusted = true\ndecided_at = 1795000000/);
  assert.match(grokContent, /\[folders\."\/fresh-dir"\]\ntrusted = true\ndecided_at = 1795000000/);

  utimesSync(grokFile, fixedTime, fixedTime);
  trustGrokFolders(['/already-trusted', '/was-refused [v2]', '/fresh-dir'], grokFile, 1799999999);
  assert.equal(statSync(grokFile).mtimeMs, fixedTime.getTime());
});

test('SessionManager.launch : respecte le réglage global trust_folders sur les 4 agents et les worktrees isolés', async () => {
  const db = new CerebroDatabase(':memory:');
  const repoDir = join(root, 'git-project');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['-C', repoDir, 'init', '-q']);
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test']);
  writeFileSync(join(repoDir, 'README.md'), '# test\n');
  execFileSync('git', ['-C', repoDir, 'add', 'README.md']);
  execFileSync('git', ['-C', repoDir, 'commit', '-q', '-m', 'init']);

  const project = db.createProject('Projet Git', repoDir, 'isolated');
  const mcpExt = db.createExtension({
    name: 'local-mcp',
    description: '',
    kind: 'mcp',
    transport: { type: 'stdio', command: 'node', args: ['srv.js'], env: {} },
  });

  const manager = new SessionManager(db, createServices(db));
  const capturedConfigs = new Map();

  mock.method(manager, 'spawnHolder', (configPath) => {
    capturedConfigs.set(configPath, JSON.parse(readFileSync(configPath, 'utf8')));
    const holder = new EventEmitter();
    holder.unref = () => {};
    holder.kill = () => true;
    setImmediate(() => holder.emit('spawn'));
    return holder;
  });
  mock.method(manager, 'connectOnce', async () => true);

  const claudeJsonPath = join(process.env.HOME, '.claude.json');
  const grokTomlPath = join(process.env.GROK_HOME, 'trusted_folders.toml');
  rmSync(claudeJsonPath, { force: true });
  rmSync(grokTomlPath, { force: true });

  // 1. Réglage désactivé : aucun fichier de confiance écrit, ni dossier de projet approuvé en CLI.
  db.setTrustFolders(false);
  for (const agent of ['claude', 'grok', 'codex', 'gemini']) {
    const s = await manager.create(project, {
      agent,
      mode: 'auto',
      model: null,
      effort: null,
      prompt: 'Bonjour',
    });
    const cfg = capturedConfigs.get(holderPaths(SESSIONS_DIR, s.id).config);
    assert.ok(cfg, `config capturée pour ${agent}`);
    if (agent === 'codex') {
      assert.ok(!cfg.args.some((arg) => arg.startsWith('projects=')), 'codex sans projects= quand désactivé');
    } else if (agent === 'gemini') {
      const idx = cfg.args.indexOf('--settings');
      assert.notEqual(idx, -1);
      assert.deepEqual(JSON.parse(cfg.args[idx + 1]), { notifications: true });
    }
    manager.finishSession(s.id, 0);
  }
  assert.equal(existsSync(claudeJsonPath), false);
  assert.equal(existsSync(grokTomlPath), false);

  // 2. Réglage activé : approbation automatique du worktree isolé pour les 4 agents (dont Grok avec extension MCP).
  db.setTrustFolders(true);
  for (const agent of ['claude', 'grok', 'codex', 'gemini']) {
    const s = await manager.create(
      project,
      {
        agent,
        mode: 'auto',
        model: null,
        effort: null,
        prompt: 'Bonjour',
      },
      agent === 'grok' ? { extensionIds: [mcpExt.id] } : {},
    );
    const cfg = capturedConfigs.get(holderPaths(SESSIONS_DIR, s.id).config);
    assert.ok(cfg);
    const worktreeCwd = cfg.cwd;
    assert.notEqual(worktreeCwd, repoDir);

    if (agent === 'claude') {
      const claudeState = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
      assert.equal(claudeState.projects[worktreeCwd]?.hasTrustDialogAccepted, true);
    } else if (agent === 'grok') {
      const grokToml = readFileSync(grokTomlPath, 'utf8');
      assert.ok(
        grokToml.includes(`[folders.${JSON.stringify(worktreeCwd)}]`),
        'worktree présent dans trusted_folders.toml',
      );
      // Vérifie que GROK_HOME isolé pointe bien vers trusted_folders.toml créé avant prepareSessionExtensions.
      const isolatedLink = join(sessionExtensionsDir(SESSIONS_DIR, s.id), 'grok-home', 'trusted_folders.toml');
      assert.equal(lstatSync(isolatedLink).isSymbolicLink(), true);
      assert.ok(readFileSync(isolatedLink, 'utf8').includes(`[folders.${JSON.stringify(worktreeCwd)}]`));
    } else if (agent === 'codex') {
      assert.ok(cfg.args.some((arg) => arg.includes(`${JSON.stringify(worktreeCwd)}={trust_level="trusted"}`)));
    } else if (agent === 'gemini') {
      const idx = cfg.args.indexOf('--settings');
      const settings = JSON.parse(cfg.args[idx + 1]);
      assert.ok(settings.trustedWorkspaces.includes(worktreeCwd));
    }
    manager.finishSession(s.id, 0);
  }

  db.close();
});
