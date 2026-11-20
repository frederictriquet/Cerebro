import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedAction, todoSessions } from '../web/src/mobile/todo.ts';
import { quickKeyGroups } from '../web/src/mobile/keys.ts';
import { dragOffset, gestureAxis, swipeTarget } from '../web/src/mobile/swipe.ts';

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

test('carte À traiter : action attendue selon l’état et le détail', () => {
  const card = (status, attention, attentionDetail = null) => ({ status, attention, attentionDetail });
  const questions = { kind: 'questions', questions: [] };
  const permission = { kind: 'permission', tool: 'Bash', summary: 'npm test' };
  const turn = { kind: 'turn', message: 'Fini.' };
  assert.equal(expectedAction(card('waiting', true, questions)), 'Répondre');
  assert.equal(expectedAction(card('waiting', true, permission)), 'Autoriser');
  assert.equal(expectedAction(card('waiting', true)), 'Répondre');
  assert.equal(expectedAction(card('idle', true, turn)), 'Relire');
  assert.equal(expectedAction(card('exited', true)), 'Relire');
  assert.equal(expectedAction(card('idle', false, turn)), null);
  assert.equal(expectedAction(card('running', false)), null);
});

test('touches rapides : les touches utiles d’abord, les autres toujours présentes', () => {
  const labels = (keys) => keys.map((key) => key.label);
  const question = (options) => ({
    status: 'waiting',
    attentionDetail: {
      kind: 'questions',
      questions: [
        { question: 'Q', header: null, multiSelect: false, options: Array.from({ length: options }, () => ({})) },
      ],
    },
  });
  let groups = quickKeyGroups(question(2));
  assert.deepEqual(labels(groups.now), ['1', '2', 'Entrée', 'Échap']);
  assert.deepEqual(labels(groups.other), ['↑', '↓', '3', 'y', 'n', 'Ctrl+C']);
  assert.deepEqual(labels(quickKeyGroups(question(5)).now), ['1', '2', '3', 'Entrée', 'Échap']);
  groups = quickKeyGroups({ status: 'waiting', attentionDetail: { kind: 'permission', tool: null, summary: null } });
  assert.deepEqual(labels(groups.now), ['1', '2', '3', 'Entrée', 'Échap']);
  assert.deepEqual(labels(quickKeyGroups({ status: 'waiting', attentionDetail: null }).now), [
    'Entrée',
    'Échap',
    'y',
    'n',
  ]);
  groups = quickKeyGroups({ status: 'running', attentionDetail: null });
  assert.deepEqual(groups.now, []);
  assert.equal(groups.other.length, 10);
});

test('balayage : axe décidé après le seuil, onglet voisin au-delà de 60 px, bords freinés', () => {
  assert.equal(gestureAxis(5, 3), null);
  assert.equal(gestureAxis(15, 4), 'x');
  assert.equal(gestureAxis(8, 14), 'y');
  assert.equal(gestureAxis(-20, 19), 'x');
  assert.equal(swipeTarget(0, 3, -61), 1);
  assert.equal(swipeTarget(1, 3, 60), 0);
  assert.equal(swipeTarget(1, 3, -59), 1);
  assert.equal(swipeTarget(2, 3, -200), 2);
  assert.equal(swipeTarget(0, 3, 200), 0);
  assert.equal(dragOffset(0, 3, 90), 30);
  assert.equal(dragOffset(2, 3, -90), -30);
  assert.equal(dragOffset(1, 3, -90), -90);
});
