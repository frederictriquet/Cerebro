import assert from 'node:assert/strict';
import { test } from 'node:test';
import { secretMatches } from '../server/secret-compare.ts';

test('secretMatches compare les jetons sans accepter les valeurs absentes ni de longueur différente', () => {
  assert.equal(secretMatches('abc123', 'abc123'), true);
  assert.equal(secretMatches('abc123', 'abc124'), false);
  assert.equal(secretMatches('abc123', 'abc12'), false);
  assert.equal(secretMatches('abc123', 'abc1234'), false);
  assert.equal(secretMatches('é', 'ab'), false);
  assert.equal(secretMatches(null, 'abc'), false);
  assert.equal(secretMatches(undefined, 'abc'), false);
  assert.equal(secretMatches('abc', undefined), false);
  assert.equal(secretMatches('', ''), true);
});
