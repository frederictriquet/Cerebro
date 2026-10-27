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
test('stop, timeout, double launch and dependencies are enforced',async()=>{
  const task=taskFor(configure('setInterval(()=>{},1000)'));const [a,b]=await Promise.allSettled([executor.start(task.id),executor.start(task.id)]);assert.equal([a,b].filter(r=>r.status==='fulfilled').length,1);const run=[a,b].find(r=>r.status==='fulfilled').value;
  executor.stop(run.id);assert.equal((await ended(run)).status,'stopped');
  const timed=await ended(await executor.start(taskFor(configure('setInterval(()=>{},1000)',1)).id));assert.match(timed.error,/Durée limite/);assert.equal(timed.status,'failed','a timeout is a failure, not a user stop');
  const blocked=taskFor(configure('console.log("never")'));db.setTaskDependencies(blocked.id,[task.id]);await assert.rejects(executor.start(blocked.id),/Dépendance/);
});
test('a missing executable ends the run as failed and frees the task',async()=>{
  const command=executor.configure(project.id,{name:'Absente',executable:'cerebro-missing-executable',args:[],cwd:'.',timeoutSeconds:10});const task=taskFor(command);
  const run=await ended(await executor.start(task.id));
  assert.equal(run.status,'failed');assert.equal(run.pid,null);assert.match(run.error,/ENOENT/);assert.ok(run.finishedAt);
  assert.equal(executor.active(task.id),false,'the task is no longer blocked by a phantom running run');assert.equal(executor.live.size,0);
});
test('restart preserves logs and marks unfinished commands interrupted without relaunching',async()=>{
  const task=taskFor(configure('console.log("persisted")'));await ended(await executor.start(task.id));
  const interrupted={...executor.listRuns(task.id)[0],id:'unfinished',status:'running',pid:null};db.connection.prepare('INSERT INTO command_runs VALUES (?,?,?)').run(interrupted.id,task.id,JSON.stringify(interrupted));
  db.close();db=new CerebroDatabase(join(root,'test.db'));executor=new CommandExecutor(db);const announced=executor.initialize();const run=executor.listRuns(task.id)[0];assert.equal(run.status,'interrupted');assert.deepEqual(announced.map(r=>[r.id,r.status]),[['unfinished','interrupted']],'interrupted runs are returned for the caller to announce');assert.match(run.output,/persisted/);assert.equal(db.listSessions().length,0);
});
test('pre-executor database migration keeps existing tasks as LLM tasks',()=>{
 const path=join(root,'legacy.db');let legacy=new CerebroDatabase(path);const p=legacy.createProject('Legacy',root);const old=legacy.createTask(p.id,'existing task',null);legacy.connection.exec('ALTER TABLE tasks DROP COLUMN execution');legacy.close();
 legacy=new CerebroDatabase(path);try{assert.equal(legacy.getTask(old.id).text,'existing task');assert.deepEqual(legacy.getTask(old.id).execution,{type:'llm'});assert.equal(legacy.getTask(old.id).status,'todo');}finally{legacy.close();}
});
test('verbose output is buffered: 1 000 chunks cost a few throttled writes and no extra change notification (no poke, no broadcast)',async()=>{
  const task=taskFor(configure('let i=0;const t=setInterval(()=>{process.stdout.write(`line ${i}\\n`);if(++i===1000)clearInterval(t);},1)'));
  const changes=[];executor.onChange=run=>changes.push(run.status);
  const prepare=db.connection.prepare.bind(db.connection);let writes=0;db.connection.prepare=sql=>{if(sql.startsWith('INSERT INTO command_runs'))writes++;return prepare(sql);};
  try{
    const startedAt=Date.now();const run=await executor.start(task.id);let chunks=0;executor.live.get(run.id).child.stdout.on('data',()=>chunks++);
    while(!/line 10\n/.test(executor.listRuns(task.id)[0].output)&&executor.listRuns(task.id)[0].status==='running')await new Promise(r=>setTimeout(r,10));
    assert.equal(executor.listRuns(task.id)[0].status,'running','live output is readable before the command ends');
    const done=await ended(run);const elapsed=Date.now()-startedAt;
    assert.equal(done.status,'succeeded');for(const i of [0,500,999])assert.match(done.output,new RegExp(`line ${i}\\n`));
    assert.ok(chunks>100,`the command must really produce many chunks (${chunks})`);
    assert.deepEqual(changes,['running','running','succeeded'],'only start, pid and end notify (each notification is one poke and one broadcast)');
    assert.ok(writes<=3+Math.ceil(elapsed/250)+1,`${writes} writes for ${chunks} chunks in ${elapsed} ms`);
  }finally{db.connection.prepare=prepare;executor.onChange=()=>{};}
});
