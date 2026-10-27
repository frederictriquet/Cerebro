import { reviewInstructions } from './review.ts';
import type { CerebroDatabase } from './db.ts';
import { assertNoGitOperation, executeCommitPlan, parseCommitPlan, prepareCommit, selectionDiff, verifySnapshot, type CommitSelection } from './git-plan.ts';
import { ExpiringStore, type ExpiringStoreOptions } from './expiring-store.ts';
import { sessionProvenance, sessionWorkspace, workspaceFor } from './provenance.ts';
import { git } from './git.ts';
import type { CommitResult, Provenance, SessionGitContext, SessionGitSnapshot } from '../shared/git.ts';
export function sessionGitContext(db:CerebroDatabase,id:string):SessionGitContext {
  const session=db.getSession(id);const project=session?db.getProject(session.projectId):null;
  if(!session||!project)throw new Error('Session introuvable.');
  const workspace=workspaceFor(db,id);
  return {mode:workspace?.removedAt?'removed':workspace?.mode==='isolated'?'isolated':'shared',projectId:project.id,projectName:project.name,path:workspace?.root??project.path};
}
/** Content still identical to the copy taken from the project: it is not work from this session. */
export const INHERITED_WARNING='Contenu copié du projet à la création de la copie, inchangé depuis : ce n’est pas un travail de cette conversation.';
export interface SessionReviewSelection { snapshotId:string; selection:CommitSelection[]; commits:string[]; acknowledged:string[] }
interface SessionGitScope { sessionId:string; provenance:Provenance; uncertain:Set<string> }
/** Session selections prepared for commit or review, kept until used: one instance per server. */
export class SessionGitScopes {
  private readonly db:CerebroDatabase;private readonly scopes:ExpiringStore<SessionGitScope>;
  constructor(db:CerebroDatabase,options:ExpiringStoreOptions={}){this.db=db;this.scopes=new ExpiringStore(options);}
  async prepare(id:string):Promise<SessionGitSnapshot>{
    const workspace=sessionWorkspace(this.db,id);
    // Provenance stays readable during a merge; only a commit plan is refused early.
    await assertNoGitOperation(workspace.root);
    const snapshot=await prepareCommit(workspace.root,workspace);
    const provenance=await sessionProvenance(this.db,id,snapshot);
    const uncertain=new Set(snapshot.files.filter(f=>!provenance.changes.some(c=>c.path===f.path&&c.certainty==='workspace')).map(f=>f.path));
    this.scopes.set(snapshot.id,{sessionId:id,provenance,uncertain});
    return {...snapshot,provenance,scopeNotice:provenance.workspace.mode==='shared'?'Dossier partagé du projet : les changements appartiennent au périmètre du projet, sans attribution individuelle par conversation.':provenance.workspace.mode==='unknown'?'Provenance inconnue : choisissez explicitement chaque fichier ou hunk. Aucun propriétaire n’est déduit du dépôt.':provenance.warning,
      files:snapshot.files.map(f=>({...f,warnings:!uncertain.has(f.path)?f.warnings:[...f.warnings,provenance.workspace.mode==='isolated'&&!provenance.changes.some(c=>c.path===f.path)?INHERITED_WARNING:'Attribution incertaine ou changement initial : sélection manuelle requise.']}))};
  }
  private scope(id:string,snapshotId:string):SessionGitScope{
    const scope=this.scopes.get(snapshotId);
    if(!scope||scope.sessionId!==id)throw new Error('Sélection de session absente ou expirée.');
    return scope;
  }
  async executeCommit(id:string,raw:unknown):Promise<CommitResult>{
    const plan=parseCommitPlan(raw);const saved=this.scope(id,plan.snapshotId);
    for(const selected of plan.commits.flatMap(c=>c.selection))if(saved.uncertain.has(selected.path)&&!plan.acknowledged.includes(selected.path))throw new Error(`Sélection incertaine : confirmez explicitement ${selected.path} dans acknowledged.`);
    return executeCommitPlan(saved.provenance.workspace.root,plan);
  }
  async reviewContext(id:string,raw:unknown):Promise<{prompt:string;root:string}>{
    const p=raw as SessionReviewSelection;
    if(!p||typeof p.snapshotId!=='string'||!Array.isArray(p.selection)||!Array.isArray(p.commits)||!p.commits.every(c=>typeof c==='string')||!Array.isArray(p.acknowledged)||!p.acknowledged.every(c=>typeof c==='string'))throw new Error('Sélection de review invalide.');
    const saved=this.scope(id,p.snapshotId);const root=saved.provenance.workspace.root;
    const snapshot=await verifySnapshot(root,p.snapshotId);
    for(const selected of p.selection)if(saved.uncertain.has(selected.path)&&!p.acknowledged.includes(selected.path))throw new Error(`Confirmez la sélection incertaine de ${selected.path}.`);
    const patches:string[]=[];
    if(p.selection.length)patches.push(selectionDiff(snapshot,p.selection));
    for(const oid of [...new Set(p.commits)]){
      const commit=saved.provenance.commits.find(c=>c.hash===oid);
      if(!commit)throw new Error('Commit absent de la provenance préparée.');
      if(commit.certainty==='uncertain'&&!p.acknowledged.includes(oid))throw new Error('Confirmez explicitement le périmètre du commit incertain.');
      patches.push(await git(root,['show','--format=fuller','--binary','--no-ext-diff','--no-textconv',oid],{maxBuffer:4*1024*1024}));
    }
    if(!patches.length)throw new Error('Choisissez au moins un fichier, hunk ou commit.');
    const context=patches.join('\n');if(Buffer.byteLength(context)>4*1024*1024)throw new Error('Contexte de review trop volumineux.');
    await verifySnapshot(root,p.snapshotId);
    return {root,prompt:reviewInstructions(root,{head:snapshot.head,...p},context)};
  }
}
