import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-slack-text-'));
process.env.HOME = root;
process.env.CEREBRO_DATA_DIR = root;
const { decodeSlackText } = await import('../server/slack.ts');

test('decodeSlackText turns Slack links into readable text', () => {
  assert.equal(
    decodeSlackText('voir <https://example.com/a?b=1&amp;c=2|la doc> stp'),
    'voir la doc (https://example.com/a?b=1&c=2) stp',
  );
  assert.equal(decodeSlackText('<https://example.com/x>'), 'https://example.com/x');
  assert.equal(decodeSlackText('<https://example.com|example.com>'), 'https://example.com');
  assert.equal(decodeSlackText('<https://example.com|https://example.com>'), 'https://example.com');
  assert.equal(decodeSlackText('écris à <mailto:a@b.fr|a@b.fr>'), 'écris à a@b.fr');
  assert.equal(decodeSlackText('<https://a.fr|R&amp;D &lt;3>'), 'R&D <3 (https://a.fr)');
});

test('decodeSlackText turns mentions and commands into plain names', () => {
  assert.equal(decodeSlackText('merci <@U123ABC>'), 'merci @U123ABC');
  assert.equal(decodeSlackText('merci <@U123ABC|fred>'), 'merci @fred');
  assert.equal(decodeSlackText('dans <#C42|general> et <#C43>'), 'dans #general et #C43');
  assert.equal(decodeSlackText('<!here> <!channel> <!everyone>'), '@here @channel @everyone');
  assert.equal(decodeSlackText('<!subteam^S1|@devs> <!date^1700000000^{date}|14 nov.>'), '@devs 14 nov.');
});

test('decodeSlackText keeps escaped angle brackets as text', () => {
  assert.equal(decodeSlackText('  if a &lt; b &amp;&amp; c &gt; d  '), 'if a < b && c > d');
  assert.equal(decodeSlackText('&lt;@U1&gt; &lt;https://x.fr|y&gt;'), '<@U1> <https://x.fr|y>');
  assert.equal(decodeSlackText('&amp;lt;'), '&lt;');
});
