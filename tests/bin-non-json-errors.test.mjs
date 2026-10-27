import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

// A reverse proxy (502 HTML page) or a raw 413 must surface as an HTTP status, not a JSON parse error.
async function withServer(status, contentType, body, run) {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(status, { 'content-type': contentType });
      response.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function runBin(bin, args, url, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, CEREBRO_SESSION_ID: 'source', CEREBRO_TOKEN: 'test', CEREBRO_URL: url },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const cases = [
  { bin: 'bin/cerebro-tasks', args: ['list'], input: '' },
  { bin: 'bin/cerebro-tasks', args: ['add', 'Titre'], input: '' },
  { bin: 'bin/cerebro-findings', args: [], input: JSON.stringify({ findings: [] }) },
];

for (const { bin, args, input } of cases) {
  test(`${bin} ${args.join(' ')} reports the HTTP status of a non-JSON error`, async () => {
    for (const [status, type, body] of [
      [502, 'text/html', '<html><body>Bad Gateway</body></html>'],
      [413, 'text/plain', 'Payload Too Large'],
    ]) {
      const result = await withServer(status, type, body, (url) => runBin(bin, args, url, input));
      assert.equal(result.code, 1);
      assert.equal(result.stderr.trim(), `Erreur HTTP ${status}`);
    }
  });

  test(`${bin} ${args.join(' ')} keeps the server's JSON error message`, async () => {
    const result = await withServer(400, 'application/json', JSON.stringify({ error: 'Requête refusée.' }), (url) =>
      runBin(bin, args, url, input),
    );
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), 'Requête refusée.');
  });

  test(`${bin} ${args.join(' ')} rejects a successful but unreadable response`, async () => {
    const result = await withServer(200, 'text/html', '<html></html>', (url) => runBin(bin, args, url, input));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Réponse illisible du serveur \(HTTP 200\)/);
    assert.doesNotMatch(result.stderr, /Unexpected token/);
  });
}
