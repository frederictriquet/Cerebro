import { assertWorktreeAvailable } from './worktree-gate.ts';
import { withoutCerebroVariables } from './agent-env.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import type { CerebroDatabase, TaskExecution } from './db.ts';
export interface ProjectCommand {id:string;projectId:string;name:string;executable:string;args:string[];cwd:string;timeoutSeconds:number}
export interface CommandRun {id:string;taskId:string;pid:number|null;command:ProjectCommand;cwd:string;status:'running'|'succeeded'|'failed'|'stopped'|'interrupted';output:string;startedAt:number;finishedAt:number|null;exitCode:number|null;error:string|null}
export class CommandExecutor {
  private db:CerebroDatabase;
  private live=new Map<string,{child:ChildProcess;timer:NodeJS.Timeout;killTimer?:NodeJS.Timeout;run:CommandRun;stopping:boolean}>();
  private starting=new Set<string>();
  onChange:(run:CommandRun)=>void=()=>{};
  constructor(db:CerebroDatabase){this.db=db;}
  initialize():void{for(const run of this.listRuns())if(run.status==='running'){try{if(run.pid&&readFileSync(`/proc/${run.pid}/environ`).toString().split('\0').includes(`CEREBRO_COMMAND_RUN=${run.id}`))process.kill(-run.pid,'SIGKILL');}catch{}run.status='interrupted';run.error='Serveur redémarré : résultat inconnu, commande non relancée.';run.finishedAt=Date.now();this.save(run);}}
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
  listRuns(taskId?:string):CommandRun[]{return (this.db.connection.prepare(taskId?'SELECT data FROM command_runs WHERE task_id=? ORDER BY rowid DESC':'SELECT data FROM command_runs ORDER BY rowid DESC').all(...(taskId?[taskId]:[])) as {data:string}[]).map(r=>JSON.parse(r.data));}
  private save(run:CommandRun):void{this.db.connection.prepare('INSERT INTO command_runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id,run.taskId,JSON.stringify(run));this.onChange(run);}
  active(taskId:string):boolean{return this.starting.has(taskId)||this.listRuns(taskId)[0]?.status==='running';}
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
      const timer=setTimeout(()=>{run.error='Durée limite dépassée.';this.stop(run.id);},command.timeoutSeconds*1000);timer.unref();
      const runtime={child,timer,run,stopping:false};this.live.set(run.id,runtime);
      const append=(data:Buffer):void=>{run.output=(run.output+data.toString()).slice(-1024*1024);this.save(run);};
      child.stdout?.on('data',append);child.stderr?.on('data',append);
      child.once('error',cause=>{run.error=cause.message;});
      child.once('close',code=>{
        clearTimeout(timer);const current=this.live.get(run.id);if(current?.killTimer)clearTimeout(current.killTimer);
        run.exitCode=code;run.finishedAt=Date.now();run.status=runtime.stopping?'stopped':code===0&&!run.error?'succeeded':'failed';this.live.delete(run.id);this.save(run);
      });
      return run;
    }finally{this.starting.delete(taskId);}
  }
  stop(id:string):boolean{
    const runtime=this.live.get(id);if(!runtime)return false;if(runtime.stopping)return true;runtime.stopping=true;
    const kill=(signal:NodeJS.Signals):void=>{try{if(runtime.child.pid)process.kill(-runtime.child.pid,signal);}catch{runtime.child.kill(signal);}};
    kill('SIGTERM');runtime.killTimer=setTimeout(()=>kill('SIGKILL'),1500);runtime.killTimer.unref();return true;
  }
  async shutdown():Promise<void>{
    await Promise.all([...this.live].map(([id,runtime])=>new Promise<void>(resolve=>{runtime.child.once('close',()=>resolve());this.stop(id);})));
  }
}
