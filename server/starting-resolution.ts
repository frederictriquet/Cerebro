import type { Workspace } from './provenance.ts';
import type { StartingContentPlan, StartingContentStep, WorktreeView } from './worktrees.ts';

const MAX_CONVERSATION_PROMPT = 2000;
const branchLabel = (branch: string | null): string => branch?.replace(/^refs\/heads\//, '') ?? 'branche inconnue';

/** Where the session can read the starting content of one file, as a command or a path. */
function startingSource(step: StartingContentStep, view: WorktreeView, workspace: Workspace): string {
  const origin = step.origin;
  if (origin?.kind === 'target-commit') return `\`git show ${origin.commit}:${step.path}\` (commit ${origin.commit.slice(0, 7)} « ${origin.subject} » de ${branchLabel(view.targetBranch)})`;
  if (origin?.kind === 'target-worktree') return `le fichier ${view.targetPath}/${step.path}, encore non commité dans le dossier de ${branchLabel(view.targetBranch)}`;
  if (origin?.kind === 'snapshot' && workspace.startingSnapshot) return `\`git show ${workspace.startingSnapshot}:${step.path}\` (instantané conservé par Cerebro à la création)`;
  return workspace.startingSnapshot
    ? `introuvable : ni dans la cible, ni identique dans l’instantané de création (\`git show ${workspace.startingSnapshot}:${step.path}\` peut en garder une version proche)`
    : 'introuvable : ni dans la cible, ni conservé à la création';
}

/**
 * Instructions for a session that separates, in the copy, the content copied from the project at creation from
 * the conversation's work, for the files the automatic removal could not settle.
 */
export function startingResolutionPrompt(view: WorktreeView, workspace: Workspace, plan: StartingContentPlan, conversation: { title: string; prompt: string } | null): string {
  const kept = plan.steps.filter(step => step.action === 'keep');
  const automatic = plan.steps.filter(step => step.action !== 'keep');
  const target = branchLabel(view.targetBranch);
  const files = kept.map(step => [
    `- ${step.path} (${step.state === 'inherited' ? 'contenu de départ seul' : 'contenu de départ et travail de la conversation mélangés'})`,
    `  Contenu de départ : ${startingSource(step, view, workspace)}`,
    `  Constat de Cerebro : ${step.reason ?? 'aucun'}`,
  ].join('\n')).join('\n');
  const context = conversation
    ? `\n\nConversation d’origine : « ${conversation.title} »${conversation.prompt.trim() ? `\nSa demande initiale :\n<demande_initiale>\n${conversation.prompt.trim().slice(0, MAX_CONVERSATION_PROMPT)}${conversation.prompt.trim().length > MAX_CONVERSATION_PROMPT ? '\n…' : ''}\n</demande_initiale>` : ''}`
    : '';
  return `Tu travailles dans la copie de travail d’une conversation Cerebro (worktree Git ${view.path}, branche ${branchLabel(view.branch ?? view.expectedBranch)}, destinée à être intégrée dans ${target}).

À sa création, la copie a reçu les fichiers alors non commités du dossier du projet : c’est le « contenu de départ ». Il n’appartient pas au travail de la conversation et doit quitter la copie, sans perdre ce que la conversation a changé depuis. Cerebro n’a pas pu séparer automatiquement les fichiers ci-dessous : fais-le au mieux, fichier par fichier.

Objectif pour chaque fichier : son contenu final = sa version au dernier commit de la copie (\`git show HEAD:<fichier>\`, absente si le fichier n’y existe pas) + uniquement les changements faits par la conversation depuis la création de la copie.

Repères :
- Commit du projet à la création de la copie : ${workspace.base ?? 'inconnu'} (\`git show ${workspace.base ?? 'HEAD'}:<fichier>\`).
- Le contenu de départ d’un fichier est ce qu’il contenait, non commité, dans le dossier du projet à la création. Changements apportés par le contenu de départ : diff entre la version du commit de création et le contenu de départ. Travail de la conversation : diff entre le contenu de départ et le fichier actuel.
- Commits déjà faits dans la copie : \`git log ${workspace.base ? `${workspace.base}..HEAD` : 'HEAD'} -- <fichier>\`. Si un commit de la copie a déjà emporté une partie du contenu de départ, ne la retire pas de ce qui est commité : traite seulement les changements non commités.

Fichiers à traiter (${kept.length}) :
${files}${context}

Méthode :
1. Pour chaque fichier, lis la version de HEAD, le contenu de départ quand il est disponible, et le fichier actuel. Isole le travail de la conversation, puis réécris le fichier pour qu’il ne contienne que la version de HEAD plus ce travail.
2. Quand le travail de la conversation modifie des lignes du contenu de départ, garde l’intention de la conversation en t’appuyant sur la version de HEAD ; ne garde du contenu de départ que ce dont ce travail a besoin pour fonctionner, et signale-le.
3. Quand le contenu de départ est introuvable, déduis-le du diff \`git diff HEAD -- <fichier>\`, de l’historique et de la demande de la conversation. S’il reste un doute sérieux sur ce qui appartient à la conversation, laisse le fichier tel quel et explique pourquoi.
4. Vérifie le résultat avec \`git diff HEAD -- <fichier>\` : il ne doit montrer que le travail de la conversation.

Contraintes :
- Ne modifie que les fichiers listés ci-dessus.${automatic.length ? ` Les autres fichiers du contenu de départ (${automatic.map(step => step.path).join(', ')}) seront traités automatiquement par « Retirer le contenu de départ » : n’y touche pas.` : ''}
- Ne crée aucun commit, ne fais ni merge, ni rebase, ni stash, ni checkout de branche : les changements restent non commités pour être relus.
- Ne modifie pas le dossier du projet (${view.targetPath ?? 'dossier cible'}).${plan.targetUpdate ? `\n- ${target} a reçu ${plan.targetUpdate.commits} commit${plan.targetUpdate.commits === 1 ? '' : 's'} depuis la création : ne les intègre pas, Cerebro le fera au retrait du contenu de départ. Travaille par rapport à HEAD de la copie.` : ''}

Termine par un bilan court, fichier par fichier : résolu (ce qui a été retiré, ce qui a été gardé) ou laissé à examiner (pourquoi). Rappelle ensuite les étapes suivantes dans Cerebro : relire tes changements, puis ouvrir « Retirer le contenu de départ… » dans la copie. Cerebro y reconnaît automatiquement les fichiers dont le contenu de départ a disparu ; les autres s’y valident en cochant leur diff une fois vérifié. Viendra ensuite « Créer le commit ».`;
}
