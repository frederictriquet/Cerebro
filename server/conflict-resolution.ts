import type { ConflictCommit, ConflictContext, ConflictFile } from './worktrees.ts';
import { branchLabel } from './git.ts';

const MAX_CONVERSATION_PROMPT = 2000;
const MAX_TASK_TEXT = 2000;

const SIDE_STATES: Record<ConflictFile['ours'], string> = {
  modified: 'modifié',
  added: 'ajouté',
  deleted: 'supprimé',
  renamed: 'renommé ou déplacé',
  unchanged: 'inchangé',
};

/** `text` cut at `max` characters, ending with « … » when it was longer. */
function excerpt(text: string, max: number): string {
  const trimmed = text.trim();
  return `${trimmed.slice(0, max)}${trimmed.length > max ? '\n…' : ''}`;
}

function commitList(commits: ConflictCommit[]): string {
  return commits.length ? commits.map((commit) => `- ${commit.hash} ${commit.subject}`).join('\n') : '- aucun';
}

function subjects(list: string[]): string {
  return list.length ? list.map((subject) => `« ${subject} »`).join(', ') : 'aucun';
}

/**
 * Instructions for a session that resolves, in the copy, the merge of the target the user started with « Mettre à
 * jour avec … » and left in conflict, keeping the intention of both sides, without staging nor committing anything.
 */
export function conflictResolutionPrompt(
  context: ConflictContext,
  conversation: { title: string; prompt: string } | null,
  task: { title: string; text: string } | null,
): string {
  const { view } = context;
  const copy = branchLabel(view.branch ?? view.expectedBranch, 'branche inconnue');
  const target = branchLabel(view.targetBranch, 'branche inconnue');
  const mergeHead = context.mergeHead.slice(0, 7);
  const files = context.files
    .map((file) =>
      [
        `- ${file.path}${context.resolved.includes(file.path) ? ' (plus aucun marqueur : vérifie seulement le résultat)' : ''}`,
        `  Copie : ${SIDE_STATES[file.ours]} ; commits qui l’ont touché : ${subjects(file.oursCommits)}`,
        `  Cible : ${SIDE_STATES[file.theirs]} ; commits qui l’ont touché : ${subjects(file.theirsCommits)}`,
      ].join('\n'),
    )
    .join('\n');
  const origin = conversation
    ? `Conversation d’origine de la copie : « ${conversation.title} »${conversation.prompt.trim() ? `\nSa demande initiale :\n<demande_initiale>\n${excerpt(conversation.prompt, MAX_CONVERSATION_PROMPT)}\n</demande_initiale>` : ''}`
    : 'Conversation d’origine de la copie : inconnue.';
  const epic = task
    ? `\n\nTâche d’epic confiée à cette conversation : « ${task.title} »${task.text.trim() ? `\n<tache_epic>\n${excerpt(task.text, MAX_TASK_TEXT)}\n</tache_epic>` : ''}`
    : '';
  return `Tu travailles dans la copie de travail d’une conversation Cerebro (worktree Git ${view.path}, branche ${copy}, destinée à être intégrée dans ${target}).

L’utilisateur a lancé « Mettre à jour avec ${target} » : Git a commencé le merge de ${target} (commit ${mergeHead}) dans la copie, et ce merge attend la résolution des conflits ci-dessous. Résous-les dans les fichiers de la copie, sans rien indexer ni commiter : une fois tes changements relus, l’utilisateur terminera la mise à jour dans Cerebro, qui créera lui-même le commit de merge.

## Intention des deux côtés

${origin}${epic}

Commits de la copie depuis la base commune ${context.base.slice(0, 7)} (le travail de la conversation) :
${commitList(context.oursCommits)}

Commits de ${target} depuis la base commune (ce que la mise à jour apporte) :
${commitList(context.theirsCommits)}

## Fichiers à traiter (${context.files.length})

${files}

Pour lire les trois versions d’un fichier :
- base commune : \`git show :1:<fichier>\` ; version de la copie : \`git show :2:<fichier>\` ; version de ${target} : \`git show :3:<fichier>\` (une version manque quand le fichier n’existe pas de ce côté) ;
- ce que chaque côté a changé : \`git diff --base -- <fichier>\`, \`git diff --ours -- <fichier>\`, \`git diff --theirs -- <fichier>\` ;
- le détail d’un commit cité : \`git show <commit> -- <fichier>\`.

## Méthode

1. Pour chaque fichier, comprends ce que chaque côté voulait faire, à partir des commits, de leurs diffs et de l’intention ci-dessus.
2. Écris une version qui garde les deux intentions, et retire tous les marqueurs de conflit (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`, \`|||||||\`).
3. Quand ${target} a déplacé ou renommé du code (par exemple un fichier supprimé d’un côté et modifié de l’autre), reporte le changement de la copie à son nouvel emplacement plutôt que de restaurer l’ancien code.
4. Vérifie le résultat avec le typecheck et les tests du projet s’ils existent dans package.json, et corrige ce que la résolution a cassé.

## Interdits

- Ne fais ni \`git add\`, ni commit, ni \`git merge --abort\`, ni checkout, ni reset, ni stash : le merge doit rester en cours, avec tes changements non indexés, pour être relu.
- Ne modifie pas le dossier du projet (${view.targetPath ?? 'dossier cible'}).
- Ne modifie que les fichiers listés ci-dessus, sauf nécessité que tu expliques (par exemple un import à corriger ailleurs après un déplacement de code).

Si un conflit demande une décision humaine (les deux intentions sont incompatibles, ou l’une n’est pas claire), ne devine pas : pose la question avec \`cerebro-notify --ask "question"\`, puis termine ton tour et attends la réponse.

Termine par un bilan court, fichier par fichier : résolu (quelle intention de chaque côté est gardée, ce que tu as adapté) ou laissé avec ses marqueurs (pourquoi). Rappelle ensuite l’étape suivante dans Cerebro : relire tes changements dans la copie, puis cliquer « Terminer la mise à jour ».`;
}
