import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const CLI = join(import.meta.dirname, '..', 'bin', 'cerebro-notify');

// Faux serveur Cerebro : la commande ne doit jamais joindre le vrai serveur ni Slack.
const received = [];
const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    received.push({
      method: request.method,
      url: request.url,
      token: request.headers['x-cerebro-token'],
      body: JSON.parse(body),
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, queued: false }));
  });
});
let url;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));
// Un test en échec ne laisse pas ses requêtes aux suivants.
beforeEach(() => {
  received.length = 0;
});

function runCli(args, { session = true, input } = {}) {
  const env = { ...process.env };
  for (const name of ['CEREBRO_SESSION_ID', 'CEREBRO_TOKEN', 'CEREBRO_URL']) delete env[name];
  if (session) Object.assign(env, { CEREBRO_SESSION_ID: 'notify-cli', CEREBRO_TOKEN: 'jeton', CEREBRO_URL: url });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("--help et -h affichent l'aide sans rien envoyer, où qu'ils soient et même hors session", async () => {
  for (const args of [
    ['--help'],
    ['-h'],
    ['--ask', '--help'],
    ['--help', 'texte'],
    ['voir', '-h'],
    ['--aks', '--help'],
  ]) {
    for (const session of [true, false]) {
      const { code, stdout, stderr } = await runCli(args, { session });
      assert.equal(code, 0, stderr);
      assert.match(stdout, /^Usage : cerebro-notify \[--ask\] \[--\] "texte"\n/, args.join(' '));
      assert.match(stdout, /--help, -h/);
    }
  }
  assert.deepEqual(received, []);
});

test('une option inconnue ou placée après le texte échoue sans rien envoyer', async () => {
  const cases = [
    [['--aks', 'Quel choix ?'], /option inconnue : --aks\. Rien n'est envoyé/],
    [['---ask', 'Quel choix ?'], /option inconnue : ---ask\./],
    [['--version'], /option inconnue : --version\./],
    [['-x'], /option inconnue : -x\./],
    [['--ask=Quel choix ?'], /option inconnue : --ask=Quel choix \?\./],
    [['voir', 'la', 'doc', '--verbose'], /option inconnue : --verbose\./],
    [['Quel choix ?', '--ask'], /--ask se place avant le texte\. Rien n'est envoyé/],
  ];
  for (const [args, message] of cases) {
    for (const session of [true, false]) {
      const { code, stdout, stderr } = await runCli(args, { session });
      assert.equal(code, 1, args.join(' '));
      assert.equal(stdout, '');
      assert.match(stderr, /^cerebro-notify : /);
      assert.match(stderr, message);
    }
  }
  assert.deepEqual(received, []);
});

test('le texte part tel quel : tirets ordinaires, après --, sur l’entrée standard', async () => {
  const cases = [
    { args: ['--ask', 'Quel', 'choix', '?'], body: { kind: 'ask', text: 'Quel choix ?' } },
    { args: ['Lance ls -la puis --help'], body: { kind: 'notify', text: 'Lance ls -la puis --help' } },
    {
      args: ['- point', '---', '->', '-3', '-', 'fin', '--', 'suite'],
      body: { kind: 'notify', text: '- point --- -> -3 - fin -- suite' },
    },
    { args: ['--', '--help'], body: { kind: 'notify', text: '--help' } },
    { args: ['--ask', '--', '-h', 'voir', '--aks'], body: { kind: 'ask', text: '-h voir --aks' } },
    { args: [], input: '--help\n', body: { kind: 'notify', text: '--help' } },
    { args: ['--ask'], input: '  --version -x \n', body: { kind: 'ask', text: '--version -x' } },
  ];
  for (const { args, input, body } of cases) {
    const { code, stdout, stderr } = await runCli(args, { input });
    assert.equal(code, 0, stderr);
    assert.match(stdout, body.kind === 'ask' ? /^Question : envoyé sur Slack\./ : /^Message envoyé sur Slack\.\n$/);
    assert.deepEqual(received.shift(), { method: 'POST', url: '/api/notify/notify-cli', token: 'jeton', body });
  }
  assert.deepEqual(received, []);
});

test('hors session, un envoi échoue toujours', async () => {
  const { code, stdout, stderr } = await runCli(['Bonjour'], { session: false });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.equal(stderr, 'cerebro-notify : uniquement dans une session Cerebro\n');
  assert.deepEqual(received, []);
});
