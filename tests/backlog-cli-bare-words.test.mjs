import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';

// Un mot sans option (« list », une faute de frappe) ne doit jamais créer de tâche dans le backlog.
async function withRecordingServer(run) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body });
      response.writeHead(request.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.method === 'POST' ? { count: 1, epic: null, tasks: [] } : []));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    server.close();
  }
}

function runBacklog(args, url, input = '') {
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
    child.stdin.end(input);
  });
}

for (const args of [['list'], ['Une tâche'], ['--project', 'Cerebro', 'list'], ['a', 'b']]) {
  test(`cerebro-backlog ${args.join(' ')} est refusé sans rien envoyer`, () =>
    withRecordingServer(async (url, requests) => {
      const result = await runBacklog(args, url, 'ignoré\n');
      assert.equal(result.code, 1);
      assert.match(result.stderr, /ne crée aucune tâche/);
      assert.match(result.stderr, /--add/);
      assert.deepEqual(requests, []);
    }));
}

test('--add crée la tâche, comme l’entrée standard', () =>
  withRecordingServer(async (url, requests) => {
    assert.equal((await runBacklog(['--add', 'Tâche 1', 'Tâche 2'], url)).code, 0);
    assert.equal((await runBacklog([], url, 'Tâche 3\n---\nTâche 4\n')).code, 0);
    assert.deepEqual(
      requests.map((r) => [r.method, JSON.parse(r.body).tasks]),
      [
        ['POST', ['Tâche 1', 'Tâche 2']],
        ['POST', ['Tâche 3', 'Tâche 4']],
      ],
    );
  }));

test('--add sans tâche est refusé, et une option inconnue aussi', () =>
  withRecordingServer(async (url, requests) => {
    const none = await runBacklog(['--add'], url);
    assert.equal(none.code, 1);
    const unknown = await runBacklog(['--liste'], url);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /option inconnue/);
    assert.deepEqual(requests, []);
  }));

test('--list consulte sans rien créer', () =>
  withRecordingServer(async (url, requests) => {
    assert.equal((await runBacklog(['--list'], url)).code, 0);
    assert.ok(requests.length > 0 && requests.every((r) => r.method === 'GET'));
  }));
