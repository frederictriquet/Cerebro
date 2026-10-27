import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { git, GitError, gitSync } from '../server/git.ts';

const root = mkdtempSync(join(tmpdir(), 'cerebro-git-'));
after(() => rmSync(root, { recursive: true, force: true }));
const raw = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture() {
  const repo = mkdtempSync(join(root, 'repo-'));
  raw(repo, 'init', '-b', 'main');
  raw(repo, 'config', 'user.name', 'Test');
  raw(repo, 'config', 'user.email', 'test@example.com');
  return repo;
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('décode l’UTF-8 une fois la sortie complète, même découpée en plusieurs morceaux', async () => {
  const repo = fixture();
  // Odd prefix so that 64 Kio chunk boundaries fall inside two-byte characters.
  const message = `x${'é'.repeat(300_000)}ü`;
  writeFileSync(join(repo, 'message'), message);
  raw(repo, 'commit', '--allow-empty', '--cleanup=verbatim', '-F', 'message');
  assert.equal(await git(repo, ['log', '-1', '--format=%B']), `${message}\n`);
  const bytes = await git(repo, ['log', '-1', '--format=%B'], { encoding: 'buffer' });
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.toString('utf8'), `${message}\n`);
});

test('applique l’environnement standard, l’index et l’entrée', async () => {
  const repo = fixture();
  const env = await git(
    repo,
    [
      '-c',
      'alias.env=!printf "%s|%s|%s|%s|%s" "$GIT_OPTIONAL_LOCKS" "$GIT_TERMINAL_PROMPT" "$GIT_MERGE_AUTOEDIT" "$LC_ALL" "$EXTRA"',
      'env',
    ],
    { env: { EXTRA: 'oui' } },
  );
  assert.equal(env, '0|0|no|C|oui');
  const oid = (await git(repo, ['hash-object', '-w', '--stdin'], { input: 'contenu\n' })).trim();
  const index = join(root, 'index-alternatif');
  await git(repo, ['update-index', '--add', '--cacheinfo', `100644,${oid},fichier`], { index });
  assert.equal(await git(repo, ['ls-files'], { index }), 'fichier\n');
  assert.equal(await git(repo, ['ls-files']), '');
});

test('rejette avec le code, la sortie et l’erreur de git', async () => {
  const repo = fixture();
  const failure = await git(repo, ['rev-parse', '--verify', 'introuvable']).catch((cause) => cause);
  assert.ok(failure instanceof GitError);
  assert.equal(failure.code, 128);
  assert.match(failure.stderr, /fatal/);
  assert.equal(failure.message, failure.stderr.trim());
  writeFileSync(join(root, 'a'), 'a\n');
  writeFileSync(join(root, 'b'), 'b\n');
  const diff = await git(repo, ['diff', '--no-index', '--', join(root, 'a'), join(root, 'b')]).catch((cause) => cause);
  assert.equal(diff.code, 1);
  assert.match(diff.stdout, /^\+b$/m);
});

test('tue le groupe de processus au-delà du délai', async () => {
  const repo = fixture();
  const pidFile = join(root, 'pid');
  const started = Date.now();
  const failure = await git(repo, ['-c', `alias.lent=!sh -c 'echo $$ > "${pidFile}"; exec sleep 30'`, 'lent'], {
    timeout: 300,
  }).catch((cause) => cause);
  assert.ok(failure instanceof GitError);
  assert.equal(failure.code, null);
  assert.match(failure.message, /interrompue après/);
  assert.ok(Date.now() - started < 5000);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(alive(pid), false, 'le petit-enfant lancé par git survit au délai');
});

test('interrompt une sortie trop volumineuse', async () => {
  const repo = fixture();
  const failure = await git(repo, ['-c', 'alias.gros=!head -c 300000 /dev/zero', 'gros'], { maxBuffer: 100_000 }).catch(
    (cause) => cause,
  );
  assert.ok(failure instanceof GitError);
  assert.match(failure.message, /trop volumineuse/);
});

test('variante synchrone', () => {
  const repo = fixture();
  raw(repo, 'commit', '--allow-empty', '-m', 'départ');
  assert.equal(gitSync(repo, ['rev-parse', '--verify', 'HEAD']).trim(), raw(repo, 'rev-parse', 'HEAD'));
  assert.throws(() => gitSync(repo, ['rev-parse', '--verify', 'introuvable']));
});
