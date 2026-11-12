import assert from 'node:assert/strict';
import { test } from 'node:test';

const { answerQuestions } = await import('../server/session-input.ts');
const { interpretAnswer } = await import('../server/questions.ts');

const questions = [
  {
    question: 'Arrondir la TVA ligne par ligne ou sur le total ?',
    header: 'Arrondi',
    multiSelect: false,
    options: [
      { label: 'Ligne par ligne', description: null, preview: null },
      { label: 'Sur le total', description: null, preview: null },
    ],
  },
];

// Faux gestionnaire : enregistre les frappes envoyées à la session.
function fakeSessions(pending) {
  const writes = [];
  return {
    writes,
    pendingQuestions: () => pending,
    setPendingQuestions: (_id, value) => {
      pending = value;
    },
    writeInput: (_id, data) => {
      writes.push(data);
      return true;
    },
  };
}

test('dialogue encore ouvert : Échap, réponse préfixée par son origine, puis Entrée', async () => {
  const sessions = fakeSessions(questions);
  const answer = interpretAnswer(questions, '2');
  assert.equal(await answerQuestions(sessions, 's', questions, answer, 'Cerebro'), true);
  assert.deepEqual(sessions.writes, [
    '\x1b',
    '[Réponse Cerebro à tes questions, le dialogue a été fermé] « Arrondi » → Sur le total',
    '\r',
  ]);
  assert.equal(sessions.pendingQuestions(), null);
});

test('dialogue déjà fermé : la réponse devient un message, sans Échap', async () => {
  const sessions = fakeSessions(null);
  assert.equal(await answerQuestions(sessions, 's', questions, 'texte\nlibre', 'Slack'), true);
  assert.deepEqual(sessions.writes, ['[Réponse Slack à tes questions] texte libre', '\r']);
});
