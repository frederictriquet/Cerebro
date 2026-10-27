import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runHeadless } from '../server/headless.ts';

test('headless spawns strip server secrets and retain CLI authentication in both access modes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cerebro-headless-env-'));
  const bin = join(directory, 'bin');
  const project = join(directory, 'project');
  const capture = join(directory, 'capture.json');
  const credentials = {
    claude: { ANTHROPIC_API_KEY: 'anthropic-key-sentinel', ANTHROPIC_AUTH_TOKEN: 'anthropic-token-sentinel' },
    codex: { OPENAI_API_KEY: 'openai-key-sentinel' },
    grok: { XAI_API_KEY: 'xai-key-sentinel' },
  };
  const injected = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: directory,
    CODEX_HOME: join(directory, 'codex'),
    CEREBRO_SESSION_ID: 'session-sentinel',
    CEREBRO_TOKEN: 'session-token-sentinel',
    CEREBRO_URL: 'http://cerebro.invalid',
    CEREBRO_BIND_TOKEN: 'bind-token-sentinel',
    CEREBRO_SLACK_TOKEN: 'slack-token-sentinel',
    CEREBRO_SLACK_APP_TOKEN: 'slack-app-token-sentinel',
    CEREBRO_SLACK_SIGNING_SECRET: 'slack-signing-secret-sentinel',
    CEREBRO_SLACK_USER: 'slack-user-sentinel',
    CEREBRO_DATA_DIR: 'server-data-sentinel',
    CEREBRO_FUTURE_SECRET: 'future-secret-sentinel',
    CLAUDECODE: 'nested-session-sentinel',
    ...Object.assign({}, ...Object.values(credentials)),
  };
  const previous = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]));
  try {
    await mkdir(bin);
    await mkdir(project);
    const script = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const args = process.argv.slice(2);
readFileSync(0, 'utf8');
const keys = ${JSON.stringify(Object.fromEntries(Object.entries(credentials).map(([agent, values]) => [agent, Object.keys(values)])))}[basename(process.argv[1])];
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args, leaked: Object.keys(process.env).filter(key => key.startsWith('CEREBRO_') || key === 'CLAUDECODE'),
  credentials: Object.fromEntries(keys.map(key => [key, process.env[key]])),
  PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME,
}));
const result = { answer: 'ok' };
if (args[0] === 'exec') writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result));
else console.log(JSON.stringify(result));
`;
    for (const agent of Object.keys(credentials)) await writeFile(join(bin, agent), script, { mode: 0o755 });
    Object.assign(process.env, injected);
    for (const [agent, authentication] of Object.entries(credentials)) {
      for (const access of ['none', 'read-only']) {
        await t.test(`${agent} / ${access}`, async () => {
          const result = await runHeadless({
            agent,
            model: null,
            effort: null,
            prompt: 'Answer ok.',
            cwd: project,
            access,
            schema: {
              type: 'object',
              required: ['answer'],
              properties: { answer: { type: 'string' } },
              additionalProperties: false,
            },
            timeoutMs: 10_000,
            signal: new AbortController().signal,
          });
          assert.deepEqual(result, { answer: 'ok' });
          const received = JSON.parse(await readFile(capture, 'utf8'));
          assert.deepEqual(received.leaked, [], 'Server variables must never reach the spawned CLI.');
          assert.deepEqual(received.credentials, authentication);
          for (const key of ['PATH', 'HOME', 'CODEX_HOME']) assert.equal(received[key], injected[key]);
          if (agent === 'codex' && access === 'read-only') assert.ok(!received.args.includes('shell_tool'));
          if (agent === 'codex')
            for (const flag of ['--ignore-user-config', '--ignore-rules'])
              assert.ok(received.args.includes(flag), 'Codex must load neither user nor project MCP servers.');
          for (const [key, value] of Object.entries(injected))
            assert.equal(process.env[key], value, 'The server environment must stay intact.');
        });
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
