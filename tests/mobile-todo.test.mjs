import assert from 'node:assert/strict';
import { test } from 'node:test';
import { todoSessions } from '../web/src/mobile/todo.ts';

const session = (id, status, attention = false, pendingFindings = 0) => ({ id, status, attention, pendingFindings });
const ids = (list) => list.map((s) => s.id);

test("À traiter : sessions en attente puis en cours, dans l'ordre reçu", () => {
  const sessions = [
    session('run', 'running'),
    session('ask', 'waiting'),
    session('start', 'starting'),
    session('done', 'idle', true),
  ];
  const { awaiting, running } = todoSessions(sessions);
  assert.deepEqual(ids(awaiting), ['ask', 'done']);
  assert.deepEqual(ids(running), ['run', 'start']);
});

test('À traiter : findings seuls, inactive vue et terminée vue exclues ; terminée avec attention gardée', () => {
  const sessions = [
    session('findings', 'idle', false, 3),
    session('seen', 'idle'),
    session('exited', 'exited'),
    session('exited-alert', 'exited', true),
  ];
  const { awaiting, running } = todoSessions(sessions);
  assert.deepEqual(ids(awaiting), ['exited-alert']);
  assert.deepEqual(running, []);
});
