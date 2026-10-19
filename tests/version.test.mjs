import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const { compatibility, isSemver, versionInfoFrom, versionLabel, VERSION_INFO } = await import('../server/version.ts');

test('la version de package.json est SemVer et exposée telle quelle', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(isSemver(version), version);
  assert.equal(VERSION_INFO.version, version);
  assert.equal('protocol' in VERSION_INFO, false);
});

test('isSemver suit la grammaire de semver.org', () => {
  for (const valid of ['0.0.0', '1.2.3', '10.20.30', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-0.3.7', '1.0.0-x-y.7']) {
    assert.ok(isSemver(valid), valid);
  }
  for (const invalid of ['1', '1.2', '01.2.3', '1.02.3', '1.2.3-01', '1.2.3+abc', 'v1.2.3', '1.2.3-', '']) {
    assert.equal(isSemver(invalid), false, invalid);
  }
});

test('compatibilité : même majeure, ou même 0.y avant la 1.0', () => {
  const local = { version: '1.4.2', commit: 'aaaaaaa' };
  assert.equal(compatibility({ version: '1.4.2', commit: 'aaaaaaa' }, local), 'same');
  assert.equal(compatibility({ version: '1.4.2', commit: null }, local), 'same');
  assert.equal(compatibility({ version: '1.4.2', commit: 'bbbbbbb' }, local), 'compatible');
  assert.equal(compatibility({ version: '1.9.0-beta.1', commit: null }, local), 'compatible');
  assert.equal(compatibility({ version: '2.0.0', commit: null }, local), 'incompatible');
  assert.equal(compatibility({ version: '0.4.2', commit: null }, local), 'incompatible');
  assert.equal(compatibility(null, local), 'unknown');

  const early = { version: '0.3.1', commit: null };
  assert.equal(compatibility({ version: '0.3.9', commit: null }, early), 'compatible');
  assert.equal(compatibility({ version: '0.4.0', commit: null }, early), 'incompatible');
});

test('versionInfoFrom : SemVer exigé, instance antérieure (protocol entier) traitée comme inconnue', () => {
  assert.deepEqual(versionInfoFrom({ version: '1.0.0', commit: 'abc1234' }), { version: '1.0.0', commit: 'abc1234' });
  assert.deepEqual(versionInfoFrom({ version: '1.0.0' }), { version: '1.0.0', commit: null });
  assert.equal(versionInfoFrom({ version: '0.1.0', commit: 'abc1234', protocol: 2 }), null);
  assert.equal(versionInfoFrom({ version: 'dev', commit: null }), null);
  assert.equal(versionInfoFrom({ version: '1.0.0', commit: 3 }), null);
  assert.equal(versionInfoFrom(null), null);
});

test('libellé : commit en métadonnée de build', () => {
  assert.equal(versionLabel({ version: '1.0.0', commit: 'abc1234' }), '1.0.0+abc1234');
  assert.equal(versionLabel({ version: '1.0.0', commit: null }), '1.0.0');
});
