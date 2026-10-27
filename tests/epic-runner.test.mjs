import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {test} from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-epic-'));process.env.CEREBRO_DATA_DIR=root;
const {CerebroDatabase}=await import('../server/db.ts');const {DEFAULT_SESSION_DEFAULTS}=await import('../shared/types.ts');const {CommandExecutor}=await import('../server/commands.ts');const {EpicRunner,taskOrder}=await import('../server/epic-runner.ts');
async function fixture(run){const db=new CerebroDatabase(':memory:');const project=db.createProject('Demo',root);const epic=db.createEpic(project.id,'Epic','Context',null);const commands=new CommandExecutor(db);
 const launches=[];const sessions={async create(p,options,{title='step'}={}){const session=db.createSession({id:randomUUID(),projectId:p.id,...options,title,status:'idle',agentSessionId:'fake'},'token');launches.push(session);return session;},kill(id){db.updateSession(id,{status:'exited',exitCode:130});return true;}};
 let runner=new EpicRunner(db,sessions,commands,()=>{});
 const task=(name,execution={type:'llm'})=>db.createTask(project.id,name,null,epic.id,execution);
 const command=(script,completion='manual')=>{const c=commands.configure(project.id,{name:'check',executable:process.execPath,args:['-e',script],cwd:'.',timeoutSeconds:5});return {type:'command',commandId:c.id,completion};};
 const latest=()=>runner.list(epic.id)[0];
 const until=async predicate=>{for(let i=0;i<1000;i++){runner.poke();if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error(`Timed out: ${JSON.stringify(latest())}`);};
 try{await run({db,project,epic,commands,sessions,launches,task,command,latest,until,get runner(){return runner;},restart:async()=>{await runner.shutdown();runner=new EpicRunner(db,sessions,commands,()=>{});}});}finally{await runner.shutdown();await commands.shutdown();db.close();}}
test('mixed epic advances only on applicable explicit criteria; future tasks remain todo',async()=>fixture(async f=>{
 const a=f.task('command auto',f.command('console.log("a")','exit-zero'));const b=f.task('reasoning');const c=f.task('command manual',f.command('console.log("c")'));const d=f.task('last',f.command('console.log("d")','exit-zero'));
 f.db.setTaskDependencies(b.id,[a.id]);f.db.setTaskDependencies(c.id,[b.id]);f.db.setTaskDependencies(d.id,[c.id]);
 const [first,second]=await Promise.allSettled([f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS),f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS)]);
 assert.equal(first.status,'fulfilled');assert.match(String(second.reason),/déjà/);
 await f.until(()=>f.latest().status==='waiting-validation'&&f.latest().currentTaskId===b.id);
 assert.equal(f.db.getTask(a.id).status,'done');assert.equal(f.db.getTask(b.id).status,'started');assert.equal(f.db.getTask(c.id).status,'todo');assert.equal(f.launches.length,1);
 f.db.updateTask(b.id,{status:'done'});await f.until(()=>f.latest().status==='waiting-validation'&&f.latest().currentTaskId===c.id);
 assert.equal(f.db.getTask(d.id).status,'todo');assert.equal(f.db.getTask(c.id).status,'started');
 f.db.updateTask(c.id,{status:'done'});await f.until(()=>f.latest().status==='succeeded');assert.equal(f.launches.length,1);
}));
test('failed prerequisite stops independent and dependent future tasks',async()=>fixture(async f=>{
 const a=f.task('fail',f.command('process.exit(4)','exit-zero'));const b=f.task('dependent');f.db.setTaskDependencies(b.id,[a.id]);const c=f.task('independent');
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.latest().status==='failed');assert.equal(f.db.getTask(b.id).status,'todo');assert.equal(f.db.getTask(c.id).status,'todo');assert.equal(f.launches.length,0);
}));
test('restart and interrupted/idle LLM turns never imply done; --done equivalent advances',async()=>fixture(async f=>{
 const a=f.task('first');const b=f.task('next');await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.latest().status==='waiting-validation');
 await f.restart();await f.until(()=>f.latest().status==='waiting-validation');assert.equal(f.launches.length,1);assert.equal(f.db.getTask(b.id).status,'todo');
 const session=f.db.getTask(a.id).sessionId;f.db.updateSession(session,{status:'exited',exitCode:130});await f.until(()=>f.latest().status==='failed');assert.equal(f.db.getTask(a.id).status,'started');
}));
test('external prerequisites and backlog mutations block explicitly; stop/resume is deliberate',async()=>fixture(async f=>{
 const external=f.db.createTask(f.project.id,'external',null);const a=f.task('first');f.db.setTaskDependencies(a.id,[external.id]);
 await assert.rejects(f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS),/hors epic/);f.db.updateTask(external.id,{status:'done'});
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.latest().status==='waiting-validation');
 f.task('new');await f.until(()=>f.latest().status==='blocked');assert.match(f.latest().error,/Composition/);
 f.runner.stop(f.latest().id);assert.equal(f.latest().status,'stopped');
 await new Promise(r=>setTimeout(r,10));f.runner.resume(f.latest().id,true);await f.until(()=>f.latest().status==='waiting-validation');assert.equal(f.latest().order.length,2);
}));
test('server topological order detects cycles',()=>{
 const a={id:'a',dependsOn:['b'],status:'todo'},b={id:'b',dependsOn:['a'],status:'todo'};assert.throws(()=>taskOrder([a,b],[a,b]),/Cycle/);
});
test('replanning includes added tasks but preserves explicit validation requirements until the current task is done',async()=>fixture(async f=>{
 const a=f.task('deploy and verify');const b=f.task('next');
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.latest().status==='waiting-validation');
 const first=f.launches[0];const reason='MR ready; merge, deploy and verify the scheduled export before closing.';
 f.db.updateSession(first.id,{attentionReason:'Tour terminé'});
 f.runner.report(first.id,a.id,'waiting-validation',reason);
 // Repeated ticks and a restart must not erase the agent's criteria.
 for(let i=0;i<3;i++){f.runner.poke();await new Promise(r=>setTimeout(r,5));assert.equal(f.latest().error,reason);}
 await f.restart();f.runner.poke();await new Promise(r=>setTimeout(r,5));assert.equal(f.latest().error,reason);
 const added=f.task('added while running');await f.until(()=>f.latest().status==='blocked');
 await new Promise(r=>setTimeout(r,5));f.runner.resume(f.latest().id,true);
 await f.until(()=>f.latest().status==='waiting-validation');
 assert.equal(f.latest().error,reason);assert.ok(f.latest().order.includes(added.id));
 assert.equal(f.latest().currentTaskId,a.id);assert.equal(f.db.getTask(a.id).status,'started');assert.equal(f.launches.length,1);
 f.db.updateTask(a.id,{status:'done'});
 await f.until(()=>f.latest().status==='waiting-validation'&&f.latest().currentTaskId===b.id);
 assert.equal(f.db.getSession(first.id).status,'exited');assert.equal(f.latest().validationReason,null);
 assert.notEqual(f.latest().error,reason);assert.equal(f.db.getTask(added.id).status,'todo');
 f.db.updateTask(b.id,{status:'done'});await f.until(()=>f.latest().currentTaskId===added.id&&f.latest().status==='waiting-validation');
 f.db.updateTask(added.id,{status:'done'});await f.until(()=>f.latest().status==='succeeded');
}));
test('LLM steps get a readable title and a declared-done step frees its terminal',async()=>fixture(async f=>{
 const a=f.task('first step\nmore details');const b=f.task('second step');f.db.setTaskDependencies(b.id,[a.id]);
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.latest().status==='waiting-validation');
 const first=f.launches[0];assert.equal(first.title,'Epic « Epic » · étape 1/2 : first step');assert.match(first.prompt,/^\[CEREBRO_EPIC_STEP /);
 f.db.updateTask(a.id,{status:'done'});await f.until(()=>f.latest().status==='waiting-validation'&&f.latest().currentTaskId===b.id);
 assert.equal(f.db.getSession(first.id).status,'exited');assert.equal(f.launches[1].title,'Epic « Epic » · étape 2/2 : second step');assert.notEqual(f.db.getSession(f.launches[1].id).status,'exited');
}));
process.on('exit',()=>rmSync(root,{recursive:true,force:true}));
test('stop during asynchronous LLM preparation cannot be overwritten by its launch callback',async()=>fixture(async f=>{
 const a=f.task('slow');let release;let beforeLaunch;const gate=new Promise(resolve=>{release=resolve;});
 f.sessions.create=async(p,options,{validate})=>{const s=f.db.createSession({id:randomUUID(),projectId:p.id,...options,title:'slow',status:'starting',agentSessionId:'fake'},'token');beforeLaunch=validate;await gate;try{await validate();}catch(cause){f.db.updateSession(s.id,{status:'exited',exitCode:1});throw cause;}return s;};
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>!!beforeLaunch);f.runner.stop(f.latest().id);release();await new Promise(r=>setTimeout(r,30));assert.equal(f.latest().status,'stopped');assert.equal(f.db.listSessions()[0].status,'exited');
}));
test('a brief wait of the step session does not block; a lasting wait or an explicit question does',async()=>fixture(async f=>{
 const a=f.task('first');f.sessions.create=async(p,options,{title='step'}={})=>{const s=f.db.createSession({id:randomUUID(),projectId:p.id,...options,title,status:'running',agentSessionId:'fake'},'token');f.launches.push(s);return s;};
 const settle=async()=>{for(let i=0;i<20;i++){f.runner.poke();await new Promise(r=>setTimeout(r,5));}};
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.launches.length===1&&f.latest().sessionId===f.launches[0].id);const id=f.launches[0].id;
 f.db.updateSession(id,{status:'waiting',attentionReason:'Confirmation requise'});await settle();assert.equal(f.latest().status,'running');
 f.db.updateSession(id,{status:'running',attentionReason:null});await settle();assert.equal(f.latest().status,'running');assert.equal(f.latest().waitingSince,null);
 f.runner.waitingGraceMs=50;f.db.updateSession(id,{status:'waiting',attentionReason:'Confirmation requise'});
 await f.until(()=>f.latest().status==='blocked');assert.equal(f.latest().error,'Confirmation requise');
 f.db.updateSession(id,{status:'running',attentionReason:null});await new Promise(r=>setTimeout(r,10));f.runner.resume(f.latest().id);f.runner.waitingGraceMs=60_000;await settle();assert.equal(f.latest().status,'running');
 f.db.updateSession(id,{status:'waiting',attentionReason:'Question : quelle base ?'});await f.until(()=>f.latest().status==='blocked');assert.equal(f.latest().error,'Question : quelle base ?');assert.equal(f.db.getTask(a.id).status,'started');
}));
test('a run blocked by its step session resumes by itself once the cause is gone; other blocks stay',async()=>fixture(async f=>{
 const a=f.task('first');const b=f.task('second');f.db.setTaskDependencies(b.id,[a.id]);
 f.sessions.create=async(p,options,{title='step'}={})=>{const s=f.db.createSession({id:randomUUID(),projectId:p.id,...options,title,status:'running',agentSessionId:'fake'},'token');f.launches.push(s);return s;};
 const settle=async()=>{for(let i=0;i<20;i++){f.runner.poke();await new Promise(r=>setTimeout(r,5));}};
 f.runner.waitingGraceMs=0;await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.launches.length===1&&f.latest().sessionId===f.launches[0].id);const first=f.launches[0].id;
 f.db.updateSession(first,{status:'waiting',attentionReason:'Confirmation requise'});await f.until(()=>f.latest().status==='blocked');
 assert.equal(f.latest().blockReason,'session-waiting');await settle();assert.equal(f.latest().status,'blocked');assert.equal(f.launches.length,1);
 f.db.updateTask(a.id,{status:'done'});await f.until(()=>f.latest().status==='running'&&f.latest().currentTaskId===b.id&&f.launches.length===2);
 assert.equal(f.latest().error,null);assert.equal(f.latest().blockReason,null);assert.equal(f.db.getSession(first).status,'exited');
 // An explicit question keeps the run blocked even when the task is done, and a stopped run is never revived.
 const second=f.launches[1].id;f.db.updateSession(second,{status:'waiting',attentionReason:'Question : quelle base ?'});await f.until(()=>f.latest().status==='blocked');
 f.db.updateTask(b.id,{status:'done'});await settle();assert.equal(f.latest().status,'blocked');
 f.runner.stop(f.latest().id);f.db.updateSession(second,{status:'running',attentionReason:null});await settle();assert.equal(f.latest().status,'stopped');
}));
test('a run blocked by its step session resumes when the session runs again',async()=>fixture(async f=>{
 const a=f.task('first');f.sessions.create=async(p,options,{title='step'}={})=>{const s=f.db.createSession({id:randomUUID(),projectId:p.id,...options,title,status:'running',agentSessionId:'fake'},'token');f.launches.push(s);return s;};
 f.runner.waitingGraceMs=0;await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.launches.length===1&&f.latest().sessionId===f.launches[0].id);const id=f.launches[0].id;
 f.db.updateSession(id,{status:'waiting',attentionReason:'Confirmation requise'});await f.until(()=>f.latest().status==='blocked');
 f.db.updateSession(id,{status:'running',attentionReason:null});await f.until(()=>f.latest().status==='running');assert.equal(f.latest().error,null);assert.equal(f.latest().currentTaskId,a.id);
 f.db.updateSession(id,{status:'idle',attentionReason:null});await f.until(()=>f.latest().status==='waiting-validation');
}));
test('auto validation closes the waiting step and subsequent manual commands, and is recorded separately',async()=>fixture(async f=>{
 const a=f.task('review');const b=f.task('manual command',f.command('process.exit(0)'));
 f.db.setTaskDependencies(b.id,[a.id]);
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.latest().status==='waiting-validation');
 assert.equal(f.latest().autoValidate,false);assert.equal(f.db.getTask(a.id).status,'started');
 f.runner.report(f.launches[0].id,a.id,'waiting-validation','Validation demandée');
 f.runner.setAutoValidate(f.latest().id,true);
 await f.until(()=>f.latest().status==='succeeded');
 assert.equal(f.db.getTask(a.id).status,'done');assert.equal(f.db.getTask(b.id).status,'done');
 assert.equal(f.latest().results[a.id],'auto-validated');assert.equal(f.latest().results[b.id],'auto-validated');
 assert.throws(()=>f.runner.setAutoValidate(f.latest().id,false),/plus en cours/);
}));
test('auto validation persists through restart and can be disabled before the turn ends',async()=>fixture(async f=>{
 const a=f.task('work');
 f.sessions.create=async(p,options)=>{const s=f.db.createSession({id:randomUUID(),projectId:p.id,...options,title:'work',status:'running',agentSessionId:'fake'},'token');f.launches.push(s);return s;};
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>!!f.latest().sessionId);
 f.runner.setAutoValidate(f.latest().id,true);await f.restart();
 assert.equal(f.latest().autoValidate,true);
 f.runner.poke();await new Promise(r=>setTimeout(r,5));
 assert.equal(f.db.getTask(a.id).status,'started');assert.equal(f.latest().status,'running');
 f.runner.setAutoValidate(f.latest().id,false);
 f.db.updateSession(f.launches[0].id,{status:'idle'});
 await f.until(()=>f.latest().status==='waiting-validation');assert.equal(f.db.getTask(a.id).status,'started');
}));
test('auto validation leaves questions, explicit blocks, and failed sessions unresolved',async()=>fixture(async f=>{
 const a=f.task('work');
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.latest().status==='waiting-validation');
 const sid=f.launches[0].id;
 f.db.updateSession(sid,{status:'waiting',attentionReason:'Question : quel environnement ?'});
 f.runner.setAutoValidate(f.latest().id,true);await f.until(()=>f.latest().status==='blocked');
 assert.equal(f.db.getTask(a.id).status,'started');
 f.runner.report(sid,a.id,'blocked','Service indisponible');
 f.db.updateSession(sid,{status:'idle',attentionReason:null});
 f.runner.poke();await new Promise(r=>setTimeout(r,5));
 assert.equal(f.latest().status,'blocked');assert.equal(f.db.getTask(a.id).status,'started');
 f.db.updateSession(sid,{status:'running'});f.runner.resume(f.latest().id);
 f.db.updateSession(sid,{status:'exited',exitCode:1});
 await f.until(()=>f.latest().status==='failed');assert.equal(f.db.getTask(a.id).status,'started');
}));
test('auto validation does not accept failed commands',async()=>fixture(async f=>{
 const a=f.task('failed command',f.command('process.exit(4)'));
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);f.runner.setAutoValidate(f.latest().id,true);
 await f.until(()=>f.latest().status==='failed');assert.equal(f.db.getTask(a.id).status,'started');
}));
test('changing auto validation during asynchronous preparation survives launch completion',async()=>fixture(async f=>{
 const a=f.task('slow');let release;const gate=new Promise(resolve=>{release=resolve;});
 f.sessions.create=async(p,options,{validate})=>{
  const s=f.db.createSession({id:randomUUID(),projectId:p.id,...options,title:'slow',status:'starting',agentSessionId:'fake'},'token');f.launches.push(s);
  await gate;await validate();f.db.updateSession(s.id,{status:'idle'});return f.db.getSession(s.id);
 };
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);
 try{
  await f.until(()=>f.launches.length===1);
  f.runner.setAutoValidate(f.latest().id,true);
 }finally{release();}
 await f.until(()=>f.latest().status==='succeeded');
 assert.equal(f.latest().autoValidate,true);assert.equal(f.db.getTask(a.id).status,'done');
}));
test('polling skips finished runs and reuses the folder of a run blocked before any session',async()=>fixture(async f=>{
 f.task('first');f.sessions.create=async()=>{throw new Error('launch refused');};
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.latest().status==='blocked');assert.equal(f.latest().error,'launch refused');
 const other=f.db.createEpic(f.project.id,'Other','',null);f.db.createTask(f.project.id,'other',null,other.id);
 f.db.connection.prepare('INSERT INTO epic_runs VALUES (?,?,?)').run(randomUUID(),other.id,JSON.stringify({...f.latest(),id:'finished',epicId:other.id,status:'succeeded'}));
 const queries=[];const prepare=f.db.connection.prepare.bind(f.db.connection);f.db.connection.prepare=sql=>{queries.push(sql);return prepare(sql);};
 const perPoke=()=>{queries.length=0;f.runner.poke();return [...queries];};
 const before=perPoke();
 for(let i=0;i<20;i++)f.db.createSession({id:randomUUID(),projectId:f.project.id,...DEFAULT_SESSION_DEFAULTS,title:'noise',status:'idle',agentSessionId:'fake'},'token');
 assert.deepEqual(perPoke(),before);assert.equal(before.length,1);
 // A resumed run resolves its folder once, then reuses it while nothing changes.
 f.sessions.create=async(p,options,{validate,contextPath,title='step'}={})=>{const s=f.db.createSession({id:randomUUID(),projectId:p.id,...options,title,status:'running',agentSessionId:'fake'},'token');f.launches.push(s);return s;};
 f.runner.resume(f.latest().id);await f.until(()=>f.latest().sessionId!==null);await new Promise(r=>setTimeout(r,10));
 for(let i=0;i<2;i++){const sql=perPoke();await new Promise(r=>setTimeout(r,10));assert.ok(!sql.some(q=>/command_runs r JOIN|epic_workspaces/.test(q)),sql.join('\n'));}
 f.runner.invalidateWorkspaces();assert.ok(perPoke().some(q=>/epic_workspaces/.test(q)));await new Promise(r=>setTimeout(r,10));
 f.db.connection.prepare=prepare;
}));
test('report, auto validation, stop and resume never resolve the folder of other epics',async()=>fixture(async f=>{
 const a=f.task('first');await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.latest().status==='waiting-validation');
 const others=Array.from({length:5},(_,i)=>{const other=f.db.createEpic(f.project.id,`Other ${i}`,'',null);f.db.createTask(f.project.id,'other',null,other.id);
  f.db.connection.prepare('INSERT INTO epic_runs VALUES (?,?,?)').run(randomUUID(),other.id,JSON.stringify({...f.latest(),id:randomUUID(),epicId:other.id,status:'succeeded'}));return other.id;});
 const params=[];const prepare=f.db.connection.prepare.bind(f.db.connection);
 f.db.connection.prepare=sql=>{const statement=prepare(sql);return new Proxy(statement,{get:(target,key)=>{const value=Reflect.get(target,key,target);
  return ['get','all','run','iterate'].includes(key)?(...args)=>{params.push(...args);return value.apply(target,args);}:typeof value==='function'?value.bind(target):value;}});};
 const listSessions=f.db.listSessions.bind(f.db);let scans=0;f.db.listSessions=()=>{scans++;return listSessions();};
 try{
  const id=f.latest().id;
  assert.equal(f.runner.report(f.launches[0].id,a.id,'blocked','Service indisponible').status,'blocked');
  assert.equal(f.runner.setAutoValidate(id,false).autoValidate,false);
  assert.equal(f.runner.stop(id).status,'stopped');
  await new Promise(r=>setTimeout(r,10));
  assert.equal(f.runner.resume(id).status,'running');
  assert.ok(!params.some(value=>others.includes(value)),'another epic was resolved');
  assert.ok(scans<=others.length,`${scans} session scans`);
 }finally{f.db.connection.prepare=prepare;f.db.listSessions=listSessions;}
}));
test('command output and unrelated session events keep the epic folder cached',async()=>fixture(async f=>{
 f.task('noisy',f.command('let i=0;const t=setInterval(()=>{console.log("line "+i);if(++i===40)clearInterval(t);},3)'));
 const resolutions=()=>queries.filter(q=>/SELECT data,verified FROM epic_workspaces/.test(q)).length;
 const queries=[];const prepare=f.db.connection.prepare.bind(f.db.connection);f.db.connection.prepare=sql=>{queries.push(sql);return prepare(sql);};
 let notifications=0,first=null,last=null,finished;const done=new Promise(resolve=>{finished=resolve;});
 f.commands.onChange=run=>{f.runner.commandChanged(run);f.runner.poke();
  if(run.finishedAt!==null)finished();else{notifications++;first??=resolutions();last=resolutions();}};
 try{
  await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await done;
  // Output is buffered without notification: only lifecycle changes reach the runner, and only the run's creation may resolve the folder.
  assert.match(f.commands.listRuns()[0].output,/line 39/);
  assert.ok(notifications<=2,`${notifications} notifications`);assert.ok(last-first<=1,`${last-first} resolutions while the command ran`);
  await f.until(()=>f.latest().status==='waiting-validation');
  // A run whose tick is still in flight is skipped: let it settle before measuring a poke.
  const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
  const settled=async()=>{await pause();const before=resolutions();f.runner.poke();const count=resolutions()-before;await pause();return count;};
  const noise=f.db.createSession({id:randomUUID(),projectId:f.project.id,...DEFAULT_SESSION_DEFAULTS,title:'noise',status:'idle',agentSessionId:'fake'},'token');
  f.runner.sessionChanged({type:'session',session:noise});assert.equal(await settled(),1,'a new session can bring a copy');
  for(let i=0;i<20;i++)f.runner.sessionChanged({type:'session',session:{...noise,status:i%2?'running':'waiting'}});
  f.runner.sessionChanged({type:'turn-complete',id:noise.id,message:null});assert.equal(await settled(),0);
  const other=f.db.createEpic(f.project.id,'Other','',null);
  const elsewhere=f.db.createSession({id:randomUUID(),projectId:f.project.id,...DEFAULT_SESSION_DEFAULTS,title:'other epic',status:'idle',agentSessionId:'fake'},'token',other.id);
  f.runner.sessionChanged({type:'session',session:elsewhere});await settled();
  f.runner.sessionChanged({type:'session',session:{...elsewhere,status:'running'}});assert.equal(await settled(),0,'another epic’s session');
  const step=f.db.createSession({id:randomUUID(),projectId:f.project.id,...DEFAULT_SESSION_DEFAULTS,title:'step',status:'idle',agentSessionId:'fake'},'token',f.epic.id);
  f.runner.sessionChanged({type:'session',session:step});await settled();
  f.runner.sessionChanged({type:'session',session:{...step,status:'running'}});assert.equal(await settled(),1,'a session of the epic');
  f.runner.sessionChanged({type:'session-deleted',id:noise.id});assert.equal(await settled(),1,'a removed session');
 }finally{f.db.connection.prepare=prepare;}
}));
test('deleting an epic deletes its runs; a step finishing afterwards does not resurrect them',async()=>fixture(async f=>{
 f.task('first');let release;const gate=new Promise(resolve=>{release=resolve;});
 f.sessions.create=async(p,options,{validate,contextPath,title='step'}={})=>{await gate;const s=f.db.createSession({id:randomUUID(),projectId:p.id,...options,title,status:'running',agentSessionId:'fake'},'token');f.launches.push(s);return s;};
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.latest().currentTaskId!==null);
 const run=f.latest();assert.ok(f.db.deleteEpic(f.epic.id));
 assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM epic_runs').get().n,0);
 release();await new Promise(r=>setTimeout(r,20));f.runner.poke();await new Promise(r=>setTimeout(r,10));
 assert.equal(f.launches.length,1);assert.equal(f.runner.list().length,0);
 assert.throws(()=>f.runner.stop(run.id),/introuvable/);
 // The session launched for a run that no longer exists is stopped, and its task goes back to the backlog.
 assert.equal(f.db.getSession(f.launches[0].id).status,'exited');
 const task=f.db.getTask(run.currentTaskId);assert.equal(task.status,'todo');assert.equal(task.sessionId,null);
}));
test('deleting an epic before its step terminal starts cancels the launch and hands the task back',async()=>fixture(async f=>{
 const first=f.task('first');let release;const gate=new Promise(resolve=>{release=resolve;});const refused=[];
 f.sessions.create=async(p,options,{validate,contextPath,title='step'}={})=>{await gate;try{await validate();}catch(cause){refused.push(cause.message);throw cause;}const s=f.db.createSession({id:randomUUID(),projectId:p.id,...options,title,status:'running',agentSessionId:'fake'},'token');f.launches.push(s);return s;};
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.db.getTask(first.id).status==='started');
 assert.ok(f.db.deleteEpic(f.epic.id));
 release();await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(refused,['Epic arrêté avant le lancement du terminal.']);assert.equal(f.launches.length,0);
 const task=f.db.getTask(first.id);assert.equal(task.status,'todo');assert.equal(task.sessionId,null);
}));
test('deleting an epic while its command step starts stops the command and hands the task back',async()=>fixture(async f=>{
 const step=f.task('check',f.command('setTimeout(()=>{},5000)'));const started=[];const stopped=[];const start=f.commands.start.bind(f.commands);const stop=f.commands.stop.bind(f.commands);
 f.commands.start=async(...args)=>{const operation=await start(...args);started.push(operation.id);assert.ok(f.db.deleteEpic(f.epic.id));return operation;};
 f.commands.stop=id=>{stopped.push(id);return stop(id);};
 await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>stopped.length>0);await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(stopped,started);
 const task=f.db.getTask(step.id);assert.equal(task.status,'todo');assert.equal(task.sessionId,null);
}));
test('legacy epic_runs without a foreign key are rebuilt without orphans and keep their order',()=>{
 const path=join(root,`legacy-${randomUUID()}.db`);let db=new CerebroDatabase(path);const project=db.createProject('Legacy',root);
 const a=db.createEpic(project.id,'A','',null);const b=db.createEpic(project.id,'B','',null);
 db.connection.exec('DROP TABLE epic_runs;DROP INDEX IF EXISTS epic_runs_epic_id;CREATE TABLE epic_runs (id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, data TEXT NOT NULL)');
 for(const [id,epic] of [['r1',b.id],['r2','gone'],['r3',a.id]])db.connection.prepare('INSERT INTO epic_runs VALUES (?,?,?)').run(id,epic,'{}');
 db.close();db=new CerebroDatabase(path);
 try{
  assert.deepEqual(db.connection.prepare('SELECT id FROM epic_runs ORDER BY rowid').all().map(r=>r.id),['r1','r3']);
  assert.match(db.connection.prepare("SELECT sql FROM sqlite_master WHERE name='epic_runs'").get().sql,/REFERENCES epics/);
  db.deleteEpic(b.id);assert.deepEqual(db.connection.prepare('SELECT id FROM epic_runs').all().map(r=>r.id),['r3']);
 }finally{db.close();}
});
test('an epic whose folder cannot be resolved exposes the cause instead of hiding it',async()=>fixture(async f=>{
 const a=f.task('check',f.command('console.log("a")'));f.task('next');
 const old={id:randomUUID(),taskId:a.id,pid:null,command:{cwd:'.'},cwd:join(root,'moved-away'),status:'succeeded',output:'',startedAt:1,finishedAt:2,exitCode:0,error:null};
 f.db.connection.prepare('INSERT INTO command_runs VALUES (?,?,?)').run(old.id,a.id,JSON.stringify(old));
 const run={id:randomUUID(),epicId:f.epic.id,projectId:f.project.id,status:'failed',order:[a.id],members:[a.id],versions:{},results:{},currentTaskId:a.id,sessionId:null,commandRunId:old.id,stepStartedAt:1,contextRoot:root,options:DEFAULT_SESSION_DEFAULTS,error:'Échec précédent.',startedAt:1,updatedAt:1};
 f.db.connection.prepare('INSERT INTO epic_runs VALUES (?,?,?)').run(run.id,f.epic.id,JSON.stringify(run));
 const listed=f.latest();assert.equal(listed.workspaceConflict,false);assert.match(listed.workspaceError,/ne correspond plus au projet/);
 await assert.rejects(f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS),new RegExp(listed.workspaceError.slice(0,40)));
 // The computed cause is never persisted with the run.
 assert.equal(JSON.parse(f.db.connection.prepare('SELECT data FROM epic_runs WHERE id=?').get(run.id).data).workspaceError,undefined);
}));
test('an unresolvable folder is logged once per cause across cache invalidations',async()=>fixture(async f=>{
 const a=f.task('check',f.command('console.log("a")'));
 const old={id:randomUUID(),taskId:a.id,pid:null,command:{cwd:'.'},cwd:join(root,'moved-away'),status:'succeeded',output:'',startedAt:1,finishedAt:2,exitCode:0,error:null};
 f.db.connection.prepare('INSERT INTO command_runs VALUES (?,?,?)').run(old.id,a.id,JSON.stringify(old));
 const logged=[];const original=console.error;console.error=(...args)=>logged.push(args.join(' '));
 try{
  const resolve=()=>f.runner['cachedWorkspace'](f.epic.id);
  assert.match(resolve().error,/ne correspond plus au projet/);
  f.runner.invalidateWorkspaces();resolve();f.runner.invalidateWorkspaces(f.epic.id);resolve();
  assert.equal(logged.filter(line=>line.includes('dossier de travail introuvable')).length,1);
  // Once the history resolves again, a later recurrence of the cause is logged anew.
  f.db.connection.prepare('DELETE FROM command_runs WHERE id=?').run(old.id);f.runner.invalidateWorkspaces();assert.equal(resolve().error,null);
  f.db.connection.prepare('INSERT INTO command_runs VALUES (?,?,?)').run(old.id,a.id,JSON.stringify(old));f.runner.invalidateWorkspaces();resolve();
  assert.equal(logged.filter(line=>line.includes('dossier de travail introuvable')).length,2);
 }finally{console.error=original;}
}));
test('a failing save during a tick is logged instead of rejecting unhandled',async()=>fixture(async f=>{
 const a=f.task('only');await f.runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);await f.until(()=>f.latest().status==='waiting-validation');
 const unhandled=[];const onUnhandled=reason=>unhandled.push(reason);process.on('unhandledRejection',onUnhandled);
 const logged=[];const error=console.error;console.error=(...args)=>logged.push(args);
 const runner=f.runner;runner.save=()=>{throw new Error('SQLITE_BUSY: database is locked');};
 try{
  f.db.updateTask(a.id,{status:'done'});
  for(let i=0;i<5;i++){runner.poke();await new Promise(r=>setTimeout(r,5));}
 }finally{delete runner.save;console.error=error;process.off('unhandledRejection',onUnhandled);}
 assert.deepEqual(unhandled,[]);assert.ok(logged.some(args=>args.some(arg=>String(arg).includes('SQLITE_BUSY'))));
 // Nothing was recorded: the next tick retries from the stored state and completes.
 assert.equal(f.latest().status,'waiting-validation');
 await f.until(()=>f.latest().status==='succeeded');
}));
test('saving a run reads only its own row instead of the epic history',async()=>fixture(async f=>{
 await f.runner.shutdown();const events=[];const runner=new EpicRunner(f.db,f.sessions,f.commands,event=>{if(event.type==='epic-run')events.push(event.run);});
 try{
  f.task('first');const started=await runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);const run=runner.list(f.epic.id)[0];
  let listed=0;const list=runner.list.bind(runner);runner.list=(...args)=>{listed++;return list(...args);};
  const count=events.length;runner.save(run);assert.equal(listed,0);assert.equal(events.length,count);
  run.error='changed';runner.save(run);assert.equal(listed,0);assert.equal(events.at(-1).error,'changed');assert.ok('workspace' in events.at(-1));assert.equal(events.at(-1).id,started.id);
  runner.list=list;
 }finally{await runner.shutdown();}
}));
test('run changes are broadcast as epic-run events; ticks that change nothing are not',async()=>fixture(async f=>{
 await f.runner.shutdown();const events=[];const runner=new EpicRunner(f.db,f.sessions,f.commands,event=>{if(event.type==='epic-run')events.push(event.run);});
 try{
  f.task('first');const started=await runner.start(f.epic.id,DEFAULT_SESSION_DEFAULTS);assert.equal(events[0].id,started.id);assert.equal(events[0].status,'running');
  for(let i=0;i<1000&&runner.list(f.epic.id)[0].status!=='waiting-validation';i++){runner.poke();await new Promise(r=>setTimeout(r,5));}
  assert.equal(events.at(-1).status,'waiting-validation');assert.ok('workspace' in events.at(-1));
  const count=events.length;for(let i=0;i<3;i++){runner.poke();await new Promise(r=>setTimeout(r,5));}assert.equal(events.length,count);
  await runner.stop(started.id);assert.equal(events.at(-1).status,'stopped');
 }finally{await runner.shutdown();}
}));
