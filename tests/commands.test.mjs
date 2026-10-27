import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {after,test} from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-commands-'));process.env.CEREBRO_DATA_DIR=root;const {CerebroDatabase}=await import('../server/db.ts');const {CommandExecutor}=await import('../server/commands.ts');
let db=new CerebroDatabase(join(root,'test.db'));let executor=new CommandExecutor(db);const project=db.createProject('Demo',root);
const configure=(script,timeoutSeconds=10)=>executor.configure(project.id,{name:'Test',executable:process.execPath,args:['-e',script],cwd:'.',timeoutSeconds});
const taskFor=command=>db.createTask(project.id,'Texte libre ; ne jamais interpréter',null,null,{type:'command',commandId:command.id,completion:'manual'});
async function ended(run){while(executor.listRuns(run.taskId)[0].status==='running')await new Promise(r=>setTimeout(r,10));return executor.listRuns(run.taskId)[0];}
after(async()=>{await executor.shutdown();db.close();rmSync(root,{recursive:true,force:true});});
test('migration preserves old LLM tasks and argv command runs have logs, exit codes and manual validation',async()=>{
  const old=db.createTask(project.id,'ancienne',null);assert.deepEqual(old.execution,{type:'llm'});
  const task=taskFor(configure('console.log("result");console.error("diagnostic")'));const run=await ended(await executor.start(task.id));
  assert.equal(run.status,'succeeded');assert.equal(run.exitCode,0);assert.match(run.output,/result/);assert.match(run.output,/diagnostic/);assert.equal(db.getTask(task.id).status,'started');assert.equal(db.getTask(task.id).sessionId,null);assert.equal(db.listSessions().length,0);
  const failed=await ended(await executor.start(taskFor(configure('process.exit(7)')).id));assert.equal(failed.status,'failed');assert.equal(failed.exitCode,7);
});
test('commands do not inherit Cerebro server secrets but keep their run marker',async()=>{
  process.env.CEREBRO_BIND_TOKEN='bind-secret';process.env.CEREBRO_SLACK_TOKEN='slack-secret';
  try{
    const task=taskFor(configure('console.log(JSON.stringify(process.env))'));const run=await ended(await executor.start(task.id));const env=JSON.parse(run.output);
    assert.equal(env.CEREBRO_BIND_TOKEN,undefined);assert.equal(env.CEREBRO_SLACK_TOKEN,undefined);assert.equal(env.CEREBRO_DATA_DIR,undefined);assert.equal(env.CEREBRO_COMMAND_RUN,run.id);assert.equal(env.PATH,process.env.PATH);
  }finally{delete process.env.CEREBRO_BIND_TOKEN;delete process.env.CEREBRO_SLACK_TOKEN;}
});
test('stop, timeout, double launch and dependencies are enforced',async()=>{
  const task=taskFor(configure('setInterval(()=>{},1000)'));const [a,b]=await Promise.allSettled([executor.start(task.id),executor.start(task.id)]);assert.equal([a,b].filter(r=>r.status==='fulfilled').length,1);const run=[a,b].find(r=>r.status==='fulfilled').value;
  executor.stop(run.id);assert.equal((await ended(run)).status,'stopped');
  const timed=await ended(await executor.start(taskFor(configure('setInterval(()=>{},1000)',1)).id));assert.match(timed.error,/Durée limite/);
  const blocked=taskFor(configure('console.log("never")'));db.setTaskDependencies(blocked.id,[task.id]);await assert.rejects(executor.start(blocked.id),/Dépendance/);
});
test('restart preserves logs and marks unfinished commands interrupted without relaunching',async()=>{
  const task=taskFor(configure('console.log("persisted")'));await ended(await executor.start(task.id));
  const interrupted={...executor.listRuns(task.id)[0],id:'unfinished',status:'running',pid:null};db.connection.prepare('INSERT INTO command_runs VALUES (?,?,?)').run(interrupted.id,task.id,JSON.stringify(interrupted));
  db.close();db=new CerebroDatabase(join(root,'test.db'));executor=new CommandExecutor(db);executor.initialize();const run=executor.listRuns(task.id)[0];assert.equal(run.status,'interrupted');assert.match(run.output,/persisted/);assert.equal(db.listSessions().length,0);
});
test('pre-executor database migration keeps existing tasks as LLM tasks',()=>{
 const path=join(root,'legacy.db');let legacy=new CerebroDatabase(path);const p=legacy.createProject('Legacy',root);const old=legacy.createTask(p.id,'existing task',null);legacy.connection.exec('ALTER TABLE tasks DROP COLUMN execution');legacy.close();
 legacy=new CerebroDatabase(path);try{assert.equal(legacy.getTask(old.id).text,'existing task');assert.deepEqual(legacy.getTask(old.id).execution,{type:'llm'});assert.equal(legacy.getTask(old.id).status,'todo');}finally{legacy.close();}
});
