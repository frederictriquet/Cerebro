import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

// Faux navigateur : chemin, hash, requête média et localStorage pilotés par chaque cas.
let phone = true;
let storageBroken = false;
const stored = new Map();
const navigations = [];

globalThis.localStorage = {
  getItem(key) {
    if (storageBroken) throw new Error('stockage bloqué');
    return stored.get(key) ?? null;
  },
  setItem(key, value) {
    if (storageBroken) throw new Error('stockage bloqué');
    stored.set(key, String(value));
  },
  removeItem(key) {
    stored.delete(key);
  },
};
const location = {
  pathname: '/',
  hash: '',
  replace(url) {
    navigations.push(['replace', url]);
  },
  assign(url) {
    navigations.push(['assign', url]);
  },
};
globalThis.window = {
  location,
  matchMedia(query) {
    assert.equal(query, '(max-width: 800px) and (pointer: coarse)');
    return { matches: phone };
  },
};

const { FULL_VERSION_KEY, forgetFullVersion, isMobilePath, openFullVersion, pinnedProjectHash, redirectToMobile } =
  await import('../web/src/mobile/redirect.ts');

beforeEach(() => {
  phone = true;
  storageBroken = false;
  stored.clear();
  navigations.length = 0;
  location.pathname = '/';
  location.hash = '#/s/abc';
});

test('a phone opening / goes to the mobile view of the same route', () => {
  assert.equal(redirectToMobile(), true);
  assert.deepEqual(navigations, [['replace', '/mobile#/s/abc']]);
});

test('a phone opening / without hash goes to /mobile', () => {
  location.hash = '';
  assert.equal(redirectToMobile(), true);
  assert.deepEqual(navigations, [['replace', '/mobile']]);
});

test('the full version choice keeps the phone on the desktop view', () => {
  stored.set(FULL_VERSION_KEY, '1');
  assert.equal(redirectToMobile(), false);
  assert.deepEqual(navigations, []);
});

test('a desktop screen is not redirected', () => {
  phone = false;
  assert.equal(redirectToMobile(), false);
  assert.deepEqual(navigations, []);
});

test('only / is redirected', () => {
  for (const pathname of ['/mobile', '/mobile/', '/index.html', '/vscode/']) {
    location.pathname = pathname;
    assert.equal(redirectToMobile(), false, pathname);
  }
  assert.deepEqual(navigations, []);
});

test('the mobile view is recognized with or without trailing slashes', () => {
  for (const pathname of ['/mobile', '/mobile/', '/mobile//']) {
    assert.equal(isMobilePath(pathname), true, pathname);
  }
  for (const pathname of ['/', '', '/mobiles', '/m/mobile', '/vscode/']) {
    assert.equal(isMobilePath(pathname), false, pathname);
  }
});

test('an unreadable localStorage still redirects the phone', () => {
  storageBroken = true;
  assert.equal(redirectToMobile(), true);
  assert.deepEqual(navigations, [['replace', '/mobile#/s/abc']]);
});

test('openFullVersion records the choice and opens / on the same route', () => {
  location.pathname = '/mobile';
  openFullVersion();
  assert.equal(stored.get(FULL_VERSION_KEY), '1');
  assert.deepEqual(navigations, [['assign', '/#/s/abc']]);

  location.pathname = '/';
  navigations.length = 0;
  assert.equal(redirectToMobile(), false);
  assert.deepEqual(navigations, []);
});

test('opening the mobile view again forgets the full version choice', () => {
  location.pathname = '/mobile';
  openFullVersion();
  assert.equal(stored.get(FULL_VERSION_KEY), '1');

  assert.equal(forgetFullVersion(), null);
  assert.equal(stored.has(FULL_VERSION_KEY), false);

  location.pathname = '/';
  navigations.length = 0;
  assert.equal(redirectToMobile(), true);
  assert.deepEqual(navigations, [['replace', '/mobile#/s/abc']]);
});

test('openFullVersion stays on the mobile view and reports the error when the choice cannot be recorded', () => {
  location.pathname = '/mobile';
  storageBroken = true;
  const error = openFullVersion();
  assert.equal(typeof error, 'string');
  assert.ok(error.length > 0);
  assert.deepEqual(navigations, []);
});

test('the mobile view opened without a route goes to the pinned project of the machine', () => {
  const projects = [
    { id: 'other', pinned: false },
    { id: 'pinned one', pinned: true },
  ];
  assert.equal(pinnedProjectHash('', projects), '#/p/pinned%20one');
  assert.equal(pinnedProjectHash('', [{ id: 'other', pinned: false }]), null);
  assert.equal(pinnedProjectHash('', []), null);
});

test('a route given at opening, or the home set by the back button, keeps the mobile view where it is', () => {
  const projects = [{ id: 'pinned', pinned: true }];
  for (const hash of ['#/', '#/s/abc', '#/p/other', '#/c/run', '#/m/mac/']) {
    assert.equal(pinnedProjectHash(hash, projects), null, hash);
  }
});
