import { createHash, randomUUID } from 'node:crypto';
import type { CerebroDatabase, SessionDefaults, Task } from './db.ts';
import type { CommandExecutor } from './commands.ts';
import type { SessionManager } from './sessions.ts';
import { workspaceFor } from './provenance.ts';
export interface EpicRun {
  id:string;epicId:string;projectId:string;status:'running'|'waiting-validation'|'blocked'|'failed'|'stopped'|'succeeded';
  order:string[];members:string[];versions:Record<string,string>;results:Record<string,string>;
  currentTaskId:string|null;sessionId:string|null;commandRunId:string|null;stepStartedAt:number;
  contextRoot:string;options:SessionDefaults;error:string|null;startedAt:number;updatedAt:number;
}
const version=(t:Task):string=>createHash('sha256').update(JSON.stringify([t.text,t.dependsOn.slice().sort(),t.execution,t.epicId])).digest('hex');
export function taskOrder(tasks:Task[],all:Task[]):Task[]{
  const byId=new Map(all.map(t=>[t.id,t]));const ids=new Set(tasks.map(t=>t.id));const placed=new Set<string>();const result:Task[]=[];
  for(const task of tasks)for(const id of task.dependsOn){const dependency=byId.get(id);if(!dependency)throw new Error('Dépendance introuvable.');if(!ids.has(id)&&dependency.status!=='done')throw new Error('Dépendance hors epic non terminée.');}
  while(result.length<tasks.length){const next=tasks.find(t=>!placed.has(t.id)&&t.dependsOn.every(id=>!ids.has(id)||placed.has(id)));if(!next)throw new Error('Cycle de dépendances.');result.push(next);placed.add(next.id);}
  return result;
}
export class EpicRunner {
  onResult:(run:EpicRun)=>void=()=>{};
  private db:CerebroDatabase;private sessions:SessionManager;private commands:CommandExecutor;private broadcast:(event:unknown)=>void;
  private busy=new Set<string>();private timer:NodeJS.Timeout|null=null;private closed=false;private inFlight=new Set<Promise<void>>();
  constructor(db:CerebroDatabase,sessions:SessionManager,commands:CommandExecutor,broadcast:(event:unknown)=>void){this.db=db;this.sessions=sessions;this.commands=commands;this.broadcast=broadcast;}
  initialize():void{this.timer=setInterval(()=>this.poke(),1000);this.timer.unref();this.poke();}
  close():void{this.closed=true;if(this.timer)clearInterval(this.timer);}
  async shutdown():Promise<void>{this.close();await Promise.allSettled([...this.inFlight]);}
  list(epicId?:string):EpicRun[]{return (this.db.connection.prepare(epicId?'SELECT data FROM epic_runs WHERE epic_id=? ORDER BY rowid DESC':'SELECT data FROM epic_runs ORDER BY rowid DESC').all(...(epicId?[epicId]:[])) as {data:string}[]).map(row=>JSON.parse(row.data));}
  reserved(taskId:string):boolean{return this.list().some(r=>['running','waiting-validation','blocked'].includes(r.status)&&r.order.includes(taskId));}
  private save(run:EpicRun):void{const previous=this.list(run.epicId).find(r=>r.id===run.id);run.updatedAt=Date.now();this.db.connection.prepare('INSERT INTO epic_runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id,run.epicId,JSON.stringify(run));if(['failed','succeeded','blocked'].includes(run.status)&&(previous?.status!==run.status||previous?.error!==run.error))this.onResult(run);}
  private changeTask(id:string,patch:Parameters<CerebroDatabase['updateTask']>[1]):void{const task=this.db.updateTask(id,patch);if(task)this.broadcast({type:'task',task});}
  private plan(epicId:string){
    const epic=this.db.getEpic(epicId);if(!epic)throw new Error('Epic introuvable.');
    const all=this.db.listTasks().filter(t=>t.projectId===epic.projectId);const members=all.filter(t=>t.epicId===epicId);const open=members.filter(t=>t.status!=='done');
    for(const task of open)if(this.commands.active(task.id)||task.sessionId&&this.db.getSession(task.sessionId)?.status!=='exited')throw new Error('Une tâche est déjà confiée à une exécution active.');
    return {epic,members,order:taskOrder(open,all)};
  }
  start(epicId:string,options:SessionDefaults):EpicRun{
    if(this.list(epicId).some(r=>['running','waiting-validation','blocked'].includes(r.status)))throw new Error('Epic déjà en cours : utilisez reprendre ou arrêter.');
    const {epic,members,order}=this.plan(epicId);if(!order.length)throw new Error('Aucune tâche ouverte.');
    const run:EpicRun={id:randomUUID(),epicId,projectId:epic.projectId,status:'running',order:order.map(t=>t.id),members:members.map(t=>t.id),versions:Object.fromEntries(order.map(t=>[t.id,version(t)])),results:{},currentTaskId:null,sessionId:null,commandRunId:null,stepStartedAt:0,contextRoot:this.db.getProject(epic.projectId)!.path,options,error:null,startedAt:Date.now(),updatedAt:Date.now()};
    this.save(run);this.poke();return run;
  }
  report(sessionId:string,taskId:string,status:'failed'|'blocked'|'waiting-validation',message:string):EpicRun{
    const run=this.list().find(r=>r.currentTaskId===taskId&&r.sessionId===sessionId&&['running','waiting-validation','blocked'].includes(r.status));
    if(!run||this.db.getTask(taskId)?.sessionId!==sessionId)throw new Error('Cette étape n’est pas confiée à cette session.');
    run.results[taskId]=status;run.status=status;run.error=message;this.save(run);return run;
  }
  async stop(id:string):Promise<EpicRun>{
    const run=this.list().find(r=>r.id===id);if(!run)throw new Error('Exécution introuvable.');
    run.status='stopped';run.error='Arrêt demandé par l’utilisateur.';this.save(run);
    if(run.commandRunId)this.commands.stop(run.commandRunId);if(run.sessionId)this.sessions.kill(run.sessionId);return run;
  }
  resume(id:string,replan=false):EpicRun{
    const run=this.list().find(r=>r.id===id);if(!run||run.status==='succeeded'||run.status==='running')throw new Error('Exécution non reprenable.');
    if(this.busy.has(id))throw new Error('Une étape est encore en cours de lancement.');
    const another=this.list(run.epicId).some(r=>r.id!==id&&['running','waiting-validation','blocked'].includes(r.status));if(another)throw new Error('Une autre exécution est active.');
    if(run.currentTaskId){
      const task=this.db.getTask(run.currentTaskId);const session=run.sessionId?this.db.getSession(run.sessionId):null;
      const command=run.commandRunId?this.commands.listRuns().find(r=>r.id===run.commandRunId):null;
      if(session?.status==='waiting')throw new Error('Répondez d’abord à la question de la session.');
      if(task?.status!=='done'&&(!session||session.status==='exited')&&command?.status!=='running'&&command?.status!=='succeeded'){
        if(session)run.contextRoot=workspaceFor(this.db,session.id)?.path??run.contextRoot;
        if(task)this.changeTask(task.id,{status:'todo',sessionId:null});
        run.currentTaskId=null;run.sessionId=null;run.commandRunId=null;
      }
    }
    if(replan){
      const epic=this.db.getEpic(run.epicId);if(!epic)throw new Error('Epic supprimé.');
      const all=this.db.listTasks().filter(t=>t.projectId===run.projectId);const members=all.filter(t=>t.epicId===run.epicId);
      if(run.currentTaskId&&!members.some(t=>t.id===run.currentTaskId))throw new Error('L’étape active a quitté l’epic : arrêtez son exécution avant de recalculer.');
      const order=taskOrder(members.filter(t=>t.status!=='done'),all);run.order=order.map(t=>t.id);run.members=members.map(t=>t.id);run.versions=Object.fromEntries(order.map(t=>[t.id,version(t)]));
    }
    run.status='running';run.error=null;this.save(run);this.poke();return run;
  }
  poke():void{
    if(this.closed)return;
    for(const run of this.list())if(['running','waiting-validation'].includes(run.status)&&!this.busy.has(run.id)){
      this.busy.add(run.id);const promise=this.tick(run).catch(cause=>{if(this.list().find(r=>r.id===run.id)?.status==='stopped')return;run.status='blocked';run.error=String(cause);this.save(run);}).finally(()=>{this.busy.delete(run.id);this.inFlight.delete(promise);});this.inFlight.add(promise);
    }
  }
  private async tick(run:EpicRun):Promise<void>{
    const stop=(status:EpicRun['status'],error:string):void=>{run.status=status;run.error=error;this.save(run);};
    const epic=this.db.getEpic(run.epicId);if(!epic){stop('blocked','Epic supprimé.');return;}
    const members=this.db.listTasks().filter(t=>t.epicId===run.epicId);
    if(members.map(t=>t.id).sort().join(',')!==run.members.slice().sort().join(',')){stop('blocked','Composition de l’epic modifiée : reprise avec recalcul nécessaire.');return;}
    for(const id of run.order){const task=this.db.getTask(id);if(!task||version(task)!==run.versions[id]){stop('blocked','Tâche ou dépendances modifiées : reprise avec recalcul nécessaire.');return;}}
    if(run.currentTaskId){
      const task=this.db.getTask(run.currentTaskId)!;
      if(task.dependsOn.some(id=>this.db.getTask(id)?.status!=='done')){stop('blocked','Un prérequis de l’étape courante a été rouvert.');return;}
      if(task.execution.type==='command'){
        const command=this.commands.listRuns(task.id).find(r=>r.id===run.commandRunId||!run.commandRunId&&r.startedAt>=run.stepStartedAt);
        if(!command){stop('blocked','Lancement de commande interrompu : vérifiez puis reprenez explicitement.');return;}
        run.commandRunId=command.id;
        if(command.status==='running'){this.save(run);return;}
        if(command.status!=='succeeded'){run.results[task.id]=command.status;stop('failed',command.error??`Échec de commande : ${command.status}, code ${command.exitCode}`);return;}
        if(task.status!=='done'&&task.execution.completion==='exit-zero')this.changeTask(task.id,{status:'done'});
        else if(task.status!=='done'){run.results[task.id]='execution-succeeded';stop('waiting-validation','Commande réussie ; validation explicite du travail attendue.');return;}
        run.results[task.id]=task.execution.completion==='exit-zero'?'criterion-exit-zero':'validated';
      }else{
        const marker=`[CEREBRO_EPIC_STEP ${run.id} ${task.id}]`;
        const session=run.sessionId?this.db.getSession(run.sessionId):this.db.listSessions().find(s=>s.prompt.startsWith(marker));
        if(!session){stop('blocked','Lancement de session interrompu : vérifiez puis reprenez explicitement.');return;}
        run.sessionId=session.id;
        if(task.sessionId!==session.id)this.changeTask(task.id,{sessionId:session.id,status:'started'});
        if(session.status==='running'||session.status==='starting'){this.save(run);return;}
        if(task.status!=='done'){
          if(session.status==='exited'&&session.exitCode!==null&&session.exitCode!==0){run.results[task.id]='failed';stop('failed',`Session sortie avec code ${session.exitCode}.`);return;}
          run.results[task.id]=session.status==='waiting'?'blocked':'waiting-validation';stop(session.status==='waiting'?'blocked':'waiting-validation',session.attentionReason??'Tour terminé sans clôture explicite de la tâche.');return;
        }
        if(session.status==='waiting'){stop('blocked','Une question de la session reste en attente.');return;}
        run.contextRoot=workspaceFor(this.db,session.id)?.path??run.contextRoot;run.results[task.id]='declared-done';
        // The step is closed and its turn is over: free the terminal so finished steps do not pile up. The workspace stays for the next step.
        if(session.status!=='exited')this.sessions.kill(session.id);
      }
      run.currentTaskId=null;run.sessionId=null;run.commandRunId=null;run.status='running';run.error=null;this.save(run);
    }
    const pending=run.order.map(id=>this.db.getTask(id)!).filter(t=>t.status!=='done');
    if(!pending.length){run.status='succeeded';run.error=null;this.save(run);return;}
    const next=pending.find(t=>t.dependsOn.every(id=>this.db.getTask(id)?.status==='done'));
    if(!next){stop('blocked','Aucune tâche éligible : dépendance non satisfaite.');return;}
    if(this.commands.active(next.id)||next.sessionId&&this.db.getSession(next.sessionId)?.status!=='exited'){stop('blocked','La tâche suivante possède déjà une exécution active.');return;}
    run.currentTaskId=next.id;run.stepStartedAt=Date.now();this.save(run);
    if(next.execution.type==='command'){
      const operation=await this.commands.start(next.id,run.contextRoot);run.commandRunId=operation.id;
    }else{
      const project=this.db.getProject(run.projectId)!;
      const title=`Epic « ${epic.title} » · étape ${run.order.indexOf(next.id)+1}/${run.order.length} : ${next.text.split('\n')[0]}`.slice(0,120);
      const prompt=`[CEREBRO_EPIC_STEP ${run.id} ${next.id}]\nTraite uniquement cette étape de l’epic « ${epic.title} ».\n${epic.description}\n\n${next.text}\n\nIdentifiant : ${next.id}\nRéalise et vérifie cette tâche, puis exécute cerebro-backlog --done ${next.id} uniquement si elle est terminée. En cas d’échec utilise cerebro-backlog --fail <id> "raison" ; en cas de blocage utilise --block ; pour une validation nécessaire utilise --await-validation. Explique le résultat et termine ton tour. Le serveur pilote l’enchaînement : ne traite aucune autre tâche.\n\nInstructions supplémentaires : ${run.options.prompt}`;
      this.changeTask(next.id,{status:'started',sessionId:null});
      const session=await this.sessions.create(project,{...run.options,prompt},async()=>{
        if(this.closed||this.list().find(r=>r.id===run.id)?.status==='stopped')throw new Error('Epic arrêté avant le lancement du terminal.');
        const pending=this.db.listSessions().find(s=>s.prompt===prompt);
        if(pending){run.sessionId=pending.id;this.changeTask(next.id,{sessionId:pending.id});this.save(run);}
      },run.contextRoot,title);
      run.sessionId=session.id;this.changeTask(next.id,{sessionId:session.id});
    }
    // A stop can arrive while the holder is starting. Preserve it and stop the new operation too.
    const latest=this.list().find(r=>r.id===run.id);
    if(this.closed||latest?.status==='stopped'){
      if(run.commandRunId)this.commands.stop(run.commandRunId);if(run.sessionId)this.sessions.kill(run.sessionId);run.status='stopped';
    }
    this.save(run);
  }
}
