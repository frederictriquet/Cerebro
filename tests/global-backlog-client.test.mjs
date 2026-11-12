import assert from 'node:assert/strict';
import { test } from 'node:test';

// Le client du backlog global doit appeler les routes telles quelles : un préfixe passé à apiPath serait
// encodé (« %2Fapi%2F… ») et chaque modification ou suppression répondrait 404.
globalThis.window = { location: { hash: '' } };
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push([init?.method ?? 'GET', url]);
  const task = { id: 'a b', text: 't', epicId: null, dueDate: null, createdAt: 1, updatedAt: 1 };
  const epic = { id: 'a b', title: 'e', description: '', dueDate: null, createdAt: 1, updatedAt: 1 };
  const body = String(url).includes('/epics') ? epic : task;
  return new Response(init?.method === 'DELETE' ? null : JSON.stringify(body), {
    status: init?.method === 'DELETE' ? 204 : 200,
  });
};
const api = await import('../web/src/api.ts');

test('les appels du backlog global visent les bonnes routes, identifiant encodé', async () => {
  await api.updateGlobalTask('a b', { dueDate: '2027-01-01' });
  await api.deleteGlobalTask('a b');
  await api.updateGlobalEpic('a b', { title: 'x' });
  await api.deleteGlobalEpic('a b');
  await api.createGlobalTask('t', null, null);
  await api.createGlobalEpic('e', '', null);
  await api.dispatchGlobalItem('tasks', 'a b', 'p');
  assert.deepEqual(calls, [
    ['PATCH', '/api/global-backlog/tasks/a%20b'],
    ['DELETE', '/api/global-backlog/tasks/a%20b'],
    ['PATCH', '/api/global-backlog/epics/a%20b'],
    ['DELETE', '/api/global-backlog/epics/a%20b'],
    ['POST', '/api/global-backlog/tasks'],
    ['POST', '/api/global-backlog/epics'],
    ['POST', '/api/global-backlog/tasks/a%20b/dispatch'],
  ]);
});
