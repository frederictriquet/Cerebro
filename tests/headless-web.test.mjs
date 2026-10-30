import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runHeadless } from '../server/headless.ts';

const schema = {
  type: 'object',
  required: ['answer'],
  properties: { answer: { type: 'string' } },
  additionalProperties: false,
};

// Fake CLIs that record their arguments, then answer like the real ones would.
const script = (capture) => `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args));
if (args[0] === 'exec') writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ answer: 'ok' }));
else console.log(JSON.stringify({ answer: 'ok' }));
`;

test('headless: web access enables each CLI web tools, alone or with project reads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cerebro-headless-web-'));
  const bin = join(directory, 'bin');
  const capture = join(directory, 'capture.json');
  const previousPath = process.env.PATH;
  try {
    await mkdir(bin);
    for (const agent of ['claude', 'codex', 'grok'])
      await writeFile(join(bin, agent), script(capture), { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath}`;
    const run = async (agent, access, web) => {
      assert.deepEqual(
        await runHeadless({
          agent,
          model: null,
          effort: null,
          prompt: 'Q ?',
          schema,
          access,
          ...(web === undefined ? {} : { web }),
          timeoutMs: 10_000,
          signal: new AbortController().signal,
        }),
        { answer: 'ok' },
      );
      return JSON.parse(await readFile(capture, 'utf8'));
    };
    const after = (args, flag) => args[args.indexOf(flag) + 1];

    await t.test('claude', async () => {
      let args = await run('claude', 'none', true);
      assert.equal(after(args, '--tools'), 'WebSearch,WebFetch');
      assert.equal(after(args, '--allowedTools'), 'WebSearch,WebFetch');
      assert.equal(after(args, '--max-turns'), '30');
      args = await run('claude', 'read-only', true);
      assert.equal(after(args, '--tools'), 'Read,Glob,Grep,WebSearch,WebFetch');
      args = await run('claude', 'none');
      assert.equal(after(args, '--tools'), '');
      assert.ok(!args.includes('--allowedTools') && !args.includes('--max-turns'));
      args = await run('claude', 'read-only', false);
      assert.equal(after(args, '--tools'), 'Read,Glob,Grep');
      assert.ok(!args.includes('--allowedTools'));
    });

    await t.test('codex', async () => {
      let args = await run('codex', 'none', true);
      assert.ok(args.includes('web_search="live"'));
      assert.ok(!args.includes('web_search="disabled"'));
      assert.ok(args.includes('shell_tool'));
      args = await run('codex', 'none');
      assert.ok(args.includes('web_search="disabled"'));
    });

    await t.test('grok', async () => {
      let args = await run('grok', 'none', true);
      assert.equal(after(args, '--tools'), 'WebSearch,WebFetch');
      assert.ok(!args.includes('--disable-web-search') && !args.includes('--deny'));
      assert.deepEqual(
        args.flatMap((arg, index) => (arg === '--allow' ? [args[index + 1]] : [])),
        ['WebSearch', 'WebFetch'],
      );
      assert.equal(after(args, '--max-turns'), '30');
      args = await run('grok', 'read-only', true);
      assert.equal(after(args, '--tools'), 'Read,Glob,Grep,WebSearch,WebFetch');
      args = await run('grok', 'none');
      assert.ok(args.includes('--disable-web-search'));
      assert.equal(after(args, '--deny'), '*');
      assert.equal(after(args, '--max-turns'), '2');
    });
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
