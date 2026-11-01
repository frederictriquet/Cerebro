import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessWarning, missingAccess, needsText } from '../shared/council.ts';
import { parseCouncilRun, parsePersona } from '../shared/types.ts';

const empiricist = { name: 'Empiriste', needs: ['project', 'web'] };
const historian = { name: 'Historien des échecs', needs: ['web'] };
const contrarian = { name: 'Contrarien', needs: [] };
const NONE = { project: false, web: false };

test('accès manquants : seuls ceux que le council ne donne pas, dans l’ordre des personas', () => {
  assert.deepEqual(missingAccess([contrarian, empiricist, historian], NONE), [
    { name: 'Empiriste', needs: ['project', 'web'] },
    { name: 'Historien des échecs', needs: ['web'] },
  ]);
  assert.deepEqual(missingAccess([empiricist, historian], { project: true, web: false }), [
    { name: 'Empiriste', needs: ['web'] },
    { name: 'Historien des échecs', needs: ['web'] },
  ]);
  assert.deepEqual(missingAccess([empiricist, historian], { project: false, web: true }), [
    { name: 'Empiriste', needs: ['project'] },
  ]);
  assert.deepEqual(missingAccess([empiricist, historian], { project: true, web: true }), []);
  // Copie figée d'un run antérieur aux besoins d'accès : rien à signaler.
  assert.deepEqual(missingAccess([{ name: 'Ancien' }], NONE), []);
});

test('avertissement : nomme chaque persona et ses accès manquants, null sans manque', () => {
  assert.equal(needsText(['project', 'web']), 'du dépôt et du web');
  assert.equal(accessWarning([contrarian], NONE), null);
  assert.equal(accessWarning([], NONE), null);
  assert.equal(
    accessWarning([historian, contrarian], NONE),
    'Historien des échecs a besoin du web : ce council n’y donne pas accès, ses preuves risquent d’être inventées.',
  );
  assert.equal(
    accessWarning([empiricist, contrarian, historian], NONE),
    'Empiriste a besoin du dépôt et du web, Historien des échecs a besoin du web : ce council n’y donne pas accès, leurs preuves risquent d’être inventées.',
  );
});

test('lecture côté client : besoins connus, sans doublon, dans l’ordre canonique', () => {
  const base = { id: 'p', name: 'P', prompt: 'Prompt', builtin: false, createdAt: 1, updatedAt: 1 };
  assert.deepEqual(parsePersona({ ...base, needs: ['web', 'ftp', 'project', 'web'] }).needs, ['project', 'web']);
  assert.deepEqual(parsePersona(base).needs, []);
  assert.deepEqual(parsePersona({ ...base, needs: 'web' }).needs, []);
  const advisor = {
    personaId: 'p',
    agent: 'claude',
    model: null,
    effort: null,
    name: 'P',
    description: '',
    prompt: '',
  };
  const run = parseCouncilRun({
    id: 'r',
    question: 'Q',
    settings: { assignments: {}, defaultPersonaIds: [], chairman: { agent: 'claude' }, readProject: false },
    status: 'running',
    phase: 'answering',
    startedAt: 1,
    // Le second conseiller vient d'un run enregistré avant les besoins d'accès.
    advisors: [
      { ...advisor, needs: ['web'] },
      { ...advisor, personaId: 'q' },
    ],
  });
  assert.deepEqual(
    run.advisors.map((entry) => entry.needs),
    [['web'], []],
  );
});
