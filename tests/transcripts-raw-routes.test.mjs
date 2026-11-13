import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-transcripts-raw-'));
const claudeDir = join(root, 'claude');
const outsideDir = join(root, 'outside');
mkdirSync(claudeDir, { recursive: true });
mkdirSync(outsideDir, { recursive: true });

process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.GROK_HOME = join(root, 'grok');
process.env.CEREBRO_BIND_TOKEN = 'jeton-test-transcripts';
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
delete process.env.CEREBRO_SLACK_USER_TOKEN;
mkdirSync(process.env.CEREBRO_DATA_DIR, { recursive: true });

const { PeerSync } = await import('../server/peers.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { buildServer } = await import('../server/index.ts');

mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});

const TOKEN = 'jeton-test-transcripts';
const AUTH = { authorization: `Bearer ${TOKEN}` };

let app;
let baseUrl;

before(async () => {
  app = await buildServer();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (app) await app.close();
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

test('contrôle d’accès identique à /api/sessions', async () => {
  for (const url of ['/api/sessions', '/api/transcripts', '/api/transcripts/file?path=proj/a.jsonl']) {
    const noAuth = await app.inject({ method: 'GET', url });
    assert.equal(noAuth.statusCode, 401, `sans jeton : ${url}`);

    const wrongBearer = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer mauvais-jeton', 'x-cerebro-token': 'jeton-de-hook' },
    });
    assert.equal(wrongBearer.statusCode, 401, `mauvais jeton : ${url}`);
  }

  const withBearer = await app.inject({ method: 'GET', url: '/api/transcripts', headers: AUTH });
  assert.equal(withBearer.statusCode, 200);
  assert.deepEqual(withBearer.json(), []);

  const withQuery = await app.inject({
    method: 'GET',
    url: `/api/transcripts?token=${encodeURIComponent(TOKEN)}`,
  });
  assert.equal(withQuery.statusCode, 200);

  const withCookie = await app.inject({
    method: 'GET',
    url: '/api/transcripts',
    headers: { cookie: `cerebro_token=${encodeURIComponent(TOKEN)}` },
  });
  assert.equal(withCookie.statusCode, 200);
});

test('racine projects absente : liste vide, 404 dans la racine et 400 hors racine', async () => {
  const listRes = await app.inject({ method: 'GET', url: '/api/transcripts', headers: AUTH });
  assert.equal(listRes.statusCode, 200);
  assert.deepEqual(listRes.json(), []);

  const missingInRoot = await app.inject({
    method: 'GET',
    url: '/api/transcripts/file?path=-proj/inexistant.jsonl',
    headers: AUTH,
  });
  assert.equal(missingInRoot.statusCode, 404);

  const traversalWhenMissing = await app.inject({
    method: 'GET',
    url: '/api/transcripts/file?path=../secret.jsonl',
    headers: AUTH,
  });
  assert.equal(traversalWhenMissing.statusCode, 400);
});

test('liste les sessions principales et sous-agents, ignore le reste et sert le flux identique au disque', async () => {
  const projectsDir = join(claudeDir, 'projects');
  const projA = join(projectsDir, '-Users-mac-Cerebro');
  const subagentsDir = join(projA, 'sess-principale', 'subagents');
  const projB = join(projectsDir, '-Users-mac-Autre');
  mkdirSync(subagentsDir, { recursive: true });
  mkdirSync(projB, { recursive: true });

  // Contenu brut réaliste : usage.iterations, tool_use, tool_result, hook_additional_context, > 128 Kio pour forcer plusieurs chunks.
  const mainLines = [
    JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: 'Calcule les métriques hebdomadaires (été / accents / 🚀)' },
      attachment: { type: 'hook_additional_context', content: 'Contexte injecté par hook' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a-1',
      message: {
        id: 'msg_01',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls -la' } }],
        usage: {
          input_tokens: 1200,
          output_tokens: 85,
          cache_read_input_tokens: 4000,
          iterations: [{ type: 'advisor_message', input_tokens: 900, output_tokens: 210 }],
        },
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u-2',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'sortie brute '.repeat(12_000) }],
      },
    }),
  ].join('\n');

  const subagentContent = `${JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    message: {
      id: 'msg_sub',
      role: 'assistant',
      content: 'exploration',
      usage: { input_tokens: 300, output_tokens: 40 },
    },
  })}\n`;

  const orphanContent = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hors Cerebro' } })}\n`;

  const mainFile = join(projA, 'sess-principale.jsonl');
  const subagentFile = join(subagentsDir, 'agent-explore-1.jsonl');
  const orphanFile = join(projB, 'sess-hors-cerebro.jsonl');

  writeFileSync(mainFile, mainLines, 'utf8'); // volontairement sans retour final pour vérifier l'exactitude octet par octet
  writeFileSync(subagentFile, subagentContent, 'utf8');
  writeFileSync(orphanFile, orphanContent, 'utf8');

  const fixedDate = new Date('2026-11-10T08:30:00.000Z');
  utimesSync(mainFile, fixedDate, fixedDate);

  // Éléments qui ne doivent PAS apparaître dans la liste.
  writeFileSync(join(projA, 'sessions-index.json'), '{"sessions":[]}', 'utf8');
  mkdirSync(join(projA, 'dossier.jsonl'), { recursive: true });
  const outsideSecret = join(outsideDir, 'secret.jsonl');
  writeFileSync(outsideSecret, '{"secret":"ne-jamais-servir"}\n', 'utf8');
  symlinkSync(outsideSecret, join(projA, 'fuite.jsonl'));
  symlinkSync(outsideDir, join(projectsDir, 'lien-externe'));
  symlinkSync(join(projA, 'sessions-index.json'), join(projA, 'faux-jsonl.jsonl'));

  const listRes = await fetch(`${baseUrl}/api/transcripts`, { headers: AUTH });
  assert.equal(listRes.status, 200);
  const items = await listRes.json();

  assert.deepEqual(
    items.map((item) => item.path),
    [
      '-Users-mac-Autre/sess-hors-cerebro.jsonl',
      '-Users-mac-Cerebro/sess-principale.jsonl',
      '-Users-mac-Cerebro/sess-principale/subagents/agent-explore-1.jsonl',
    ],
  );

  const mainEntry = items.find((item) => item.path === '-Users-mac-Cerebro/sess-principale.jsonl');
  assert.equal(mainEntry.size, statSync(mainFile).size);
  assert.equal(mainEntry.mtimeMs, Math.trunc(statSync(mainFile).mtimeMs));
  assert.equal(mainEntry.mtimeMs, fixedDate.getTime());

  // Chaque fichier listé est servi en flux HTTP strictement identique aux octets sur disque.
  for (const [relPath, diskPath] of [
    ['-Users-mac-Cerebro/sess-principale.jsonl', mainFile],
    ['-Users-mac-Cerebro/sess-principale/subagents/agent-explore-1.jsonl', subagentFile],
    ['-Users-mac-Autre/sess-hors-cerebro.jsonl', orphanFile],
  ]) {
    const fileRes = await fetch(`${baseUrl}/api/transcripts/file?path=${encodeURIComponent(relPath)}`, {
      headers: AUTH,
    });
    assert.equal(fileRes.status, 200, relPath);
    assert.match(fileRes.headers.get('content-type') ?? '', /^application\/x-ndjson/);
    const served = Buffer.from(await fileRes.arrayBuffer());
    const expected = readFileSync(diskPath);
    assert.equal(Buffer.compare(served, expected), 0, `contenu différent pour ${relPath}`);
  }
});

test('refuse en 400 les chemins absolus, hors racine, liens sortants ou non .jsonl', async () => {
  const outsideSecret = join(outsideDir, 'secret.jsonl');
  const projectsDir = join(claudeDir, 'projects');
  symlinkSync(join(outsideDir, 'absent.jsonl'), join(projectsDir, 'lien-casse-externe.jsonl'));

  const badPaths = [
    '',
    '/etc/passwd',
    '/etc/passwd.jsonl',
    outsideSecret,
    '../secret.jsonl',
    '../../outside/secret.jsonl',
    '-Users-mac-Cerebro/../../secret.jsonl',
    '-Users-mac-Cerebro/../../../outside/secret.jsonl',
    './-Users-mac-Cerebro/sess-principale.jsonl',
    '-Users-mac-Cerebro//sess-principale.jsonl',
    '..\\secret.jsonl',
    '-Users-mac-Cerebro\\sess-principale.jsonl',
    'C:/outside/secret.jsonl',
    '-Users-mac-Cerebro/sessions-index.json',
    '-Users-mac-Cerebro/sess-principale.jsonl.bak',
    '-Users-mac-Cerebro/.jsonl',
    '-Users-mac-Cerebro/dossier.jsonl',
    '-Users-mac-Cerebro/fuite.jsonl',
    'lien-externe/secret.jsonl',
    'lien-casse-externe.jsonl',
    '-Users-mac-Cerebro/faux-jsonl.jsonl',
  ];

  for (const bad of badPaths) {
    const res = await fetch(`${baseUrl}/api/transcripts/file?path=${encodeURIComponent(bad)}`, { headers: AUTH });
    const body = await res.text();
    assert.equal(res.status, 400, `attendu 400 pour path=${JSON.stringify(bad)}, reçu ${res.status} (${body})`);
    assert.ok(!body.includes('ne-jamais-servir'), `fuite du secret pour ${bad}`);
  }

  // Paramètre path absent, encodé %2e%2e%2f ou répété.
  for (const rawQuery of ['', '?path=%2e%2e%2fsecret.jsonl', '?path=a.jsonl&path=b.jsonl']) {
    const res = await fetch(`${baseUrl}/api/transcripts/file${rawQuery}`, { headers: AUTH });
    assert.equal(res.status, 400, `attendu 400 pour query=${rawQuery}`);
  }

  // Un chemin .jsonl valide mais absent sous projects répond 404 (et non 400 ou 500).
  const notFound = await fetch(`${baseUrl}/api/transcripts/file?path=-Users-mac-Cerebro/introuvable.jsonl`, {
    headers: AUTH,
  });
  assert.equal(notFound.status, 404);
});

test('gère une racine projects derrière un lien symbolique (cas macOS /var -> /private/var) et bloque un dossier frère préfixé', async () => {
  const realStore = join(root, 'private-var', 'projects');
  const siblingEvil = join(root, 'private-var', 'projects-evil');
  mkdirSync(join(realStore, '-Users-mac-App', 'sess-1', 'subagents'), { recursive: true });
  mkdirSync(siblingEvil, { recursive: true });

  const subFile = join(realStore, '-Users-mac-App', 'sess-1', 'subagents', 'agent-mac.jsonl');
  const expected = Buffer.from('{"type":"assistant","message":{"role":"assistant","content":"mac"}}\n', 'utf8');
  writeFileSync(subFile, expected);

  const evilFile = join(siblingEvil, 'piege.jsonl');
  writeFileSync(evilFile, '{"secret":"prefix-collision"}\n', 'utf8');
  symlinkSync(evilFile, join(realStore, '-Users-mac-App', 'collision.jsonl'));

  const symlinkedClaude = join(root, 'claude-symlinked');
  mkdirSync(symlinkedClaude, { recursive: true });
  symlinkSync(realStore, join(symlinkedClaude, 'projects'));

  const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = symlinkedClaude;
  try {
    const listRes = await fetch(`${baseUrl}/api/transcripts`, { headers: AUTH });
    assert.equal(listRes.status, 200);
    const items = await listRes.json();
    assert.deepEqual(
      items.map((item) => item.path),
      ['-Users-mac-App/sess-1/subagents/agent-mac.jsonl'],
    );

    const okRes = await fetch(
      `${baseUrl}/api/transcripts/file?path=${encodeURIComponent('-Users-mac-App/sess-1/subagents/agent-mac.jsonl')}`,
      { headers: AUTH },
    );
    assert.equal(okRes.status, 200);
    assert.equal(Buffer.compare(Buffer.from(await okRes.arrayBuffer()), expected), 0);

    const collisionRes = await fetch(
      `${baseUrl}/api/transcripts/file?path=${encodeURIComponent('-Users-mac-App/collision.jsonl')}`,
      { headers: AUTH },
    );
    assert.equal(collisionRes.status, 400);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
  }
});
