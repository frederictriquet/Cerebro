import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const schema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
const answer = { answer: 'Lecture isolée.' };

// Opt in to exercise the installed CLI, with disposable settings and a local API (no real credentials or inference).
test('real Claude CLI ignores project/local settings and all startup hooks in headless mode', {
  skip: process.env.CEREBRO_TEST_CLAUDE !== '1' && 'Run with CEREBRO_TEST_CLAUDE=1 and the Claude CLI installed.',
  timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cerebro-claude-hooks-'));
  const project = join(directory, 'project');
  const home = join(directory, 'home');
  const config = join(home, '.claude');
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    if (!request.url.includes('/messages') || request.url.includes('count_tokens')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    requests.push({ path: request.url, apiKey: request.headers['x-api-key'] });
    const structured = body.tools?.some((tool) => tool.name === 'StructuredOutput');
    const block = structured
      ? { type: 'tool_use', id: 'toolu_fixture', name: 'StructuredOutput', input: answer }
      : { type: 'text', text: JSON.stringify(answer) };
    const message = {
      id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [block],
      stop_reason: structured ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 10 },
    };
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(message));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: structured ? { ...block, input: {} } : { ...block, text: '' } });
    event('content_block_delta', { index: 0, delta: structured ? { type: 'input_json_delta', partial_json: JSON.stringify(answer) } : { type: 'text_delta', text: block.text } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
    event('message_stop', {});
    response.end();
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await mkdir(config, { recursive: true });
    await mkdir(join(project, '.claude'), { recursive: true });
    const url = `http://127.0.0.1:${server.address().port}`;
    const markers = [];
    for (const [scope, filename] of [
      ['user', join(config, 'settings.json')],
      ['project', join(project, '.claude', 'settings.json')],
      ['local', join(project, '.claude', 'settings.local.json')],
    ]) {
      const hooks = {};
      for (const event of ['SessionStart', 'UserPromptSubmit']) {
        const marker = `${scope}-${event}`;
        markers.push(marker);
        hooks[event] = [{ hooks: [{ type: 'command', command: `touch '${marker}'` }] }];
      }
      await writeFile(filename, JSON.stringify({ disableAllHooks: false, hooks, env: {
        ANTHROPIC_API_KEY: `${scope}-test-key`, ANTHROPIC_BASE_URL: `${url}/${scope}`,
      } }));
    }
    const env = {
      PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: config,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
      // An unusable default endpoint prevents an accidental real API call if settings stop loading.
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    };
    const childOptions = { cwd: project, env, timeout: 25_000 };
    // Positive control: the previous tool restrictions allow all six hooks to execute before inference.
    const control = await exec('claude', [
      '--print', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--tools', 'Read,Glob,Grep',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk',
      '--no-session-persistence', '--disable-slash-commands', '--max-turns', '3', 'Réponds au format demandé.',
    ], childOptions);
    assert.deepEqual(JSON.parse(control.stdout).structured_output, answer);
    assert.deepEqual((await readdir(project)).sort(), ['.claude', ...markers].sort());
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => request.path.startsWith('/local/') && request.apiKey === 'local-test-key'));
    for (const marker of markers) await rm(join(project, marker));

    const moduleUrl = new URL('../server/headless.ts', import.meta.url).href;
    for (const access of ['read-only', 'none']) {
      requests.length = 0;
      const options = { agent: 'claude', model: null, effort: null, prompt: 'Réponds au format demandé.', schema, cwd: project, access, timeoutMs: 15_000 };
      const script = `import { runHeadless } from ${JSON.stringify(moduleUrl)};
        console.log(JSON.stringify(await runHeadless({ ...${JSON.stringify(options)}, signal: new AbortController().signal })));`;
      const result = await exec(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', script], childOptions);
      assert.deepEqual(JSON.parse(result.stdout), answer);
      assert.deepEqual(await readdir(project), ['.claude'], 'No startup hook may write a marker.');
      assert.ok(requests.length > 0);
      assert.ok(requests.every((request) => request.path.startsWith('/user/') && request.apiKey === 'user-test-key'), 'Keep user authentication and exclude project/local environment settings.');
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
