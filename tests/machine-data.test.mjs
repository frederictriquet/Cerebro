import assert from 'node:assert/strict';
import { test } from 'node:test';

const { applyEventsMessage, lastKnownData, rememberData } = await import('../web/src/machine-data.ts');

const session = (id, createdAt, extra = {}) => ({ id, createdAt, projectId: 'p1', status: 'running', ...extra });
const snapshot = {
  type: 'snapshot',
  projects: [{ id: 'p1', name: 'Alpha' }],
  sessions: [session('s1', 1), session('s2', 2)],
  tasks: [{ id: 't1', text: 'Tâche' }],
  epics: [],
  runEvents: true,
};

test('applyEventsMessage : rien avant le premier snapshot, puis toutes les listes suivent le flux', () => {
  assert.equal(applyEventsMessage(null, { type: 'session', session: session('s3', 3) }), null);

  let data = applyEventsMessage(null, snapshot);
  assert.deepEqual(
    data.sessions.map((s) => s.id),
    ['s2', 's1'],
    'sessions triées de la plus récente à la plus ancienne',
  );

  data = applyEventsMessage(data, { type: 'session', session: session('s3', 3) });
  data = applyEventsMessage(data, { type: 'alert', session: session('s1', 1, { status: 'waiting' }) });
  data = applyEventsMessage(data, { type: 'session-deleted', id: 's2' });
  data = applyEventsMessage(data, { type: 'task', task: { id: 't2', text: 'Autre' } });
  data = applyEventsMessage(data, { type: 'task-deleted', id: 't1' });
  data = applyEventsMessage(data, { type: 'epic', epic: { id: 'e1', title: 'Epic' } });
  data = applyEventsMessage(data, {
    type: 'projects',
    projects: [
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
    ],
  });

  assert.deepEqual(
    data.sessions.map((s) => [s.id, s.status]),
    [
      ['s3', 'running'],
      ['s1', 'waiting'],
    ],
  );
  assert.deepEqual(
    data.tasks.map((t) => t.id),
    ['t2'],
  );
  assert.deepEqual(
    data.epics.map((e) => e.id),
    ['e1'],
  );
  assert.deepEqual(
    data.projects.map((p) => p.name),
    ['Alpha', 'Beta'],
  );

  // Un message sans liste rend le même objet : la surveillance ne réécrit rien.
  assert.equal(applyEventsMessage(data, { type: 'peers' }), data);
});

test('Dernier état connu : gardé par machine, remplacé par le suivant', () => {
  assert.equal(lastKnownData('pc'), undefined);
  const first = applyEventsMessage(null, snapshot);
  rememberData('pc', first);
  rememberData('local', applyEventsMessage(null, { ...snapshot, projects: [] }));
  assert.equal(lastKnownData('pc'), first);
  assert.deepEqual(lastKnownData('local').projects, []);

  const next = applyEventsMessage(first, { type: 'projects', projects: [] });
  rememberData('pc', next);
  assert.equal(lastKnownData('pc'), next);
});
