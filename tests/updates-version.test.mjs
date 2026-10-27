import assert from 'node:assert/strict';
import test from 'node:test';

const { isNewer } = await import('../server/updates.ts');

test('isNewer compares pre-release numeric identifiers as numbers', () => {
  assert.equal(isNewer('1.0.0-rc.10', '1.0.0-rc.9'), true);
  assert.equal(isNewer('1.0.0-rc.9', '1.0.0-rc.10'), false);
});

test('isNewer follows semver precedence', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.2.0',
    '1.10.0',
    '2.0.0',
  ];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = 0; j < ordered.length; j += 1) {
      assert.equal(isNewer(ordered[i], ordered[j]), i > j, `${ordered[i]} vs ${ordered[j]}`);
    }
  }
});

test('isNewer keeps hyphens inside pre-release identifiers and ignores build metadata', () => {
  assert.equal(isNewer('1.0.0-rc-2', '1.0.0-rc-1'), true);
  assert.equal(isNewer('1.0.0+build.2', '1.0.0+build.1'), false);
});
