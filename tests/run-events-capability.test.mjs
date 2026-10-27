import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEventsMessage } from '../web/src/types.ts';

// Une machine distante de même majeure antérieure aux événements epic-run / command-run n'annonce pas
// runEvents : l'UI doit alors relire les runs périodiquement au lieu d'attendre des événements.
test('le snapshot /ws/events indique si l’instance diffuse les événements de run', () => {
  const base = { type: 'snapshot', projects: [], sessions: [], tasks: [], epics: [] };
  assert.equal(parseEventsMessage({ ...base, runEvents: true })?.runEvents, true);
  assert.equal(parseEventsMessage(base)?.runEvents, false);
  assert.equal(parseEventsMessage({ ...base, runEvents: 'yes' })?.runEvents, false);
});
