import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchSpec } from '../web/src/mobile/launch.ts';
import { openBlockers } from '../web/src/backlog/tasks.ts';

test("lancement mobile avec l'agent du projet : seul le prompt part", () => {
  assert.deepEqual(launchSpec('claude', 'claude', 'Corrige le test'), { prompt: 'Corrige le test' });
});

test('lancement mobile avec un autre agent : modèle et effort repartent du défaut', () => {
  assert.deepEqual(launchSpec('claude', 'codex', ''), { agent: 'codex', prompt: '', model: null, effort: null });
});

const task = (id, status, dependsOn = []) => ({ id, status, dependsOn });

test('openBlockers : dépendances du projet non terminées, inconnues ignorées', () => {
  const tasks = [task('a', 'done'), task('b', 'started'), task('c', 'todo'), task('d', 'todo', ['a', 'b', 'c', 'x'])];
  assert.deepEqual(
    openBlockers(tasks[3], tasks).map((t) => t.id),
    ['b', 'c'],
  );
  assert.deepEqual(openBlockers(task('e', 'todo', ['a']), tasks), []);
});
