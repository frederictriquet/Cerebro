import { FINDING_INSTRUCTIONS } from './findings.ts';
import type { CerebroDatabase } from './db.ts';
import { workspaceAt } from './provenance.ts';
import { git as runGit, repositoryRoot } from './git.ts';
import type { Task } from '../shared/types.ts';
import type { EpicRun } from '../shared/backlog.ts';
const git=async(path:string,args:string[]):Promise<string>=>(await runGit(path,args)).trim();
const lines=(text:string):string[]=>text.split('\n').filter(Boolean);
/** First line of the final review step added by « Ajouter une étape de review » ; the runner completes its prompt at launch. */
export const REVIEW_TASK_TITLE='Code review du travail de l’epic';
export const isReviewTask=(task:Pick<Task,'text'>):boolean=>task.text.split('\n')[0]===REVIEW_TASK_TITLE;
export const reviewTaskText=(epicTitle:string):string=>`${REVIEW_TASK_TITLE}\nRelis le travail réalisé par les étapes précédentes de l’epic « ${epicTitle} » dans ce dossier, sans rien modifier. Le serveur ajoute le périmètre (commit de base, commits, fichiers) au lancement de l’étape.`;
// The prompt travels as one command-line argument: list names and subjects, never the diff itself.
const MAX_LISTED=200;
export interface EpicReviewScope {
  root:string;
  /** Directory of the epic's work: the session joins it, and so reads the code exactly as the steps left it. */
  path:string;
  mode:'isolated'|'shared';
  base:string|null;
  head:string;
  commits:string[];
  files:string[];
}
/** What the epic changed: its shared worktree against the commit it started from, or the project folder against the HEAD recorded at launch. */
export async function epicReviewScope(db:CerebroDatabase,run:Pick<EpicRun,'projectId'|'contextRoot'|'baseHead'|'workspace'>):Promise<EpicReviewScope>{
  const project=db.getProject(run.projectId);if(!project)throw new Error('Projet introuvable.');
  const path=run.workspace?.path??run.contextRoot;
  const workspace=workspaceAt(db,path);
  if(!workspace&&(run.workspace?run.workspace.mode==='isolated':project.workspaceMode!=='shared'))throw new Error('Le worktree de l’epic est introuvable ou a été retiré : aucun travail à relire.');
  const root=workspace?.root??await repositoryRoot(path).catch(()=>{throw new Error('Le dossier de l’epic n’est pas un dépôt Git.');});
  const head=await git(root,['rev-parse','--verify','HEAD']).catch(()=>{throw new Error('Dépôt sans commit : aucun travail à relire.');});
  const base=workspace?.base??run.baseHead??null;
  const committed=base&&base!==head;
  const commits=committed?lines(await git(root,['log','--reverse','--format=%h %s',`${base}..HEAD`])):[];
  const files=[...new Set([
    ...(committed?lines(await git(root,['diff','--name-only','--no-renames',base,'HEAD'])):[]),
    ...lines(await git(root,['diff','--name-only','--no-renames','HEAD'])),
    ...lines(await git(root,['ls-files','--others','--exclude-standard'])),
  ])].sort();
  if(!files.length&&!commits.length)throw new Error('Aucun changement à relire : le travail de l’epic n’a rien modifié.');
  return {root,path,mode:workspace?'isolated':'shared',base,head,commits,files};
}
export function epicReviewInstructions(epicTitle:string,scope:EpicReviewScope|null):string{
  const head=`Fais une code review du travail produit par l’epic « ${epicTitle} ». Cherche en priorité les bugs de correction, puis de sécurité et de simplicité. Vérifie chaque finding dans le code environnant. Ne modifie aucun fichier. Rapporte chaque finding avec gravité, fichier:ligne, problème, scénario concret et correctif attendu. ${FINDING_INSTRUCTIONS}`;
  if(!scope)return `${head}\n\nLe périmètre n’a pas pu être préparé par Cerebro : déduis-le avec \`git log\`, \`git status\` et \`git diff\` dans ce dossier.`;
  const diff=scope.base?`git diff ${scope.base}`:'git diff HEAD';
  const listed=(items:string[],extra:string)=>items.slice(0,MAX_LISTED).join('\n')+(items.length>MAX_LISTED?`\n… ${items.length-MAX_LISTED} ${extra} de plus (voir git).`:'');
  const shared=scope.mode==='shared'?'\nAttention : ce dossier est partagé avec le projet, le périmètre peut inclure des changements d’autres conversations.':'';
  return `${head}\n\n<perimetre_cerebro>\nDossier : ${scope.path}\nBase : ${scope.base??'aucune (modifications non commitées uniquement)'}\nHEAD : ${scope.head}\nLis le diff avec \`${diff}\` (commits et modifications non commitées des fichiers suivis) ; les fichiers non suivis sont à lire directement.${shared}\nCommits (${scope.commits.length}) :\n${listed(scope.commits,'commits')||'aucun'}\nFichiers modifiés (${scope.files.length}) :\n${listed(scope.files,'fichiers')}\n</perimetre_cerebro>`;
}
