import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runHeadless, supportsImages } from '../server/headless.ts';

const schema = {
  type: 'object',
  required: ['answer'],
  properties: { answer: { type: 'string' } },
  additionalProperties: false,
};

// Fake CLIs that record their arguments and stdin, then answer like the real ones would.
const script = (capture) => `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, stdin }));
if (args[0] === 'exec') writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ answer: 'ok' }));
else if (args.includes('stream-json')) console.log(['{"type":"system","subtype":"init"}', 'not json progress line', '{"type":"result","subtype":"success","structured_output":{"answer":"ok"}}'].join('\\n'));
else console.log(JSON.stringify({ answer: 'ok' }));
`;

test('headless: images travel inside a Claude stream-json turn, as Codex --image flags, and are refused for Grok', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cerebro-headless-images-'));
  const bin = join(directory, 'bin');
  const capture = join(directory, 'capture.json');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const first = join(directory, 'first.png');
  const second = join(directory, 'second.JPG');
  const previousPath = process.env.PATH;
  try {
    await mkdir(bin);
    for (const agent of ['claude', 'codex', 'grok'])
      await writeFile(join(bin, agent), script(capture), { mode: 0o755 });
    await writeFile(first, png);
    await writeFile(second, Buffer.from('ffd8ffe0', 'hex'));
    process.env.PATH = `${bin}:${previousPath}`;
    const run = (agent, images) =>
      runHeadless({
        agent,
        model: null,
        effort: null,
        prompt: 'Describe [Image #1] and [Image #2].',
        schema,
        access: 'none',
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        images,
      });

    await t.test('claude', async () => {
      assert.deepEqual(await run('claude', [first, second]), { answer: 'ok' });
      const { args, stdin } = JSON.parse(await readFile(capture, 'utf8'));
      for (const flag of ['--verbose', '--input-format', 'stream-json']) assert.ok(args.includes(flag), flag);
      assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
      assert.ok(!args.includes('json') || args[args.indexOf('--output-format') + 1] !== 'json');
      const lines = stdin.split('\n').filter((line) => line !== '');
      assert.equal(lines.length, 1, 'exactly one user turn on stdin');
      const turn = JSON.parse(lines[0]);
      assert.equal(turn.type, 'user');
      assert.deepEqual(turn.message.content[0], { type: 'text', text: 'Describe [Image #1] and [Image #2].' });
      assert.deepEqual(turn.message.content[1], {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
      });
      assert.equal(turn.message.content[2].source.media_type, 'image/jpeg');
      assert.equal(turn.message.content.length, 3);
    });

    await t.test('claude without images keeps the plain json output', async () => {
      assert.deepEqual(await run('claude', []), { answer: 'ok' });
      const { args, stdin } = JSON.parse(await readFile(capture, 'utf8'));
      assert.ok(!args.includes('stream-json') && !args.includes('--verbose'));
      assert.equal(stdin, 'Describe [Image #1] and [Image #2].');
    });

    await t.test('codex', async () => {
      assert.deepEqual(await run('codex', [first, second]), { answer: 'ok' });
      const { args, stdin } = JSON.parse(await readFile(capture, 'utf8'));
      const images = args.flatMap((arg, index) => (arg === '--image' ? [args[index + 1]] : []));
      assert.deepEqual(images, [first, second]);
      assert.equal(args.at(-1), '-', 'the prompt still comes from stdin');
      assert.equal(stdin, 'Describe [Image #1] and [Image #2].');
    });

    await t.test('grok', async () => {
      await assert.rejects(run('grok', [first]), /grok ne prend pas en charge les images/);
      assert.equal(supportsImages('grok'), false);
      assert.equal(supportsImages('claude'), true);
      assert.equal(supportsImages('codex'), true);
    });

    await t.test('unsupported image format', async () => {
      const text = join(directory, 'notes.txt');
      await writeFile(text, 'x');
      await assert.rejects(run('claude', [text]), /Image non prise en charge/);
    });
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
