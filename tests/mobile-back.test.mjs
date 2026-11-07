import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

// Faux historique de navigateur : une pile d'entrées { hash, state } et un index courant, comme Chrome et la WebView.
let entries = [];
let index = 0;
let backCalls = 0;
const fakeWindow = new EventTarget();
fakeWindow.location = {
  get hash() {
    return entries[index].hash;
  },
};
fakeWindow.history = {
  get state() {
    return entries[index].state;
  },
  get length() {
    return entries.length;
  },
  replaceState(state, _title, url) {
    entries[index] = { hash: url ?? entries[index].hash, state: structuredClone(state) };
  },
  back() {
    backCalls += 1;
    if (index === 0) return;
    const before = entries[index].hash;
    index -= 1;
    if (entries[index].hash !== before) fakeWindow.dispatchEvent(new Event('hashchange'));
  },
};
globalThis.window = fakeWindow;

const { mobileBack, trackMobileHistory } = await import('../web/src/mobile/back.ts');

let untrack = null;

/** Ouverture de la page (à froid ou rechargement) sur l'entrée courante. */
function open(hash) {
  entries = [{ hash, state: null }];
  index = 0;
  backCalls = 0;
  untrack = trackMobileHistory();
}

/** Clic sur un lien `<a href="#…">` ou appel de `go()` : nouvelle entrée, état null, puis hashchange. */
function navigate(hash) {
  entries = entries.slice(0, index + 1);
  entries.push({ hash, state: null });
  index += 1;
  fakeWindow.dispatchEvent(new Event('hashchange'));
}

function reload() {
  untrack();
  untrack = trackMobileHistory();
}

afterEach(() => {
  untrack?.();
  untrack = null;
});

test('a cold link goes home in place: no new entry, nothing to replay', () => {
  open('#/s/a');
  mobileBack();
  assert.equal(backCalls, 0);
  assert.deepEqual(
    entries.map((entry) => entry.hash),
    ['#/'],
  );
});

test('after an internal navigation, ‹ walks back like the Android back button', () => {
  open('#/');
  navigate('#/s/a');
  mobileBack();
  assert.equal(backCalls, 1);
  assert.equal(index, 0);
  assert.equal(fakeWindow.location.hash, '#/');
});

test('‹ goes back screen by screen to the screen the view opened on', () => {
  open('#/');
  navigate('#/p/x');
  navigate('#/s/a');
  mobileBack();
  assert.equal(fakeWindow.location.hash, '#/p/x');
  mobileBack();
  assert.equal(fakeWindow.location.hash, '#/');
  assert.equal(backCalls, 2);
  assert.equal(index, 0);
});

test('back on the cold entry keeps it the opening entry: ‹ replaces it instead of leaving the view', () => {
  open('#/p/x');
  navigate('#/s/a');
  // Retour Android : la WebView revient sur l'entrée froide et déclenche hashchange.
  fakeWindow.history.back();
  backCalls = 0;
  mobileBack();
  assert.equal(backCalls, 0);
  assert.equal(index, 0);
  assert.equal(fakeWindow.location.hash, '#/');
});

test('a hashchange on the same hash does not turn the opening entry into an internal one', () => {
  open('#/s/a');
  // assignHash (web/src/route.ts) déclenche hashchange sans créer d'entrée quand le hash ne change pas.
  fakeWindow.dispatchEvent(new Event('hashchange'));
  mobileBack();
  assert.equal(backCalls, 0);
  assert.equal(fakeWindow.location.hash, '#/');
});

test('a reload keeps the mark: ‹ still walks back', () => {
  open('#/');
  navigate('#/s/a');
  reload();
  mobileBack();
  assert.equal(backCalls, 1);
  assert.equal(fakeWindow.location.hash, '#/');
});

test('a cold link on a remote machine goes to that machine home', () => {
  open('#/m/mac/s/a');
  mobileBack();
  assert.equal(backCalls, 0);
  assert.equal(fakeWindow.location.hash, '#/m/mac/');
});

test('the mark merges with an existing history state', () => {
  entries = [{ hash: '#/s/a', state: { other: 1 } }];
  index = 0;
  untrack = trackMobileHistory();
  assert.equal(fakeWindow.history.state.other, 1);
  mobileBack();
  assert.equal(fakeWindow.history.state.other, 1);
});

test('unmounting stops marking new entries', () => {
  open('#/');
  untrack();
  untrack = null;
  navigate('#/s/a');
  assert.equal(fakeWindow.history.state, null);
});
