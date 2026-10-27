import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

const { openReconnectingSocket } = await import('../web/src/reconnectingSocket.ts');

class FakeSocket extends EventTarget {
  static instances = [];
  constructor(url) {
    super();
    this.url = url;
    this.closed = false;
    FakeSocket.instances.push(this);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event('close'));
  }
  open() {
    this.dispatchEvent(new Event('open'));
  }
  receive(data) {
    const event = new Event('message');
    event.data = data;
    this.dispatchEvent(event);
  }
}

let timers;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

beforeEach(() => {
  FakeSocket.instances = [];
  timers = [];
  globalThis.WebSocket = FakeSocket;
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { hidden: false });
  globalThis.setTimeout = (fn, ms) => {
    const timer = { fn, ms, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  delete globalThis.WebSocket;
  delete globalThis.window;
  delete globalThis.document;
});

const pending = () => timers.filter((timer) => !timer.cleared);

test('décode les messages JSON et ignore les autres', () => {
  const received = [];
  const link = openReconnectingSocket('ws://x/ws', { onMessage: (raw) => received.push(raw) });
  const [socket] = FakeSocket.instances;
  socket.receive('{"type":"a"}');
  socket.receive('pas du json');
  socket.receive(new ArrayBuffer(1));
  assert.deepEqual(received, [{ type: 'a' }]);
  link.close();
});

test('backoff exponentiel plafonné avec jitter, remis à zéro à l’ouverture', () => {
  let closes = 0;
  const link = openReconnectingSocket('ws://x/ws', { onClose: () => (closes += 1) });
  const delays = [];
  for (let i = 0; i < 7; i += 1) {
    FakeSocket.instances.at(-1).close();
    const timer = pending().at(-1);
    delays.push(timer.ms);
    timer.cleared = true;
    timer.fn();
  }
  assert.equal(closes, 7);
  const caps = [400, 800, 1600, 3200, 6400, 8000, 8000];
  delays.forEach((ms, i) => {
    assert.ok(ms >= caps[i] / 2 && ms <= caps[i], `essai ${i} : ${ms} hors de [${caps[i] / 2}, ${caps[i]}]`);
  });
  FakeSocket.instances.at(-1).open();
  FakeSocket.instances.at(-1).close();
  assert.ok(pending().at(-1).ms <= 400);
  link.close();
});

test('online et retour au premier plan reconnectent immédiatement', () => {
  const link = openReconnectingSocket('ws://x/ws', {});
  FakeSocket.instances[0].close();
  assert.equal(pending().length, 1);
  globalThis.window.dispatchEvent(new Event('online'));
  assert.equal(FakeSocket.instances.length, 2);
  assert.equal(pending().length, 0);

  FakeSocket.instances[1].close();
  globalThis.document.hidden = true;
  globalThis.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(FakeSocket.instances.length, 2, 'onglet caché : on attend');
  globalThis.document.hidden = false;
  globalThis.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(FakeSocket.instances.length, 3);

  // Socket ouvert : online ne le remplace pas.
  FakeSocket.instances[2].open();
  globalThis.window.dispatchEvent(new Event('online'));
  assert.equal(FakeSocket.instances.length, 3);
  link.close();
});

test('close arrête tout sans rappeler onClose ni reconnecter', () => {
  let closes = 0;
  const link = openReconnectingSocket('ws://x/ws', { onClose: () => (closes += 1) });
  link.close();
  assert.equal(FakeSocket.instances[0].closed, true);
  assert.equal(closes, 0);
  assert.equal(pending().length, 0);
  globalThis.window.dispatchEvent(new Event('online'));
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(link.current(), null);
});
