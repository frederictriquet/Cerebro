import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import Fastify from 'fastify';

const { LOGGER_OPTIONS, redactText, redactUrl, serializeRequest } = await import('../server/log-redaction.ts');

test('redactUrl masque le paramètre token et conserve le reste', () => {
  assert.equal(redactUrl('/?token=s3cret'), '/?token=%5BREDACTED%5D');
  assert.equal(
    redactUrl('/ws/sessions/abc?cols=80&token=s3cret&rows=24'),
    '/ws/sessions/abc?cols=80&token=%5BREDACTED%5D&rows=24',
  );
  assert.equal(redactUrl('/?TOKEN=s3cret'), '/?TOKEN=%5BREDACTED%5D');
  assert.doesNotMatch(redactUrl('/?to%6Ben=s3cret'), /s3cret/);
  assert.equal(redactUrl('/api/sessions?project=a%20b'), '/api/sessions?project=a%20b');
  assert.equal(redactUrl('/api/sessions'), '/api/sessions');
});

test('redactUrl masque les jetons de l’éditeur VS Code', () => {
  assert.equal(redactUrl('/vscode/?tkn=s3cret&folder=%2Fhome'), '/vscode/?tkn=%5BREDACTED%5D&folder=%2Fhome');
  assert.equal(
    redactUrl('/m/mac/vscode/?tkn=s3cret&folder=%2Fhome'),
    '/m/mac/vscode/?tkn=%5BREDACTED%5D&folder=%2Fhome',
  );
  assert.equal(
    redactUrl('/vscode/stable-abc?reconnectionToken=s3cret&reconnection=false&skipWebSocketFrames=false'),
    '/vscode/stable-abc?reconnectionToken=%5BREDACTED%5D&reconnection=false&skipWebSocketFrames=false',
  );
});

test('redactText masque les jetons cités dans un message libre', () => {
  assert.equal(
    redactText('Reply was already sent, did you forget to "return reply" in the "/ws/x?a=1&token=s3cret" (GET) route?'),
    'Reply was already sent, did you forget to "return reply" in the "/ws/x?a=1&token=[REDACTED]" (GET) route?',
  );
  assert.equal(redactText('Route GET:/api/x?page=2 not found'), 'Route GET:/api/x?page=2 not found');
  assert.equal(
    redactText('Route GET:/vscode/?tkn=s3cret&folder=%2Fhome not found'),
    'Route GET:/vscode/?tkn=[REDACTED]&folder=%2Fhome not found',
  );
  assert.equal(
    redactText('Route GET:/m/mac/vscode/?tkn=s3cret&folder=%2Fhome not found'),
    'Route GET:/m/mac/vscode/?tkn=[REDACTED]&folder=%2Fhome not found',
  );
  assert.equal(
    redactText('"/vscode/x?reconnectionToken=s3cret&reconnection=true"'),
    '"/vscode/x?reconnectionToken=[REDACTED]&reconnection=true"',
  );
});

test('serializeRequest ne journalise aucun en-tête', () => {
  const serialized = serializeRequest({
    method: 'GET',
    url: '/ws/events?token=s3cret',
    headers: {
      'x-cerebro-token': 's3cret',
      authorization: 'Bearer s3cret',
      cookie: 'cerebro_token=s3cret',
      'accept-version': '1',
    },
    host: '127.0.0.1:4317',
    ip: '127.0.0.1',
    socket: { remotePort: 51000 },
  });
  assert.deepEqual(serialized, {
    method: 'GET',
    url: '/ws/events?token=%5BREDACTED%5D',
    version: '1',
    host: '127.0.0.1:4317',
    remoteAddress: '127.0.0.1',
    remotePort: 51000,
  });
});

test('les journaux Fastify ne contiennent pas le jeton', async () => {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const app = Fastify({ logger: { ...LOGGER_OPTIONS, stream } });
  app.get('/', async (request) => {
    request.log.info('vu %s', request.url);
    return 'ok';
  });
  await app.ready();
  const response = await app.inject({
    url: '/?token=s3cret',
    headers: { 'x-cerebro-token': 's3cret', authorization: 'Bearer s3cret', cookie: 'cerebro_token=s3cret' },
  });
  await app.close();
  assert.equal(response.statusCode, 200);
  const output = lines.join('');
  assert.match(output, /incoming request/);
  assert.match(output, /token=%5BREDACTED%5D/);
  assert.doesNotMatch(output, /s3cret/);
});

function captureLogger() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, app: Fastify({ logger: { ...LOGGER_OPTIONS, stream } }) };
}

test('les erreurs journalisées par Fastify ne contiennent pas le jeton', async () => {
  const { lines, app } = captureLogger();
  app.get('/ws/term/x', (_request, reply) => {
    reply.send('a');
    reply.send('b');
  });
  await app.ready();
  const response = await app.inject({ url: '/ws/term/x?cols=80&token=s3cret' });
  await app.close();
  assert.equal(response.statusCode, 200);
  const output = lines.join('');
  const warning = lines.map((line) => JSON.parse(line)).find((entry) => entry.err?.code === 'FST_ERR_REP_ALREADY_SENT');
  assert.ok(warning, output);
  assert.equal(warning.err.type, 'FastifyError');
  assert.match(warning.err.message, /\/ws\/term\/x\?cols=80&token=\[REDACTED\]/);
  assert.match(warning.err.stack, /token=\[REDACTED\]/);
  assert.doesNotMatch(output, /s3cret/);
});

test('les champs texte et les erreurs d’un objet journalisé sont masqués', async () => {
  const { lines, app } = captureLogger();
  await app.ready();
  const cause = new Error('cause /?tkn=s3cret');
  const error = new Error('échec /vscode/?reconnectionToken=s3cret', { cause });
  error.url = '/?token=s3cret';
  app.log.info(
    { path: '/?token=s3cret&x=1' },
    'closed incoming websocket connection for path with no websocket handler',
  );
  app.log.warn({ err: error, url: '/ws/x?token=s3cret', count: 2 });
  app.log.error(error);
  await app.close();
  const [ws, warn, err] = lines.map((line) => JSON.parse(line));
  assert.equal(ws.path, '/?token=[REDACTED]&x=1');
  assert.equal(warn.url, '/ws/x?token=[REDACTED]');
  assert.equal(warn.count, 2);
  assert.equal(warn.err.url, '/?token=[REDACTED]');
  assert.equal(err.msg, 'échec /vscode/?reconnectionToken=[REDACTED]');
  assert.equal(error.message, 'échec /vscode/?reconnectionToken=s3cret');
  assert.doesNotMatch(lines.join(''), /s3cret/);
});
