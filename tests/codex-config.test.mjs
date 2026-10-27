import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Aucun fichier de configuration réel n'est lu.
const root = mkdtempSync(join(tmpdir(), 'cerebro-codex-config-'));
const home = join(root, 'codex');
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CODEX_HOME = home;
after(() => rmSync(root, { recursive: true, force: true }));

const { parseTomlTopLevel, readCodexConfig, readCodexString } = await import('../server/codex-config.ts');
const { readCodexDeveloperInstructions } = await import('../server/agents.ts');

const parse = (text) => Object.fromEntries(parseTomlTopLevel(text));

test('basic and literal strings, with escapes kept only in basic ones', () => {
  assert.deepEqual(
    parse(
      [
        'a = "tab\\there \\"quoted\\" \\u00e9\\U0001F600"',
        "b = 'C:\\path\\no\\escape'",
        'c = "it\'s"',
        'd = \'say "hi"\'',
        'e = ""',
      ].join('\n'),
    ),
    { a: 'tab\there "quoted" é😀', b: 'C:\\path\\no\\escape', c: "it's", d: 'say "hi"', e: '' },
  );
});

test('triple-quoted strings span lines and trim the newline after the opening delimiter', () => {
  assert.deepEqual(
    parse(
      [
        'basic = """',
        'line 1',
        '  line 2 with "quotes" and \\"""',
        'ends with a quote""""',
        'folded = """one \\',
        '    two"""',
        "literal = '''",
        "raw \\n and 'quotes'",
        "[not a table]'''",
        "inline = '''single line'''",
      ].join('\n'),
    ),
    {
      basic: 'line 1\n  line 2 with "quotes" and """\nends with a quote"',
      folded: 'one two',
      literal: "raw \\n and 'quotes'\n[not a table]",
      inline: 'single line',
    },
  );
});

test('comments, blank lines and CRLF are ignored, including # inside strings', () => {
  assert.deepEqual(
    parse(
      [
        '# leading comment',
        '',
        'model = "gpt-5" # trailing comment',
        "url = 'http://host/#anchor'   # comment",
        '  # indented comment',
        'flag = true',
      ].join('\r\n'),
    ),
    { model: 'gpt-5', url: 'http://host/#anchor', flag: true },
  );
});

test('stops at the first table header and skips non-scalar values', () => {
  assert.deepEqual(
    parse(
      [
        'notify = [',
        '  "node", # comment',
        '  ["nested"],',
        ']',
        'tui = { notifications = true, method = "osc9" }',
        'when = 1979-05-27 07:32:00Z',
        'count = 1_000',
        'ratio = -0.5e1',
        '"quoted key" = "q"',
        "'literal key' = 'l'",
        'section.key = "dotted"',
        'after = "kept"',
        '[profiles.work]',
        'model = "ignored"',
      ].join('\n'),
    ),
    { count: 1000, ratio: -5, 'quoted key': 'q', 'literal key': 'l', 'section.key': 'dotted', after: 'kept' },
  );
});

test('a malformed line is skipped without losing the following keys', () => {
  assert.deepEqual(
    parse(['broken = "unterminated', 'bare = value', 'ok = "yes"', '= "no key"', 'last = 2'].join('\n')),
    { ok: 'yes', last: 2 },
  );
  assert.deepEqual(parse(''), {});
});

test('reads the config from CODEX_HOME', () => {
  assert.equal(readCodexConfig().size, 0);
  assert.equal(readCodexDeveloperInstructions(), null);
  mkdirSync(home);
  writeFileSync(
    join(home, 'config.toml'),
    [
      'model = "gpt-test"',
      'model_reasoning_effort = 3',
      'developer_instructions = """',
      'Réponds en français."""',
      '[profiles.x]',
      'developer_instructions = "ignored"',
    ].join('\n'),
  );
  assert.equal(readCodexString('model'), 'gpt-test');
  assert.equal(readCodexString('model_reasoning_effort'), null);
  assert.equal(readCodexString('missing'), null);
  assert.equal(readCodexDeveloperInstructions(), 'Réponds en français.');
  writeFileSync(join(home, 'config.toml'), "developer_instructions = '   '\n");
  assert.equal(readCodexDeveloperInstructions(), null);
});
