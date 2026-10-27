import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['answer'],
  properties: { answer: { type: 'string' } },
};
const answer = { answer: 'Lecture isolée.' };

// Opt in to exercise the installed CLI, with a disposable CODEX_HOME and a local API (no real credentials or inference).
test(
  'real Codex CLI starts no MCP server, even from an approved project, in headless mode',
  {
    skip: process.env.CEREBRO_TEST_CODEX !== '1' && 'Run with CEREBRO_TEST_CODEX=1 and the Codex CLI installed.',
    timeout: 180_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cerebro-codex-mcp-'));
    const project = join(directory, 'project');
    const home = join(directory, 'home');
    const codexHome = join(home, '.codex');
    const markers = join(directory, 'markers');
    const requests = [];
    const server = createServer(async (request, response) => {
      let text = '';
      for await (const chunk of request) text += chunk;
      // Refuse the websocket transport: Codex falls back to the streamed HTTP endpoint below.
      if (request.method !== 'POST' || !request.url.endsWith('/responses')) {
        response.writeHead(404);
        response.end();
        return;
      }
      requests.push({ model: JSON.parse(text).model, authorization: request.headers.authorization });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const item = {
        type: 'message',
        role: 'assistant',
        id: 'msg_fixture',
        status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(answer), annotations: [] }],
      };
      event('response.created', { response: { id: 'resp_fixture' } });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', {
        response: {
          id: 'resp_fixture',
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
            total_tokens: 2,
          },
        },
      });
      response.end();
    });
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      await mkdir(codexHome, { recursive: true });
      await mkdir(join(project, '.codex'), { recursive: true });
      await mkdir(markers);
      await exec('git', ['init', '-q', project]);
      const sentinel = (name) =>
        `command = "sh"\nargs = ["-c", ${JSON.stringify(`touch '${join(markers, name)}'; sleep 30`)}]\n`;
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-cerebro-test' }),
      );
      await writeFile(
        join(codexHome, 'config.toml'),
        [
          `openai_base_url = ${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)}`,
          'model = "gpt-cerebro-test"',
          '',
          `[projects.${JSON.stringify(project)}]`,
          'trust_level = "trusted"',
          '',
          '[mcp_servers.user_sentinel]',
          sentinel('user'),
        ].join('\n'),
      );
      await writeFile(join(project, '.codex', 'config.toml'), `[mcp_servers.project_sentinel]\n${sentinel('project')}`);
      const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome };
      const childOptions = { cwd: project, env, timeout: 60_000 };
      await writeFile(join(directory, 'schema.json'), JSON.stringify(schema));

      // Positive control: disabling the user's MCP servers one by one leaves the approved project's server running.
      const control = execFile(
        'codex',
        [
          'exec',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '-c',
          'approval_policy="never"',
          '-c',
          'mcp_servers.user_sentinel.enabled=false',
          '--output-schema',
          join(directory, 'schema.json'),
          '--output-last-message',
          join(directory, 'control.json'),
          '--json',
          '-',
        ],
        childOptions,
      );
      control.stdin.end('Réponds au format demandé.');
      await new Promise((resolve, reject) =>
        control.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`codex: code ${code}`)))),
      );
      assert.deepEqual(JSON.parse(await readFile(join(directory, 'control.json'), 'utf8')), answer);
      assert.deepEqual(await readdir(markers), ['project']);
      assert.ok(requests.length > 0);
      await rm(join(markers, 'project'));

      const moduleUrl = new URL('../server/headless.ts', import.meta.url).href;
      for (const access of ['read-only', 'none']) {
        requests.length = 0;
        const options = {
          agent: 'codex',
          model: null,
          effort: null,
          prompt: 'Réponds au format demandé.',
          schema,
          cwd: project,
          access,
          timeoutMs: 60_000,
        };
        const script = `import { runHeadless } from ${JSON.stringify(moduleUrl)};
        console.log(JSON.stringify(await runHeadless({ ...${JSON.stringify(options)}, signal: new AbortController().signal })));`;
        const result = await exec(
          process.execPath,
          ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', script],
          childOptions,
        );
        assert.deepEqual(JSON.parse(result.stdout), answer);
        assert.deepEqual(await readdir(markers), [], `No MCP server may start (${access}).`);
        assert.ok(requests.length > 0);
        assert.ok(
          requests.every(
            (request) => request.model === 'gpt-cerebro-test' && request.authorization === 'Bearer sk-cerebro-test',
          ),
          'Keep the user default model and the CODEX_HOME authentication.',
        );
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
