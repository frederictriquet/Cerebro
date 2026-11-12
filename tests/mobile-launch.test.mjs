import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchSpec } from '../web/src/mobile/launch.ts';
import { openBlockers } from '../web/src/backlog/tasks.ts';

test('lancement mobile : agent, modèle, effort, mode et prompt partent explicitement', () => {
  assert.deepEqual(launchSpec({ agent: 'codex', model: 'gpt-5', effort: 'high', mode: 'plan' }, 'Corrige le test'), {
    agent: 'codex',
    model: 'gpt-5',
    effort: 'high',
    mode: 'plan',
    prompt: 'Corrige le test',
  });
});

test('lancement mobile : modèle et effort par défaut gardés à null', () => {
  assert.deepEqual(launchSpec({ agent: 'claude', model: null, effort: null, mode: 'auto' }, ''), {
    agent: 'claude',
    model: null,
    effort: null,
    mode: 'auto',
    prompt: '',
  });
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
