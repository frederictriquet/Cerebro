import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';

async function withServer(responses, run) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const path = request.url.replace(/^\/api\/backlog\/source/, '').split('?')[0];
      requests.push({ method: request.method, path, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responses[`${request.method} ${path}`] ?? []));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    server.close();
  }
}

function runBacklog(args, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/cerebro-backlog', ...args], {
      env: { ...process.env, CEREBRO_SESSION_ID: 'source', CEREBRO_TOKEN: 'test', CEREBRO_URL: url },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end('');
  });
}

test('--claim envoie les identifiants et affiche ce qui est rattaché', () =>
  withServer(
    {
      'POST /claim': { claimed: [{ id: 't1', text: 'Titre un\ndétail', epicId: null }], already: ['t2'] },
      'POST /release': { released: [{ id: 't1', text: 'Titre un' }] },
    },
    async (url, requests) => {
      const claim = await runBacklog(['--claim', 't1', 'e1', 't2'], url);
      assert.equal(claim.code, 0);
      assert.match(claim.stdout, /1 tâche\(s\) rattachée\(s\)/);
      assert.match(claim.stdout, /t1 {2}Titre un/);
      assert.doesNotMatch(claim.stdout, /détail/);
      assert.match(claim.stdout, /Déjà rattachée\(s\) : t2/);
      assert.deepEqual(JSON.parse(requests[0].body), { ids: ['t1', 'e1', 't2'] });

      const release = await runBacklog(['--release', 't1'], url);
      assert.equal(release.code, 0);
      assert.match(release.stdout, /1 tâche\(s\) rendue\(s\)/);
      assert.equal((await runBacklog(['--claim'], url)).code, 1);
      assert.equal((await runBacklog(['--project', 'X', '--claim', 't1'], url)).code, 1);
    },
  ));

test('--list --full montre le texte complet, --list seul le titre', () =>
  withServer(
    {
      'GET ': [
        {
          id: 't1',
          status: 'todo',
          text: 'Titre\nligne de détail',
          dependsOn: [],
          epicId: null,
          mine: false,
          assigned: false,
        },
      ],
      'GET /epics': [{ id: 'e1', title: 'Epic', description: 'Contexte\nsuite', mine: false, tasks: ['t1'] }],
    },
    async (url) => {
      const short = await runBacklog(['--list'], url);
      assert.doesNotMatch(short.stdout, /ligne de détail/);
      const full = await runBacklog(['--list', '--full'], url);
      assert.match(full.stdout, /\| ligne de détail/);
      const epics = await runBacklog(['--epics', '--full'], url);
      assert.match(epics.stdout, /\| suite/);
      assert.doesNotMatch((await runBacklog(['--epics'], url)).stdout, /suite/);
    },
  ));
