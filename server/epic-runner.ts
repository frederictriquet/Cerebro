import { createHash, randomUUID } from 'node:crypto';
import type { CerebroDatabase } from './db.ts';
import type { CommandExecutor } from './commands.ts';
import type { SessionEvent, SessionManager } from './sessions.ts';
import { workspaceFor } from './provenance.ts';
import { assertEpicWorkspace, EpicWorkspaceConflict, epicWorkspace, gitInfo, rememberEpicWorkspace, selectEpicWorkspace, withEpicWorkspace } from './epic-workspace.ts';
import { epicReviewInstructions, epicReviewScope, isReviewTask } from './epic-review.ts';
import { resolve } from 'node:path';
import { canonicalWorktreePath } from './worktree-gate.ts';
import { errorMessage } from './util.ts';
import type { Epic, SessionDefaults, Task } from '../shared/types.ts';
import type { WorkspaceContext } from '../shared/git.ts';
import { isActiveRun, type CommandRun, type EpicRun } from '../shared/backlog.ts';
const headOf=async(path:string):Promise<string|null>=>await gitInfo(path,['rev-parse','--verify','HEAD'])||null;
const askedQuestion=(session:{status:string;attentionReason:string|null}):boolean=>session.status==='waiting'&&!!session.attentionReason?.startsWith('Question : ');
const version=(t:Task):string=>createHash('sha256').update(JSON.stringify([t.text,t.dependsOn.slice().sort(),t.execution,t.epicId])).digest('hex');
const ACTIVE_RUN="json_extract(data,'$.status') IN ('running','waiting-validation','blocked')";
interface ResolvedWorkspace{context:WorkspaceContext|null|undefined;conflict:boolean;error:string|null}
const resolveWorkspace=(db:CerebroDatabase,epicId:string):ResolvedWorkspace=>{
  // An unresolvable epic must remain inspectable: its runs carry the cause that start/resume would raise.
  try{return {context:epicWorkspace(db,epicId),conflict:false,error:null};}
  catch(cause){return {context:undefined,conflict:cause instanceof EpicWorkspaceConflict,error:errorMessage(cause)};}
};
const withWorkspace=(run:EpicRun,{context,conflict,error}:ResolvedWorkspace):EpicRun=>{
  const workspace=context===undefined?run.workspace??null:context;
  return {...run,workspace,contextRoot:workspace?.path??run.contextRoot,workspaceConflict:conflict,workspaceError:error};
};
// The fields of a run that the recovery of its epic's folder reads.
const workspaceTrace=(run:EpicRun):string=>JSON.stringify([run.workspace??null,run.contextRoot,run.sessionId,run.commandRunId,Object.keys(run.results).length>0,run.status==='succeeded']);
export function taskOrder(tasks:Task[],all:Task[]):Task[]{
  const byId=new Map(all.map(t=>[t.id,t]));const ids=new Set(tasks.map(t=>t.id));const placed=new Set<string>();const result:Task[]=[];
  for(const task of tasks)for(const id of task.dependsOn){const dependency=byId.get(id);if(!dependency)throw new Error('Dépendance introuvable.');if(!ids.has(id)&&dependency.status!=='done')throw new Error('Dépendance hors epic non terminée.');}
  while(result.length<tasks.length){const next=tasks.find(t=>!placed.has(t.id)&&t.dependsOn.every(id=>!ids.has(id)||placed.has(id)));if(!next)throw new Error('Cycle de dépendances.');result.push(next);placed.add(next.id);}
  return result;
}
export class EpicRunner {
  onResult:(run:EpicRun)=>void=()=>{};
  // A session often waits briefly at launch (accepted startup prompt, false positive of the screen heuristic): only a lasting wait blocks the run.
  waitingGraceMs=12_000;
  // Safety net for history changes that reach the database without an event.
  workspaceTtlMs=30_000;
  private db:CerebroDatabase;private sessions:SessionManager;private commands:CommandExecutor;private broadcast:(event:unknown)=>void;
  private busy=new Set<string>();private workspaces=new Map<string,ResolvedWorkspace&{at:number}>();
  // Last unresolved-folder cause logged per epic: kept across cache invalidations so each cause is logged once.
  private loggedWorkspaceErrors=new Map<string,string>();private timer:NodeJS.Timeout|null=null;private closed=false;private inFlight=new Set<Promise<void>>();
  // Command runs started and sessions known since the runner exists: their first event is a creation.
  private liveCommands=new Set<string>();private knownSessions:Set<string>;
  constructor(db:CerebroDatabase,sessions:SessionManager,commands:CommandExecutor,broadcast:(event:unknown)=>void){this.db=db;this.sessions=sessions;this.commands=commands;this.broadcast=broadcast;this.knownSessions=new Set(db.listSessions().map(session=>session.id));}
  initialize():void{this.timer=setInterval(()=>{try{this.poke();}catch(cause){console.error('Epic : tour de planification en échec :',cause);}},1000);this.timer.unref();this.poke();}
  close():void{this.closed=true;if(this.timer)clearInterval(this.timer);}
  async shutdown():Promise<void>{this.close();await Promise.allSettled([...this.inFlight]);}
  list(epicId?:string):EpicRun[]{const rows=(this.db.connection.prepare(epicId?'SELECT data FROM epic_runs WHERE epic_id=? ORDER BY rowid DESC':'SELECT data FROM epic_runs ORDER BY rowid DESC').all(...(epicId?[epicId]:[])) as {data:string}[]);const resolved=new Map<string,ResolvedWorkspace>();return rows.map(row=>{
    const run=JSON.parse(row.data) as EpicRun;
    if(!resolved.has(run.epicId))resolved.set(run.epicId,resolveWorkspace(this.db,run.epicId));
    return withWorkspace(run,resolved.get(run.epicId)!);
  });}
  // Stored runs as saved, without resolving the epic's folder: enough to read a status or a setting.
  private stored(id:string):EpicRun|null{const row=this.db.connection.prepare('SELECT data FROM epic_runs WHERE id=?').get(id) as {data:string}|undefined;return row?JSON.parse(row.data) as EpicRun:null;}
  // A single run with its epic's folder, resolved through the polling cache rather than by rescanning every epic.
  private resolved(run:EpicRun):EpicRun{return withWorkspace(run,this.cachedWorkspace(run.epicId));}
  reserved(taskId:string):boolean{return (this.db.connection.prepare(`SELECT data FROM epic_runs WHERE ${ACTIVE_RUN}`).all() as {data:string}[]).some(row=>(JSON.parse(row.data) as EpicRun).order.includes(taskId));}
  // Resolving an epic's folder scans its whole history: the polling loop reuses it until a session, command or run changes it.
  invalidateWorkspaces(epicId?:string):void{if(epicId)this.workspaces.delete(epicId);else this.workspaces.clear();}
  // Output arrives chunk by chunk: only a run's creation (its folder) and its end concern the history of its epic.
  commandChanged(run:CommandRun):void{
    const created=!this.liveCommands.has(run.id);
    if(run.finishedAt===null)this.liveCommands.add(run.id);else this.liveCommands.delete(run.id);
    if(!created&&run.finishedAt===null)return;
    const epicId=this.db.getTask(run.taskId)?.epicId;if(epicId)this.invalidateWorkspaces(epicId);
  }
  // Status, attention or title changes elsewhere leave every epic's history intact.
  sessionChanged(event:SessionEvent):void{
    if(event.type==='session'){
      const created=!this.knownSessions.has(event.session.id);this.knownSessions.add(event.session.id);
      // A new copy can be the folder an earlier run or command of any epic recorded.
      if(created)this.invalidateWorkspaces();else if(event.session.epic)this.invalidateWorkspaces(event.session.epic.id);
    }else if(event.type==='session-deleted'){this.knownSessions.delete(event.id);this.invalidateWorkspaces();}
    else if(event.type==='projects')this.invalidateWorkspaces();
  }
  private cachedWorkspace(epicId:string):ResolvedWorkspace{
    const cached=this.workspaces.get(epicId);if(cached&&Date.now()-cached.at<this.workspaceTtlMs)return cached;
    const resolved={...resolveWorkspace(this.db,epicId),at:Date.now()};this.workspaces.set(epicId,resolved);
    // A running epic keeps its last known folder: record why its history no longer resolves, once per cause.
    if(!resolved.error)this.loggedWorkspaceErrors.delete(epicId);
    else if(!resolved.conflict&&this.loggedWorkspaceErrors.get(epicId)!==resolved.error){this.loggedWorkspaceErrors.set(epicId,resolved.error);console.error(`Epic ${epicId} : dossier de travail introuvable : ${resolved.error}`);}
    return resolved;
  }
  private save(run:EpicRun,updateSettings=false):void{const previous=this.stored(run.id);
    // A setting can change while an asynchronous launch holds an older copy of the run.
    if(!updateSettings)run.autoValidate=previous?.autoValidate??run.autoValidate??false;
    run.updatedAt=Date.now();
    // A deleted epic takes its runs with it: a step finishing afterwards must not resurrect them.
    const saved=Number(this.db.connection.prepare('INSERT INTO epic_runs SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM epics WHERE id=?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id,run.epicId,JSON.stringify({...run,workspaceError:undefined}),run.epicId).changes)>0;
    if(!saved){this.invalidateWorkspaces(run.epicId);this.loggedWorkspaceErrors.delete(run.epicId);return;}
    if(['failed','stopped','succeeded'].includes(run.status))this.loggedWorkspaceErrors.delete(run.epicId);
    if(!previous||workspaceTrace(previous)!==workspaceTrace(run))this.invalidateWorkspaces(run.epicId);
    // Clients follow runs through these events instead of polling; a tick that only refreshes updatedAt is not announced.
    // The workspace is resolved after the write, since the run's own row feeds it; any change it reflects also shows in the run's other fields.
    const workspace=this.cachedWorkspace(run.epicId);const current=withWorkspace(run,workspace);const content=(r:EpicRun):string=>JSON.stringify({...r,updatedAt:0});
    if(!previous||content(withWorkspace(previous,workspace))!==content(current))this.broadcast({type:'epic-run',run:current});
    if(['failed','succeeded','blocked'].includes(run.status)&&(previous?.status!==run.status||previous?.error!==run.error))this.onResult(run);}
  // Nobody awaits a tick: a transient SQLite failure is logged and retried on the next poke instead of rejecting.
  private persist(run:EpicRun):boolean{try{this.save(run);return true;}catch(cause){console.error(`Epic ${run.epicId} : exécution ${run.id} non enregistrée :`,cause);return false;}}
  private changeTask(id:string,patch:Parameters<CerebroDatabase['updateTask']>[1]):void{const task=this.db.updateTask(id,patch);if(task)this.broadcast({type:'task',task});}
  private plan(epicId:string){
    const epic=this.db.getEpic(epicId);if(!epic)throw new Error('Epic introuvable.');
    const all=this.db.listTasks().filter(t=>t.projectId===epic.projectId);const members=all.filter(t=>t.epicId===epicId);const open=members.filter(t=>t.status!=='done');
    for(const task of open)if(this.commands.active(task.id)||task.sessionId&&this.db.getSession(task.sessionId)?.status!=='exited')throw new Error('Une tâche est déjà confiée à une exécution active.');
    return {epic,members,order:taskOrder(open,all)};
  }
  // Serialized with the epic's other workspace operations: no concurrent start, folder choice or step launch can slip in while HEAD is read.
  start(epicId:string,options:SessionDefaults):Promise<EpicRun>{return withEpicWorkspace(this.db,epicId,async()=>{
    const runs=this.list(epicId);
    if(runs.some(isActiveRun))throw new Error('Epic déjà en cours : utilisez reprendre ou arrêter.');
    const {epic,members,order}=this.plan(epicId);if(!order.length)throw new Error('Aucune tâche ouverte.');
    const project=this.db.getProject(epic.projectId)!;const previous=runs[0];
    const workspace=epicWorkspace(this.db,epicId);if(workspace)assertEpicWorkspace(this.db,workspace);
    const contextRoot=workspace?.path??project.path;
    // A later run (for example review fixes) continues the work and keeps its original review base.
    const baseHead=(previous?.contextRoot===contextRoot?previous.baseHead:null)??await headOf(contextRoot);
    // A run resumed while HEAD was read would otherwise run alongside this one.
    if(this.list(epicId).some(isActiveRun))throw new Error('Epic déjà en cours : utilisez reprendre ou arrêter.');
    const run:EpicRun={id:randomUUID(),epicId,projectId:epic.projectId,status:'running',order:order.map(t=>t.id),members:members.map(t=>t.id),versions:Object.fromEntries(order.map(t=>[t.id,version(t)])),results:{},currentTaskId:null,sessionId:null,commandRunId:null,stepStartedAt:0,contextRoot,workspace,baseHead,options,error:null,startedAt:Date.now(),updatedAt:Date.now()};
    this.save(run);this.poke();return run;
  });}
  report(sessionId:string,taskId:string,status:'failed'|'blocked'|'waiting-validation',message:string):EpicRun{
    const run=(this.db.connection.prepare(`SELECT data FROM epic_runs WHERE json_extract(data,'$.currentTaskId')=? AND ${ACTIVE_RUN} ORDER BY rowid DESC`).all(taskId) as {data:string}[]).map(row=>JSON.parse(row.data) as EpicRun).find(r=>r.sessionId===sessionId);
    if(!run||this.db.getTask(taskId)?.sessionId!==sessionId)throw new Error('Cette étape n’est pas confiée à cette session.');
    run.results[taskId]=status;run.status=status;run.error=message;run.validationReason=status==='waiting-validation'?message:null;run.blockReason=null;this.save(run);return this.resolved(run);
  }
  setAutoValidate(id:string,enabled:boolean):EpicRun{
    const run=this.stored(id);if(!run)throw new Error('Exécution introuvable.');
    if(!isActiveRun(run))throw new Error('Cette exécution n’est plus en cours.');
    run.autoValidate=enabled;this.save(run,true);this.poke();return this.resolved(run);
  }
  stop(id:string):EpicRun{
    const run=this.stored(id);if(!run)throw new Error('Exécution introuvable.');
    run.status='stopped';run.error='Arrêt demandé par l’utilisateur.';this.save(run);
    if(run.commandRunId)this.commands.stop(run.commandRunId);if(run.sessionId)this.sessions.kill(run.sessionId);return this.resolved(run);
  }
  selectWorkspace(epicId:string,path:string):WorkspaceContext{
    if(!this.db.getEpic(epicId))throw new Error('Epic introuvable.');
    const runs=this.list(epicId);
    if(runs.some(run=>this.busy.has(run.id)||run.status==='running'||run.status==='waiting-validation'||run.status==='blocked'&&run.blockReason==='session-waiting'))
      throw new Error('Arrêtez l’epic avant de choisir son dossier de travail.');
    const tasks=this.db.listTasks().filter(task=>task.epicId===epicId);
    if(tasks.some(task=>this.commands.active(task.id)||task.status!=='done'&&task.sessionId&&this.db.getSession(task.sessionId)?.status!=='exited')
      ||this.db.listSessions().some(session=>session.epic?.id===epicId&&['starting','running','waiting'].includes(session.status)))
      throw new Error('Arrêtez les étapes encore actives avant de choisir le dossier de l’epic.');
    const context=selectEpicWorkspace(this.db,epicId,path);this.invalidateWorkspaces(epicId);
    for(const run of runs)if(run.status==='blocked'&&run.error?.includes('Cet epic a utilisé plusieurs dossiers de travail')){
      run.workspace=context;run.contextRoot=context.path;run.workspaceConflict=false;run.blockReason=null;
      run.error='Dossier choisi. Reprenez l’epic pour poursuivre.';this.save(run);
    }
    return context;
  }
  resume(id:string,replan=false):EpicRun{
    const stored=this.stored(id);
    if(!stored||stored.status==='succeeded'||stored.status==='running')throw new Error('Exécution non reprenable.');
    if(this.busy.has(id))throw new Error('Une étape est encore en cours de lancement.');
    if(this.db.connection.prepare(`SELECT 1 FROM epic_runs WHERE epic_id=? AND id<>? AND ${ACTIVE_RUN}`).get(stored.epicId,id))throw new Error('Une autre exécution est active.');
    const workspace=epicWorkspace(this.db,stored.epicId);
    if(workspace)assertEpicWorkspace(this.db,workspace);
    const run=withWorkspace(stored,{context:workspace,conflict:false,error:null});
    if(run.currentTaskId)this.releaseInterruptedStep(run,run.currentTaskId,workspace);
    if(replan)this.replanOrder(run);
    run.status='running';
    run.error=null;
    run.blockReason=null;
    this.save(run);
    this.poke();
    return run;
  }
  // A step whose terminal or command ended without closing it, or that ran in another folder than the epic's, is handed back to the backlog so the run relaunches it.
  private releaseInterruptedStep(run:EpicRun,taskId:string,workspace:WorkspaceContext|null):void{
    const task=this.db.getTask(taskId);
    const session=run.sessionId?this.db.getSession(run.sessionId):null;
    const command=run.commandRunId?this.commands.getRun(run.commandRunId):null;
    if(session?.status==='waiting')throw new Error('Répondez d’abord à la question de la session.');
    const prior=session?workspaceFor(this.db,session.id):null;
    const elsewhere=workspace&&((prior&&canonicalWorktreePath(prior.path)!==canonicalWorktreePath(workspace.path))
      ||(command&&canonicalWorktreePath(command.cwd)!==canonicalWorktreePath(resolve(workspace.path,command.command.cwd))));
    if(elsewhere&&(session&&session.status!=='exited'||command?.status==='running'))throw new Error('Arrêtez l’étape en cours dans l’ancien dossier avant de poursuivre.');
    const interrupted=task?.status!=='done'&&(!session||session.status==='exited')&&command?.status!=='running'&&command?.status!=='succeeded';
    if(!elsewhere&&!interrupted)return;
    if(!workspace&&session)run.contextRoot=workspaceFor(this.db,session.id)?.path??run.contextRoot;
    if(task&&task.status!=='done')this.changeTask(task.id,{status:'todo',sessionId:null});
    this.clearStep(run);
  }
  // Recomputes the order from the epic's current tasks, keeping the active step if it still belongs to the epic.
  private replanOrder(run:EpicRun):void{
    if(!this.db.getEpic(run.epicId))throw new Error('Epic supprimé.');
    const all=this.db.listTasks().filter(t=>t.projectId===run.projectId);
    const members=all.filter(t=>t.epicId===run.epicId);
    if(run.currentTaskId&&!members.some(t=>t.id===run.currentTaskId))throw new Error('L’étape active a quitté l’epic : arrêtez son exécution avant de recalculer.');
    const order=taskOrder(members.filter(t=>t.status!=='done'),all);
    run.order=order.map(t=>t.id);
    run.members=members.map(t=>t.id);
    run.versions=Object.fromEntries(order.map(t=>[t.id,version(t)]));
  }
  private clearStep(run:EpicRun):void{
    run.currentTaskId=null;
    run.sessionId=null;
    run.commandRunId=null;
    run.waitingSince=null;
    run.validationReason=null;
  }
  poke():void{
    if(this.closed)return;
    // Finished runs are never scanned again, and only a run about to advance needs its epic's folder.
    for(const row of this.db.connection.prepare(`SELECT data FROM epic_runs WHERE ${ACTIVE_RUN} ORDER BY rowid DESC`).all() as {data:string}[]){
      const stored=JSON.parse(row.data) as EpicRun;if(this.busy.has(stored.id))continue;
      const waitOver=stored.status==='blocked'&&stored.blockReason==='session-waiting'&&this.waitOver(stored);
      if(!waitOver&&!['running','waiting-validation'].includes(stored.status))continue;
      const run=withWorkspace(stored,this.cachedWorkspace(stored.epicId));
      if(waitOver){run.status='running';run.error=null;run.blockReason=null;run.waitingSince=null;if(!this.persist(run))continue;}
      this.busy.add(run.id);const promise=this.tick(run).catch(cause=>{const latest=this.stored(run.id);if(!latest){this.abandon(run);return;}if(latest.status==='stopped')return;run.status='blocked';run.error=errorMessage(cause);run.blockReason=null;this.persist(run);}).finally(()=>{this.busy.delete(run.id);this.inFlight.delete(promise);});this.inFlight.add(promise);
    }
  }
  // The step's session no longer holds the run: it stopped waiting, or its task is done and it is not asking an explicit question.
  private waitOver(run:EpicRun):boolean{
    const session=run.sessionId?this.db.getSession(run.sessionId):null;if(!session||session.status!=='waiting')return true;
    return this.db.getTask(run.currentTaskId??'')?.status==='done'&&!askedQuestion(session);
  }
  private async tick(run:EpicRun):Promise<void>{
    const epic=this.db.getEpic(run.epicId);
    if(!epic){this.halt(run,'blocked','Epic supprimé.');return;}
    if(!this.planUnchanged(run))return;
    if(run.currentTaskId&&!this.completeStep(run,this.db.getTask(run.currentTaskId)!))return;
    const next=this.resolveStep(run);
    if(!next)return;
    await this.launchStep(run,epic,next);
    this.abortIfStopped(run);
  }
  // Leaves the run in a state that ends this tick, with its cause.
  private halt(run:EpicRun,status:EpicRun['status'],error:string,blockReason:EpicRun['blockReason']=null):void{
    run.status=status;
    run.error=error;
    run.blockReason=blockReason;
    this.save(run);
  }
  // The order was computed from the epic's tasks as they were: any later change to them needs a resume with replan.
  private planUnchanged(run:EpicRun):boolean{
    const members=this.db.listTasks().filter(t=>t.epicId===run.epicId);
    if(members.map(t=>t.id).sort().join(',')!==run.members.slice().sort().join(',')){
      this.halt(run,'blocked','Composition de l’epic modifiée : reprise avec recalcul nécessaire.');
      return false;
    }
    for(const id of run.order){
      const task=this.db.getTask(id);
      if(!task||version(task)!==run.versions[id]){
        this.halt(run,'blocked','Tâche ou dépendances modifiées : reprise avec recalcul nécessaire.');
        return false;
      }
    }
    return true;
  }
  // Follows the current step; true once it is closed and the run can move on to the next one.
  private completeStep(run:EpicRun,task:Task):boolean{
    if(task.dependsOn.some(id=>this.db.getTask(id)?.status!=='done')){
      this.halt(run,'blocked','Un prérequis de l’étape courante a été rouvert.');
      return false;
    }
    const closed=task.execution.type==='command'?this.completeCommandStep(run,task,task.execution.completion):this.completeSessionStep(run,task);
    if(!closed)return false;
    this.clearStep(run);
    run.status='running';
    run.error=null;
    this.save(run);
    return true;
  }
  private completeCommandStep(run:EpicRun,task:Task,completion:'manual'|'exit-zero'):boolean{
    const command=this.commands.listRuns(task.id).find(r=>r.id===run.commandRunId||!run.commandRunId&&r.startedAt>=run.stepStartedAt);
    if(!command){
      this.halt(run,'blocked','Lancement de commande interrompu : vérifiez puis reprenez explicitement.');
      return false;
    }
    run.commandRunId=command.id;
    if(command.status==='running'){this.save(run);return false;}
    if(command.status!=='succeeded'){
      run.results[task.id]=command.status;
      this.halt(run,'failed',command.error??`Échec de commande : ${command.status}, code ${command.exitCode}`);
      return false;
    }
    const autoValidated=task.status!=='done'&&completion!=='exit-zero'&&run.autoValidate;
    if(task.status!=='done'&&(completion==='exit-zero'||autoValidated))this.changeTask(task.id,{status:'done'});
    else if(task.status!=='done'){
      run.results[task.id]='execution-succeeded';
      this.halt(run,'waiting-validation','Commande réussie ; validation explicite du travail attendue.');
      return false;
    }
    run.results[task.id]=completion==='exit-zero'?'criterion-exit-zero':autoValidated?'auto-validated':'validated';
    return true;
  }
  private completeSessionStep(run:EpicRun,task:Task):boolean{
    const marker=`[CEREBRO_EPIC_STEP ${run.id} ${task.id}]`;
    const session=run.sessionId?this.db.getSession(run.sessionId):this.db.listSessions().find(s=>s.prompt.startsWith(marker));
    if(!session){
      this.halt(run,'blocked','Lancement de session interrompu : vérifiez puis reprenez explicitement.');
      return false;
    }
    run.sessionId=session.id;
    if(task.sessionId!==session.id)this.changeTask(task.id,{sessionId:session.id,status:'started'});
    if(session.status==='running'||session.status==='starting'){
      run.waitingSince=null;
      this.save(run);
      return false;
    }
    // An explicit question (cerebro-notify --ask) blocks at once; any other wait must last beyond the grace delay.
    if(session.status==='waiting'&&!askedQuestion(session)){
      run.waitingSince??=session.updatedAt;
      if(Date.now()-run.waitingSince<this.waitingGraceMs){this.save(run);return false;}
    }else run.waitingSince=null;
    const autoValidated=task.status!=='done'&&run.autoValidate&&(session.status==='idle'||session.status==='exited'&&session.exitCode===0);
    if(autoValidated)this.changeTask(task.id,{status:'done'});
    if(task.status!=='done'&&!autoValidated){
      if(session.status==='exited'&&session.exitCode!==null&&session.exitCode!==0){
        run.results[task.id]='failed';
        this.halt(run,'failed',`Session sortie avec code ${session.exitCode}.`);
        return false;
      }
      // Keep the agent's validation requirements instead of replacing them with the generic end-of-turn notice.
      const reason=(session.status!=='waiting'?run.validationReason:null)
        ??session.attentionReason??'Tour terminé sans clôture explicite de la tâche.';
      if(session.status==='waiting'){
        run.results[task.id]='blocked';
        this.halt(run,'blocked',reason,'session-waiting');
      }else{
        run.results[task.id]='waiting-validation';
        this.halt(run,'waiting-validation',reason);
      }
      return false;
    }
    // Once the step is declared done, only an explicit question holds it: a lasting screen-detected wait no longer matters.
    if(askedQuestion(session)){
      this.halt(run,'blocked','Une question de la session reste en attente.','session-waiting');
      return false;
    }
    run.contextRoot=workspaceFor(this.db,session.id)?.path??run.contextRoot;
    run.results[task.id]=autoValidated?'auto-validated':'declared-done';
    // The step is closed and its turn is over: free the terminal so finished steps do not pile up. The workspace stays for the next step.
    if(session.status!=='exited')this.sessions.kill(session.id);
    return true;
  }
  // The next task whose prerequisites are done; null when the run succeeded or cannot advance.
  private resolveStep(run:EpicRun):Task|null{
    const pending=run.order.map(id=>this.db.getTask(id)!).filter(t=>t.status!=='done');
    if(!pending.length){
      run.status='succeeded';
      run.error=null;
      this.save(run);
      return null;
    }
    const next=pending.find(t=>t.dependsOn.every(id=>this.db.getTask(id)?.status==='done'));
    if(!next){
      this.halt(run,'blocked','Aucune tâche éligible : dépendance non satisfaite.');
      return null;
    }
    if(this.commands.active(next.id)||next.sessionId&&this.db.getSession(next.sessionId)?.status!=='exited'){
      this.halt(run,'blocked','La tâche suivante possède déjà une exécution active.');
      return null;
    }
    return next;
  }
  private async launchStep(run:EpicRun,epic:Epic,next:Task):Promise<void>{
    run.currentTaskId=next.id;
    run.stepStartedAt=Date.now();
    this.save(run);
    if(next.execution.type==='command')await this.launchCommand(run,next);
    else await this.launchSession(run,epic,next);
  }
  private async launchCommand(run:EpicRun,next:Task):Promise<void>{
    const operation=await withEpicWorkspace(this.db,run.epicId,async()=>{
      const workspace=epicWorkspace(this.db,run.epicId)??{path:run.contextRoot,mode:'shared' as const};
      assertEpicWorkspace(this.db,workspace);
      const operation=await this.commands.start(next.id,workspace.path);
      // Known before the folder is recorded, so a deletion of the epic in between can still stop it.
      run.commandRunId=operation.id;
      run.workspace=rememberEpicWorkspace(this.db,run.epicId,workspace);
      run.contextRoot=workspace.path;
      return operation;
    });
    run.commandRunId=operation.id;
  }
  private async launchSession(run:EpicRun,epic:Epic,next:Task):Promise<void>{
    const project=this.db.getProject(run.projectId)!;
    const title=`Epic « ${epic.title} » · étape ${run.order.indexOf(next.id)+1}/${run.order.length} : ${next.text.split('\n')[0]}`.slice(0,120);
    // The review step is told what the previous steps changed; a scope that cannot be prepared leaves the agent to find it.
    const review=isReviewTask(next)?`\n\n${epicReviewInstructions(epic.title,await epicReviewScope(this.db,run).catch(()=>null))}`:'';
    const prompt=`[CEREBRO_EPIC_STEP ${run.id} ${next.id}]\nTraite uniquement cette étape de l’epic « ${epic.title} ».\n${epic.description}\n\n${next.text}${review}\n\nIdentifiant : ${next.id}\nRéalise et vérifie cette tâche, puis exécute cerebro-backlog --done ${next.id} uniquement si elle est terminée. En cas d’échec utilise cerebro-backlog --fail <id> "raison" ; en cas de blocage utilise --block ; pour une validation nécessaire utilise --await-validation. Explique le résultat et termine ton tour. Le serveur pilote l’enchaînement : ne traite aucune autre tâche.\n\nInstructions supplémentaires : ${run.options.prompt}`;
    this.changeTask(next.id,{status:'started',sessionId:null});
    const session=await this.sessions.create(project,{...run.options,prompt},{validate:async()=>{
      const latest=this.stored(run.id);
      if(this.closed||!latest||latest.status==='stopped')throw new Error('Epic arrêté avant le lancement du terminal.');
      const pending=this.db.listSessions().find(s=>s.prompt===prompt);
      if(pending){
        run.sessionId=pending.id;
        this.changeTask(next.id,{sessionId:pending.id});
        const workspace=workspaceFor(this.db,pending.id);
        if(workspace){
          run.workspace=rememberEpicWorkspace(this.db,run.epicId,{path:workspace.path,mode:workspace.mode});
          run.contextRoot=workspace.path;
        }
        this.save(run);
      }
    },contextPath:run.contextRoot,title,rememberDefaults:false,epicId:epic.id});
    run.sessionId=session.id;
    this.changeTask(next.id,{sessionId:session.id});
  }
  // A stop can arrive while the holder is starting. Preserve it and stop the new operation too.
  private abortIfStopped(run:EpicRun):void{
    const latest=this.stored(run.id);
    if(!latest){this.abandon(run);return;}
    if(this.closed||latest?.status==='stopped'){
      if(run.commandRunId)this.commands.stop(run.commandRunId);
      if(run.sessionId)this.sessions.kill(run.sessionId);
      run.status='stopped';
    }
    this.save(run);
  }
  // The epic was deleted during the step's launch, taking its run with it: nothing would follow this step any more, so it is undone and its task handed back to the backlog.
  private abandon(run:EpicRun):void{
    if(run.commandRunId)this.commands.stop(run.commandRunId);
    if(run.sessionId)this.sessions.kill(run.sessionId);
    const task=run.currentTaskId?this.db.getTask(run.currentTaskId):null;
    if(task&&task.status!=='done')this.changeTask(task.id,{status:'todo',sessionId:null});
  }
}
