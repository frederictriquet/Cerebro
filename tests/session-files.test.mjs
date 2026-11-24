import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

// [SPEC: Fonctions complémentaires › Serveur, fichiers du dossier de travail d'une session]
const root = mkdtempSync(join(tmpdir(), 'cerebro-session-files-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_BIND_TOKEN;
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
const { CerebroDatabase } = await import('../server/db.ts');
const { UpdateManager } = await import('../server/updates.ts');
const { PeerSync } = await import('../server/peers.ts');
const { buildServer } = await import('../server/index.ts');
const { listSessionFiles, readSessionFile, MAX_FILE_BYTES, MAX_WALKED_FILES } =
  await import('../server/session-files.ts');
mock.method(UpdateManager.prototype, 'start', () => {});
mock.method(PeerSync.prototype, 'sync', async function () {
  this.markReady();
  this.markSynced();
});
after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repository(name) {
  const repo = join(root, name);
  mkdirSync(join(repo, 'docs'), { recursive: true });
  git(repo, 'init', '-b', 'master');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  writeFileSync(join(repo, 'docs', 'guide.md'), '# Guide\n\nParagraphe.\n');
  writeFileSync(join(repo, '.env'), 'SECRET=1\n');
  git(repo, 'add', '.gitignore', 'docs/guide.md');
  writeFileSync(join(repo, 'notes.txt'), 'non suivi\n');
  return repo;
}

test('listing: tracked and untracked files, ignored ones excluded', async () => {
  const repo = repository('listing');
  assert.deepEqual(await listSessionFiles(repo), {
    files: ['.gitignore', 'docs/guide.md', 'notes.txt'],
    truncated: false,
  });
});

test('reading: content and version, then unchanged while the version matches', async () => {
  const repo = repository('reading');
  const first = await readSessionFile(repo, 'docs/guide.md');
  assert.equal(first.content, '# Guide\n\nParagraphe.\n');
  assert.match(first.version, /^[0-9a-f]{64}$/);
  assert.deepEqual(await readSessionFile(repo, 'docs/guide.md', first.version), {
    path: 'docs/guide.md',
    version: first.version,
    unchanged: true,
  });
  writeFileSync(join(repo, 'docs', 'guide.md'), '# Guide\n\nParagraphe corrigé.\n');
  const second = await readSessionFile(repo, 'docs/guide.md', first.version);
  assert.equal(second.content, '# Guide\n\nParagraphe corrigé.\n');
  assert.notEqual(second.version, first.version);
});

test('reading: paths outside the listing or the folder are refused', async () => {
  const repo = repository('refusals');
  writeFileSync(join(root, 'outside.txt'), 'hors du dossier\n');
  symlinkSync(join(root, 'outside.txt'), join(repo, 'escape.txt'));
  for (const path of ['.env', '../outside.txt', join(root, 'outside.txt'), 'docs/../.env', 'escape.txt', 'absent.md']) {
    await assert.rejects(readSessionFile(repo, path), (cause) => cause.statusCode === 404, path);
  }
});

test('reading: binary and oversized files are refused with an explicit message', async () => {
  const repo = repository('limits');
  writeFileSync(join(repo, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  writeFileSync(join(repo, 'big.txt'), 'a'.repeat(MAX_FILE_BYTES + 1));
  await assert.rejects(readSessionFile(repo, 'image.bin'), { statusCode: 415, message: /binaire/ });
  await assert.rejects(readSessionFile(repo, 'big.txt'), { statusCode: 413, message: /volumineux/ });
});

test('outside Git: a walk of the folder, hidden entries and node_modules skipped', async () => {
  const plain = join(root, 'plain');
  mkdirSync(join(plain, 'lettres', '.brouillons'), { recursive: true });
  mkdirSync(join(plain, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(plain, 'cv.md'), '# CV\n');
  writeFileSync(join(plain, 'lettres', 'offre.md'), 'Madame, Monsieur,\n');
  writeFileSync(join(plain, 'lettres', '.brouillons', 'v1.md'), 'brouillon\n');
  writeFileSync(join(plain, '.env'), 'SECRET=1\n');
  writeFileSync(join(plain, 'node_modules', 'x', 'index.js'), '\n');
  symlinkSync(join(plain, 'lettres'), join(plain, 'raccourci'));
  symlinkSync(join(plain, 'cv.md'), join(plain, 'cv-lien.md'));
  symlinkSync(join(root, 'outside.txt'), join(plain, 'dehors.txt'));
  writeFileSync(join(root, 'outside.txt'), 'hors du dossier\n');
  assert.deepEqual(await listSessionFiles(plain), {
    files: ['cv-lien.md', 'cv.md', 'dehors.txt', 'lettres/offre.md'],
    truncated: false,
  });
  assert.equal((await readSessionFile(plain, 'lettres/offre.md')).content, 'Madame, Monsieur,\n');
  assert.equal((await readSessionFile(plain, 'cv-lien.md')).content, '# CV\n');
  for (const path of [
    '.env',
    'lettres/.brouillons/v1.md',
    'node_modules/x/index.js',
    '../outside.txt',
    'dehors.txt',
    'lettres',
    'absent.md',
  ]) {
    await assert.rejects(readSessionFile(plain, path), (cause) => cause.statusCode === 404, path);
  }
});

test('outside Git: the walk stops at its bound and says so', async () => {
  const big = join(root, 'big');
  mkdirSync(big);
  for (let index = 0; index <= MAX_WALKED_FILES; index++) writeFileSync(join(big, `f${index}.txt`), '');
  const list = await listSessionFiles(big);
  assert.equal(list.files.length, MAX_WALKED_FILES);
  assert.equal(list.truncated, true);
});

test('routes: a session reads its isolated copy, and a removed copy is refused', async () => {
  const projectRepo = repository('project');
  const copy = repository('copy');
  writeFileSync(join(copy, 'docs', 'guide.md'), 'version de la copie\n');
  const app = await buildServer();
  const send = (url) => app.inject({ method: 'GET', url });
  const db = new CerebroDatabase();
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'P', path: projectRepo },
    });
    assert.equal(created.statusCode, 201);
    const project = created.json();
    const session = (id) =>
      db.createSession(
        {
          id,
          projectId: project.id,
          agent: 'claude',
          mode: 'auto',
          model: null,
          effort: null,
          prompt: '',
          title: id,
          status: 'exited',
          agentSessionId: null,
        },
        'token',
      );
    const shared = randomUUID();
    const isolated = randomUUID();
    const removed = randomUUID();
    for (const id of [shared, isolated, removed]) session(id);
    const workspace = (sessionId, extra = {}) =>
      db.connection.prepare('INSERT INTO session_workspaces (session_id, data) VALUES (?,?)').run(
        sessionId,
        JSON.stringify({
          sessionId,
          mode: 'isolated',
          path: copy,
          root: copy,
          source: projectRepo,
          base: null,
          branch: 'cerebro/copy',
          initialDirty: [],
          baseline: {},
          ...extra,
        }),
      );
    workspace(isolated);
    workspace(removed, { removedAt: Date.now() });

    const sharedFile = await send(`/api/sessions/${shared}/file?path=docs/guide.md`);
    assert.equal(sharedFile.statusCode, 200);
    assert.equal(sharedFile.json().content, '# Guide\n\nParagraphe.\n');

    assert.deepEqual((await send(`/api/sessions/${isolated}/files`)).json(), {
      files: ['.gitignore', 'docs/guide.md', 'notes.txt'],
      truncated: false,
    });
    assert.equal(
      (await send(`/api/sessions/${isolated}/file?path=docs%2Fguide.md`)).json().content,
      'version de la copie\n',
    );

    const gone = await send(`/api/sessions/${removed}/files`);
    assert.equal(gone.statusCode, 409);
    assert.match(gone.json().error, /copie de travail .* supprimée/);

    const secret = await send(`/api/sessions/${shared}/file?path=.env`);
    assert.equal(secret.statusCode, 404);
    assert.equal((await send(`/api/sessions/${shared}/file`)).statusCode, 400);
  } finally {
    db.close();
    await app.close();
  }
});

// [SPEC: Interface › Vue session desktop, panneau « Fichiers »]
const { appendToMessage, citation, fileLines, filterFiles, isMarkdown, EXCERPT_MAX } =
  await import('../web/src/session-files.ts');

test('citation: path, line range and one-line excerpt', () => {
  assert.equal(citation('docs/guide.md', 12, 12, 'Le paragraphe.'), 'docs/guide.md:L12 « Le paragraphe. »');
  assert.equal(
    citation('docs/guide.md', 14, 12, '  Première ligne\n\n  seconde\tligne\n'),
    'docs/guide.md:L12-L14 « Première ligne seconde ligne »',
  );
  const long = citation('a.md', 1, 1, 'é'.repeat(EXCERPT_MAX + 5));
  assert.equal(long, `a.md:L1 « ${'é'.repeat(EXCERPT_MAX)}… »`);
  assert.equal(citation('a.md', 3, 3, '   '), 'a.md:L3');
});

test('message field: the quote follows the draft after one space', () => {
  assert.equal(appendToMessage('', 'a.md:L1'), 'a.md:L1');
  assert.equal(appendToMessage('corrige  ', 'a.md:L1'), 'corrige a.md:L1');
});

test('file lines and search', () => {
  assert.deepEqual(fileLines('a\r\nb\n'), ['a', 'b']);
  assert.deepEqual(fileLines('a\n\nb'), ['a', '', 'b']);
  assert.deepEqual(fileLines(''), ['']);
  assert.deepEqual(filterFiles(['docs/Guide.md', 'server/x.ts'], ' guide '), ['docs/Guide.md']);
  assert.deepEqual(filterFiles(['a', 'b', 'c'], '', 2), ['a', 'b']);
});

test('Markdown files are rendered, other files shown as source', () => {
  assert.equal(isMarkdown('docs/Guide.MD'), true);
  assert.equal(isMarkdown('README.markdown'), true);
  assert.equal(isMarkdown('notes.mdx'), false);
  assert.equal(isMarkdown('server/x.ts'), false);
});
