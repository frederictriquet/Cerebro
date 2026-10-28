import assert from 'node:assert/strict';
import { test } from 'node:test';

const { conflictResolutionPrompt } = await import('../server/conflict-resolution.ts');

const context = {
  view: {
    path: '/copie',
    branch: 'refs/heads/cerebro/x',
    expectedBranch: null,
    targetBranch: 'refs/heads/main',
    targetPath: '/projet',
  },
  mergeHead: '0123456789abcdef',
  base: 'fedcba9876543210',
  files: [
    {
      path: 'server/a.ts',
      ours: 'modified',
      theirs: 'modified',
      oursCommits: ['Copie : ajouter le cache'],
      theirsCommits: ['Cible : renommer la fonction'],
    },
    { path: 'web/b.tsx', ours: 'modified', theirs: 'deleted', oursCommits: ['Copie : bouton'], theirsCommits: [] },
  ],
  oursCommits: [{ hash: 'aaa1111', subject: 'Copie : ajouter le cache' }],
  theirsCommits: [
    { hash: 'bbb2222', subject: 'Cible : renommer la fonction' },
    { hash: 'ccc3333', subject: 'Cible : déplacer le bouton' },
  ],
  resolved: ['web/b.tsx'],
};

test('the prompt lists each file with what both sides did and how to read its three versions', () => {
  const prompt = conflictResolutionPrompt(context, null, null);
  assert.match(prompt, /worktree Git \/copie, branche cerebro\/x, destinée à être intégrée dans main/);
  assert.match(prompt, /merge de main \(commit 0123456\)/);
  assert.match(prompt, /Fichiers à traiter \(2\)/);
  assert.match(
    prompt,
    /- server\/a\.ts\n {2}Copie : modifié ; commits qui l’ont touché : « Copie : ajouter le cache »\n {2}Cible : modifié ; commits qui l’ont touché : « Cible : renommer la fonction »/,
  );
  assert.match(
    prompt,
    /- web\/b\.tsx \(plus aucun marqueur[^\n]*\n {2}Copie : modifié ; [^\n]*\n {2}Cible : supprimé ; commits qui l’ont touché : aucun/,
  );
  assert.match(prompt, /git show :1:<fichier>/);
  assert.match(prompt, /git show :2:<fichier>/);
  assert.match(prompt, /git show :3:<fichier>/);
  assert.match(prompt, /git diff --base -- <fichier>/);
  assert.match(
    prompt,
    /Commits de la copie depuis la base commune fedcba9[^\n]*\n- aaa1111 Copie : ajouter le cache\n/,
  );
  assert.match(
    prompt,
    /Commits de main depuis la base commune[^\n]*\n- bbb2222 Cible : renommer la fonction\n- ccc3333 Cible : déplacer le bouton\n/,
  );
  assert.match(prompt, /Conversation d’origine de la copie : inconnue/);
  assert.doesNotMatch(prompt, /Tâche d’epic/);
});

test('the prompt forbids staging, committing and aborting, and asks before guessing', () => {
  const prompt = conflictResolutionPrompt(context, null, null);
  assert.match(prompt, /Ne fais ni `git add`, ni commit, ni `git merge --abort`, ni checkout/);
  assert.match(prompt, /Ne modifie pas le dossier du projet \(\/projet\)/);
  assert.match(prompt, /Ne modifie que les fichiers listés/);
  assert.match(prompt, /cerebro-notify --ask/);
  assert.match(prompt, /reporte le changement de la copie à son nouvel emplacement/);
  assert.match(prompt, /typecheck et les tests du projet/);
  assert.match(prompt, /« Terminer la mise à jour »/);
});

test('the prompt carries the conversation’s request, truncated, and the epic task', () => {
  const request = `${'a'.repeat(1999)}bc`;
  const prompt = conflictResolutionPrompt(
    context,
    { title: 'Cache', prompt: `  ${request}  ` },
    { title: 'Ajouter le cache', text: 'Mettre en cache les inventaires.' },
  );
  assert.match(prompt, /Conversation d’origine de la copie : « Cache »/);
  assert.match(prompt, new RegExp(`<demande_initiale>\\n${'a'.repeat(1999)}b\\n…\\n</demande_initiale>`));
  assert.doesNotMatch(prompt, /bc/);
  assert.match(
    prompt,
    /Tâche d’epic confiée à cette conversation : « Ajouter le cache »\n<tache_epic>\nMettre en cache les inventaires\.\n<\/tache_epic>/,
  );
  const short = conflictResolutionPrompt(context, { title: 'Cache', prompt: 'Court' }, null);
  assert.match(short, /<demande_initiale>\nCourt\n<\/demande_initiale>/);
});
