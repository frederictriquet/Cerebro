import { assertWorktreeAvailable } from './worktree-gate.ts';
import { withoutCerebroVariables } from './agent-env.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import type { CerebroDatabase } from './db.ts';
import { killWithEscalation } from './proc.ts';
import type { TaskExecution } from '../shared/types.ts';
import type { CommandRun, ProjectCommand } from '../shared/backlog.ts';
// Output is buffered in memory and written at most this often: a verbose command must not cost one write and one broadcast per chunk.
export const OUTPUT_FLUSH_MS=250;
type LiveRun={child:ChildProcess;timer:NodeJS.Timeout;killTimer?:NodeJS.Timeout;flushTimer?:NodeJS.Timeout;pending:string[];run:CommandRun;stopping:boolean;timedOut:boolean};
export class CommandExecutor {
  private db:CerebroDatabase;
  private live=new Map<string,LiveRun>();
  private starting=new Set<string>();
  // Status and lifecycle changes only; output alone is persisted without notification.
  onChange:(run:CommandRun)=>void=()=>{};
  constructor(db:CerebroDatabase){this.db=db;}
  // Returns the runs it marked interrupted: the caller announces them once onChange is wired.
  initialize():CommandRun[]{const interrupted:CommandRun[]=[];for(const run of this.runningRuns()){try{if(run.pid&&readFileSync(`/proc/${run.pid}/environ`).toString().split('\0').includes(`CEREBRO_COMMAND_RUN=${run.id}`))process.kill(-run.pid,'SIGKILL');}catch{}run.status='interrupted';run.error='Serveur redémarré : résultat inconnu, commande non relancée.';run.finishedAt=Date.now();this.persist(run);interrupted.push(run);}return interrupted;}
  commands(projectId:string):ProjectCommand[]{return (this.db.connection.prepare('SELECT data FROM project_commands WHERE project_id=?').all(projectId) as {data:string}[]).map(r=>JSON.parse(r.data));}
  configure(projectId:string,raw:unknown):ProjectCommand{
    const c=raw as ProjectCommand;
    if(!this.db.getProject(projectId)||!c||typeof c.name!=='string'||!c.name.trim()||c.name.length>200||typeof c.executable!=='string'||!c.executable.trim()||c.executable.includes('\0')||c.executable.length>1000
      ||!Array.isArray(c.args)||c.args.length>200||!c.args.every(a=>typeof a==='string'&&!a.includes('\0')&&a.length<=10000)||typeof c.cwd!=='string'||isAbsolute(c.cwd)||c.cwd.length>1000||!Number.isInteger(c.timeoutSeconds)||c.timeoutSeconds<1||c.timeoutSeconds>86400)throw new Error('Configuration de commande invalide (argv explicite, cwd relatif, durée 1–86400 s).');
    const command={...c,id:randomUUID(),projectId,name:c.name.trim()};
    this.db.connection.prepare('INSERT INTO project_commands VALUES (?,?,?)').run(command.id,projectId,JSON.stringify(command));return command;
  }
  execution(projectId:string,raw:unknown):TaskExecution{
    if(raw===undefined)return {type:'llm'};
    const e=raw as TaskExecution;
    if(e?.type==='llm')return {type:'llm'};
    if(e?.type!=='command'||!this.commands(projectId).some(c=>c.id===e.commandId)||!['manual','exit-zero'].includes(e.completion))throw new Error('Exécuteur de tâche invalide.');
    return {type:'command',commandId:e.commandId,completion:e.completion};
  }
  listRuns(taskId?:string,id?:string):CommandRun[]{return (this.db.connection.prepare(id?'SELECT data FROM command_runs WHERE id=?':taskId?'SELECT data FROM command_runs WHERE task_id=? ORDER BY rowid DESC':'SELECT data FROM command_runs ORDER BY rowid DESC').all(...(id?[id]:taskId?[taskId]:[])) as {data:string}[]).map(r=>{const run=JSON.parse(r.data) as CommandRun;const live=this.live.get(run.id);if(!live)return run;this.flushOutput(live);return {...live.run};});}
  getRun(id:string):CommandRun|null{return this.listRuns(undefined,id)[0]??null;}
  // Colonne status indexée : ni l’output ni les runs terminés ne sont relus.
  runningRuns():CommandRun[]{return (this.db.connection.prepare("SELECT data FROM command_runs WHERE status='running'").all() as {data:string}[]).map(r=>JSON.parse(r.data));}
  activeTaskIds():Set<string>{return new Set([...this.starting,...(this.db.connection.prepare("SELECT DISTINCT task_id FROM command_runs WHERE status='running'").all() as {task_id:string}[]).map(r=>r.task_id)]);}
  // Runs terminés avant before ; un run en cours n’a pas de finished_at et n’est jamais supprimé.
  // Restent aussi le dernier run d’une tâche non terminée (état affiché au backlog) et le run suivi par un epic actif, que tick() relit.
  purge(before:number):number{return Number(this.db.connection.prepare(`DELETE FROM command_runs WHERE status!='running' AND finished_at<?
    AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=command_runs.task_id AND t.status!='done' AND command_runs.rowid=(SELECT max(c.rowid) FROM command_runs c WHERE c.task_id=t.id))
    AND NOT EXISTS (SELECT 1 FROM epic_runs e WHERE json_extract(e.data,'$.commandRunId')=command_runs.id AND json_extract(e.data,'$.status') IN ('running','waiting-validation','blocked'))`).run(before).changes);}
  private persist(run:CommandRun):void{this.db.connection.prepare('INSERT INTO command_runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id,run.taskId,JSON.stringify(run));}
  private save(run:CommandRun):void{this.persist(run);this.onChange(run);}
  private flushOutput(runtime:LiveRun):void{if(runtime.pending.length)runtime.run.output=(runtime.run.output+runtime.pending.splice(0).join('')).slice(-1024*1024);}
  active(taskId:string):boolean{return this.starting.has(taskId)||!!this.db.connection.prepare("SELECT 1 FROM command_runs WHERE status='running' AND task_id=? LIMIT 1").get(taskId);}
  async start(taskId:string,contextRoot?:string):Promise<CommandRun>{
    const task=this.db.getTask(taskId);if(!task||task.execution.type!=='command')throw new Error('Tâche de commande introuvable.');
    if(this.active(taskId))throw new Error('Commande déjà en cours.');
    if(task.status==='done')throw new Error('Tâche déjà terminée.');
    if(task.dependsOn.some(id=>this.db.getTask(id)?.status!=='done'))throw new Error('Dépendance non satisfaite.');
    const command=this.commands(task.projectId).find(c=>c.id===(task.execution as {commandId:string}).commandId);if(!command)throw new Error('Commande configurée introuvable.');
    this.starting.add(taskId);
    try{
      const project=this.db.getProject(task.projectId)!;const root=await realpath(contextRoot??project.path);const cwd=await realpath(resolve(root,command.cwd));
      const rel=relative(root,cwd);if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new Error('Le répertoire de commande doit rester dans le projet.');
      if(this.db.getTask(taskId)?.dependsOn.some(id=>this.db.getTask(id)?.status!=='done'))throw new Error('Dépendance devenue non satisfaite.');
      assertWorktreeAvailable(cwd);
      const run:CommandRun={id:randomUUID(),taskId,pid:null,command,cwd,status:'running',output:'',startedAt:Date.now(),finishedAt:null,exitCode:null,error:null};
      this.db.updateTask(taskId,{status:'started',sessionId:null});this.save(run);
      const child=spawn(command.executable,command.args,{cwd,shell:false,detached:true,env:{...withoutCerebroVariables(),CEREBRO_COMMAND_RUN:run.id},stdio:['ignore','pipe','pipe']});
      run.pid=child.pid??null;this.save(run);
      // A timeout is a failure, not a user stop: the flag survives the shared stop() path.
      const timer=setTimeout(()=>{if(runtime.stopping)return;runtime.timedOut=true;run.error='Durée limite dépassée.';this.stop(run.id);},command.timeoutSeconds*1000);timer.unref();
      const runtime:LiveRun={child,timer,pending:[],run,stopping:false,timedOut:false};this.live.set(run.id,runtime);
      const append=(data:string):void=>{runtime.pending.push(data);runtime.flushTimer??=setTimeout(()=>{runtime.flushTimer=undefined;if(this.live.get(run.id)!==runtime)return;this.flushOutput(runtime);this.persist(run);},OUTPUT_FLUSH_MS);runtime.flushTimer.unref();};
      child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');child.stdout?.on('data',append);child.stderr?.on('data',append);
      // Échec de spawn (ENOENT, EACCES) : Node 22 émet 'close' (code négatif) après 'error', le run se termine par le même chemin.
      child.once('error',cause=>{run.error=cause.message;});
      child.once('close',code=>{
        clearTimeout(timer);clearTimeout(runtime.flushTimer);this.flushOutput(runtime);const current=this.live.get(run.id);if(current?.killTimer)clearTimeout(current.killTimer);
        run.exitCode=code;run.finishedAt=Date.now();run.status=runtime.timedOut?'failed':runtime.stopping?'stopped':code===0&&!run.error?'succeeded':'failed';this.live.delete(run.id);this.save(run);
      });
      return run;
    }finally{this.starting.delete(taskId);}
  }
  stop(id:string):boolean{
    const runtime=this.live.get(id);if(!runtime)return false;if(runtime.stopping)return true;runtime.stopping=true;
    const kill=(signal:NodeJS.Signals):void=>{try{if(runtime.child.pid)process.kill(-runtime.child.pid,signal);}catch{runtime.child.kill(signal);}};
    runtime.killTimer=killWithEscalation(kill,1500);runtime.killTimer.unref();return true;
  }
  async shutdown():Promise<void>{
    await Promise.all([...this.live].map(([id,runtime])=>new Promise<void>(resolve=>{runtime.child.once('close',()=>resolve());this.stop(id);})));
  }
}
