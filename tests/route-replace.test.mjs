import assert from 'node:assert/strict';
import { test } from 'node:test';

const dispatched = [];
const fakeWindow = new EventTarget();
fakeWindow.location = { hash: '' };
fakeWindow.history = {
  state: { keep: true },
  replaceState(state, _title, url) {
    this.state = state;
    fakeWindow.location.hash = url;
  },
};
const dispatch = fakeWindow.dispatchEvent.bind(fakeWindow);
fakeWindow.dispatchEvent = (event) => {
  dispatched.push(event.type);
  return dispatch(event);
};
globalThis.window = fakeWindow;
const { parseHash, replaceRoute } = await import('../web/src/route.ts');

test('replaceRoute rewrites the hash in place and notifies router hooks without a navigation event', () => {
  fakeWindow.location.hash = '#/m/devbox/s/abc/findings';
  dispatched.length = 0;
  let hashChanges = 0;
  fakeWindow.addEventListener('hashchange', () => hashChanges++);

  replaceRoute('#/s/abc');

  assert.equal(fakeWindow.location.hash, '#/m/devbox/s/abc');
  assert.deepEqual(parseHash(fakeWindow.location.hash), { kind: 'session', sessionId: 'abc' });
  assert.deepEqual(fakeWindow.history.state, { keep: true });
  assert.equal(hashChanges, 0);
  assert.deepEqual(dispatched, ['cerebro:route-replaced']);

  dispatched.length = 0;
  replaceRoute('#/s/abc');
  assert.deepEqual(dispatched, []);
});
