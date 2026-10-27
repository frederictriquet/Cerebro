import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-git-timeout-config-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = join(root, 'data');
const { timeoutSeconds } = await import('../server/config.ts');
after(() => rmSync(root, { recursive: true, force: true }));
/** Calls timeoutSeconds with `raw` and returns its value and the warnings it logged. */
function parse(raw) {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return {
      value: timeoutSeconds('CEREBRO_GIT_TIMEOUT_TEST', 60, raw === undefined ? {} : { CEREBRO_GIT_TIMEOUT_TEST: raw }),
      warnings,
    };
  } finally {
    console.warn = warn;
  }
}

test('a finite positive number of seconds is accepted silently', () => {
  for (const [raw, expected] of [
    ['10', 10],
    ['0.5', 0.5],
    [' 30 ', 30],
    ['600', 600],
  ])
    assert.deepEqual(parse(raw), { value: expected, warnings: [] }, raw);
  assert.deepEqual(parse(undefined), { value: 60, warnings: [] });
});

test('a value that would fire the timer at once falls back to the default and names the variable', () => {
  for (const raw of ['1m', 'abc', '', '  ', '0', '-5', 'NaN', 'Infinity', '99999999999']) {
    const { value, warnings } = parse(raw);
    assert.equal(value, 60, raw);
    assert.equal(warnings.length, 1, raw);
    assert.match(warnings[0], /CEREBRO_GIT_TIMEOUT_TEST/);
  }
});

test('an invalid variable in the environment no longer makes every Git command time out', () => {
  const script = `const {GIT_TIMEOUTS_MS}=await import(${JSON.stringify(new URL('../server/config.ts', import.meta.url).href)});const {runGit}=await import(${JSON.stringify(new URL('../server/git-process.ts', import.meta.url).href)});const result=await runGit(['--version']);console.log(JSON.stringify({timeouts:GIT_TIMEOUTS_MS,code:result.code}));`;
  const output = execFileSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CEREBRO_GIT_TIMEOUT_READ: '1m',
        CEREBRO_GIT_TIMEOUT_WRITE: '0',
        CEREBRO_GIT_TIMEOUT_NETWORK: '',
      },
    },
  );
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)), {
    timeouts: { read: 60_000, write: 600_000, network: 600_000 },
    code: 0,
  });
});
