import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const { readSessionRequests, userRequests, REQUESTS_MAX } = await import('../server/transcripts.ts');

const root = mkdtempSync(join(tmpdir(), 'cerebro-session-requests-'));
after(() => rmSync(root, { recursive: true, force: true }));
const roots = {
  claude: join(root, 'claude'),
  codex: join(root, 'codex'),
  grok: join(root, 'grok'),
  gemini: join(root, 'gemini'),
};
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
const user = (uuid, content) => ({ type: 'user', uuid, message: { role: 'user', content } });
const assistant = (uuid, text) => ({
  type: 'assistant',
  uuid,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

test('demandes : messages de l’utilisateur, les plus récents d’abord, sans fusion des envois consécutifs', () => {
  const text = jsonl([
    user('u1', 'Première demande'),
    assistant('a1', 'Je regarde.'),
    user('u2', 'Ajoute un test'),
    user('u3', [
      { type: 'text', text: 'Et corrige le lint' },
      { type: 'image', source: {} },
      { type: 'text', text: 'avec la capture' },
    ]),
    user('c', '<command-name>/clear</command-name>'),
    user('r', [{ type: 'tool_result', content: 'sortie' }]),
    user('blank', '   '),
  ]);
  assert.deepEqual(userRequests('claude', text), [
    'Et corrige le lint\n\navec la capture',
    'Ajoute un test',
    'Première demande',
  ]);
});

test('demandes : au plus REQUESTS_MAX, les plus anciennes écartées', () => {
  const text = jsonl(Array.from({ length: REQUESTS_MAX + 5 }, (_, index) => user(`u${index}`, `Demande ${index}`)));
  const requests = userRequests('claude', text);
  assert.equal(requests.length, REQUESTS_MAX);
  assert.equal(requests[0], `Demande ${REQUESTS_MAX + 4}`);
  assert.equal(requests.at(-1), 'Demande 5');
});

test('demandes : lues dans le transcript de la session, sinon la demande de lancement seule', async () => {
  const dir = join(roots.claude, 'projects', '-repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'conv-1.jsonl'), jsonl([user('u1', 'Lance les tests'), user('u2', 'Puis pousse')]));
  assert.deepEqual(await readSessionRequests({ agent: 'claude', agentSessionId: 'conv-1', prompt: 'ignoré' }, roots), {
    requests: ['Puis pousse', 'Lance les tests'],
    complete: true,
  });
  assert.deepEqual(
    await readSessionRequests({ agent: 'claude', agentSessionId: 'absent', prompt: '  Demande initiale \n' }, roots),
    { requests: ['Demande initiale'], complete: false },
  );
  assert.deepEqual(await readSessionRequests({ agent: 'claude', agentSessionId: null, prompt: '' }, roots), {
    requests: [],
    complete: false,
  });
});
