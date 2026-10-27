import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {after,test} from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-purge-'));process.env.CEREBRO_DATA_DIR=root;
const {CerebroDatabase}=await import('../server/db.ts');const {CommandExecutor}=await import('../server/commands.ts');
after(()=>rmSync(root,{recursive:true,force:true}));
const DAY=86_400_000;
const insertRun=(db,run)=>db.connection.prepare('INSERT INTO command_runs VALUES (?,?,?)').run(run.id,run.taskId,JSON.stringify(run));
// Runs belong to a real epic: epic_runs cascades from epics.
const insertEpicRun=(db,id,status,commandRunId)=>{const epic=db.listEpics()[0]??db.createEpic(db.listProjects()[0].id,'Epic','',null);db.connection.prepare('INSERT INTO epic_runs VALUES (?,?,?)').run(id,epic.id,JSON.stringify({id,epicId:epic.id,status,commandRunId}));};

test('la purge conserve le dernier run d’une tâche non terminée et le run suivi par un epic actif',()=>{
  const db=new CerebroDatabase(':memory:');const executor=new CommandExecutor(db);const project=db.createProject('Demo',root);const old=Date.now()-40*DAY;
  const command=executor.configure(project.id,{name:'test',executable:'true',args:[],cwd:'.',timeoutSeconds:10});
  const task=(status)=>{const t=db.createTask(project.id,status,null,null,{type:'command',commandId:command.id,completion:'manual'});db.updateTask(t.id,{status});return t;};
  const started=task('started'),done=task('done'),waiting=task('done'),stopped=task('done');
  const run=(id,taskId)=>insertRun(db,{id,taskId,status:'succeeded',output:'',startedAt:old,finishedAt:old});
  run('started-old',started.id);run('started-last',started.id);
  run('done-old',done.id);run('done-last',done.id);
  run('waiting',waiting.id);run('waiting-newer',waiting.id);insertEpicRun(db,'e1','waiting-validation','waiting');
  run('stopped',stopped.id);insertEpicRun(db,'e2','stopped','stopped');
  run('orphan','missing-task');
  assert.equal(executor.purge(Date.now()-30*DAY),6);
  assert.deepEqual(executor.listRuns().map(r=>r.id).sort(),['started-last','waiting']);
  db.close();
});
