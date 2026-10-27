import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,test} from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-epic-review-'));
process.env.HOME=root;process.env.CEREBRO_DATA_DIR=join(root,'data');process.env.CODEX_HOME=join(root,'codex');
const {CerebroDatabase}=await import('../server/db.ts');const {DEFAULT_SESSION_DEFAULTS}=await import('../shared/types.ts');
const {CommandExecutor}=await import('../server/commands.ts');
const {EpicRunner}=await import('../server/epic-runner.ts');
const {createWorkspace,createWorkspaceInContext,joinWorkspace,workspaceAt,workspaceFor}=await import('../server/provenance.ts');
const {epicWorkspace,epicWorkspaceOptions,rememberEpicWorkspace}=await import('../server/epic-workspace.ts');
const {importFindings,saveReport}=await import('../server/findings.ts');
const {epicReviewScope,epicReviewInstructions,isReviewTask,reviewTaskText,REVIEW_TASK_TITLE}=await import('../server/epic-review.ts');
const git=(path,...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
after(()=>rmSync(root,{recursive:true,force:true}));
async function fixture(run,mode='isolated'){
 const directory=mkdtempSync(join(root,'case-'));const repo=join(directory,'repo');mkdirSync(repo);
 git(repo,'init','-b','main');git(repo,'config','user.email','test@example.com');git(repo,'config','user.name','Test');
 writeFileSync(join(repo,'a.txt'),'a\n');git(repo,'add','.');git(repo,'commit','-m','base');
 const db=new CerebroDatabase(':memory:');const project=db.createProject('Demo',repo,mode);
 const session=id=>db.createSession({id,projectId:project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:id,status:'exited',agentSessionId:'fake'},'token');
 try{await run({db,repo,project,session});}finally{db.close();}
}
test('isolated epic: scope is the shared worktree against its base, commits and untracked files included',async()=>fixture(async f=>{
 const id=randomUUID();f.session(id);const workspace=await createWorkspace(f.db,id,f.project);
 writeFileSync(join(workspace.path,'b.txt'),'b\n');git(workspace.path,'add','b.txt');git(workspace.path,'commit','-m','step one');
 writeFileSync(join(workspace.path,'a.txt'),'changed\n');writeFileSync(join(workspace.path,'c.txt'),'c\n');
 const scope=await epicReviewScope(f.db,{projectId:f.project.id,contextRoot:workspace.path,baseHead:null});
 assert.equal(scope.mode,'isolated');assert.equal(scope.base,workspace.base);assert.equal(scope.path,workspace.path);
 assert.deepEqual(scope.files,['a.txt','b.txt','c.txt']);assert.equal(scope.commits.length,1);assert.match(scope.commits[0],/step one/);
 const text=epicReviewInstructions('Livraison',scope);
 assert.match(text,new RegExp(`git diff ${workspace.base}`));assert.match(text,/c\.txt/);assert.match(text,/Ne modifie aucun fichier/);assert.match(text,/cerebro-findings/);
 assert.doesNotMatch(text,/Attention : ce dossier est partagé/);
}));
test('isolated epic without changes or without its worktree has nothing to review',async()=>fixture(async f=>{
 const id=randomUUID();f.session(id);const workspace=await createWorkspace(f.db,id,f.project);
 await assert.rejects(epicReviewScope(f.db,{projectId:f.project.id,contextRoot:workspace.path,baseHead:null}),/Aucun changement/);
 await assert.rejects(epicReviewScope(f.db,{projectId:f.project.id,contextRoot:f.repo,baseHead:null}),/worktree de l’epic est introuvable/);
}));
test('shared project folder: scope runs from the HEAD recorded when the epic started',async()=>fixture(async f=>{
 const baseHead=git(f.repo,'rev-parse','HEAD');
 writeFileSync(join(f.repo,'b.txt'),'b\n');git(f.repo,'add','b.txt');git(f.repo,'commit','-m','epic step');writeFileSync(join(f.repo,'c.txt'),'c\n');
 const scope=await epicReviewScope(f.db,{projectId:f.project.id,contextRoot:f.repo,baseHead});
 assert.equal(scope.mode,'shared');assert.equal(scope.base,baseHead);assert.equal(scope.path,f.repo);assert.deepEqual(scope.files,['b.txt','c.txt']);
 assert.match(epicReviewInstructions('E',scope),/Attention : ce dossier est partagé/);
 // Without a recorded base only the uncommitted work is known.
 const partial=await epicReviewScope(f.db,{projectId:f.project.id,contextRoot:f.repo,baseHead:null});
 assert.equal(partial.base,null);assert.deepEqual(partial.files,['c.txt']);assert.match(epicReviewInstructions('E',partial),/git diff HEAD/);
},'shared'));
test('the review step is recognised and a missing scope falls back to a generic instruction',()=>{
 assert.ok(isReviewTask({text:reviewTaskText('E')}));assert.ok(!isReviewTask({text:`autre\n${REVIEW_TASK_TITLE}`}));
 assert.match(epicReviewInstructions('E',null),/n’a pas pu être préparé/);
});
test('the runner completes the review step prompt with the epic scope, other steps are untouched',async()=>{
 await fixture(async f=>{
  const epic=f.db.createEpic(f.project.id,'Livraison','Contexte',null);const commands=new CommandExecutor(f.db);const prompts=[];
  const sessions={async create(p,options){prompts.push(options.prompt);return f.db.createSession({id:randomUUID(),projectId:p.id,...options,title:'step',status:'idle',agentSessionId:'fake'},'token');},kill(id){f.db.updateSession(id,{status:'exited',exitCode:130});return true;}};
  const runner=new EpicRunner(f.db,sessions,commands,()=>{});
  try{
   const work=f.db.createTask(f.project.id,'Implémenter',null,epic.id);
   const review=f.db.createTask(f.project.id,reviewTaskText('Livraison'),null,epic.id);f.db.updateTask(review.id,{dependsOn:[work.id]});
   writeFileSync(join(f.repo,'feature.txt'),'x\n');
   runner.start(epic.id,DEFAULT_SESSION_DEFAULTS);
   const until=async predicate=>{for(let i=0;i<1000;i++){runner.poke();if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Timed out');};
   await until(()=>prompts.length===1);assert.doesNotMatch(prompts[0],/perimetre_cerebro/);
   f.db.updateTask(work.id,{status:'done'});await until(()=>prompts.length===2);
   assert.match(prompts[1],/<perimetre_cerebro>/);assert.match(prompts[1],/feature\.txt/);assert.match(prompts[1],/Fais une code review du travail produit par l’epic « Livraison »/);
  }finally{await runner.shutdown();await commands.shutdown();}
 },'shared');
});

const finding=(id,dependsOn=[])=>({id,title:`Corriger ${id}`,severity:'high',file:'feature.txt',line:1,problem:'Valeur incorrecte',scenario:'Entrée vide',expectedFix:'Valider la valeur',dependsOn,taskDependencies:[]});
async function withRunner(f,run){
 const epic=f.db.createEpic(f.project.id,'Livraison','Contexte',null);const commands=new CommandExecutor(f.db);const launches=[];
 const sessions={
  async create(project,options,{validate,title,epicId}={}){
   const session=f.db.createSession({id:randomUUID(),projectId:project.id,...options,title,status:'idle',agentSessionId:'fake'},'token',epicId);
   const context=epicWorkspace(f.db,epic.id);
   const workspace=context?await createWorkspaceInContext(f.db,session.id,project,context):await createWorkspace(f.db,session.id,project);
   rememberEpicWorkspace(f.db,epic.id,{path:workspace.path,mode:workspace.mode});
   await validate?.();launches.push(session);return session;
  },
  kill(id){f.db.updateSession(id,{status:'exited',exitCode:130});return true;},
 };
 let runner=new EpicRunner(f.db,sessions,commands,()=>{});
 const latest=()=>runner.list(epic.id)[0];
 const until=async predicate=>{for(let i=0;i<1000;i++){runner.poke();if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error(`Timed out: ${JSON.stringify(latest())}`);};
 try{await run({epic,commands,launches,latest,until,get runner(){return runner;},restart:async()=>{await runner.shutdown();runner=new EpicRunner(f.db,sessions,commands,()=>{});}});}
 finally{await runner.shutdown();await commands.shutdown();}
}

test('findings after a completed epic run continue in its original worktree, including command steps',async()=>fixture(async f=>withRunner(f,async r=>{
 const work=f.db.createTask(f.project.id,'Implémenter',null,r.epic.id);
 r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS);await r.until(()=>r.latest().status==='waiting-validation');
 const workspace=workspaceFor(f.db,r.launches[0].id);
 writeFileSync(join(workspace.path,'feature.txt'),'travail de l’epic\n');git(workspace.path,'add','.');git(workspace.path,'commit','-m','feature');
 f.db.updateTask(work.id,{status:'done'});await r.until(()=>r.latest().status==='succeeded');
 const firstRun=r.latest();
 const review=f.db.createSession({id:randomUUID(),projectId:f.project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'review',title:'review',status:'exited',agentSessionId:'fake'},'token',r.epic.id);
 await joinWorkspace(f.db,review.id,workspace);
 const report=saveReport(f.db,review.id,{title:'Corrections',findings:[finding('a'),finding('b',['a'])]});
 const imported=importFindings(f.db,review.id,report.id,['a','b']);
 assert.equal(imported.epic.id,r.epic.id);
 await r.restart();
 const nextRun=r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS);
 assert.notEqual(nextRun.id,firstRun.id);assert.equal(nextRun.contextRoot,workspace.path);assert.equal(nextRun.baseHead,firstRun.baseHead);
 assert.deepEqual(nextRun.order,imported.tasks.map(task=>task.id));
 for(const task of imported.tasks){
  await r.until(()=>r.latest().status==='waiting-validation'&&r.latest().currentTaskId===task.id);
  assert.equal(workspaceFor(f.db,r.latest().sessionId).path,workspace.path);
  assert.equal(readFileSync(join(workspace.path,'feature.txt'),'utf8'),'travail de l’epic\n');
  f.db.updateTask(task.id,{status:'done'});
 }
 await r.until(()=>r.latest().status==='succeeded');
 assert.equal(existsSync(join(f.repo,'feature.txt')),false);
 assert.equal(git(f.repo,'worktree','list','--porcelain').split('\n').filter(line=>line.startsWith('worktree ')).length,2);
 const command=r.commands.configure(f.project.id,{name:'Vérifier le travail',executable:process.execPath,args:['-e',"console.log(require('node:fs').readFileSync('feature.txt','utf8'))"],cwd:'.',timeoutSeconds:5});
 const check=f.db.createTask(f.project.id,'Vérifier',null,r.epic.id,{type:'command',commandId:command.id,completion:'exit-zero'});
 r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS);await r.until(()=>r.latest().status==='succeeded');
 assert.equal(r.commands.listRuns(check.id)[0].cwd,workspace.path);assert.match(r.commands.listRuns(check.id)[0].output,/travail de l’epic/);
 const scope=await epicReviewScope(f.db,r.latest());assert.equal(scope.base,workspace.base);assert.ok(scope.files.includes('feature.txt'));
})));

test('findings from an active review step require replanning and wait for the review to finish',async()=>fixture(async f=>withRunner(f,async r=>{
 const review=f.db.createTask(f.project.id,reviewTaskText('Livraison'),null,r.epic.id);
 r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS);await r.until(()=>r.latest().status==='waiting-validation');
 const sessionId=r.latest().sessionId;const workspace=workspaceFor(f.db,sessionId);
 const report=saveReport(f.db,sessionId,{title:'Corrections',findings:[finding('a')]});
 const imported=importFindings(f.db,sessionId,report.id,['a']);
 await r.until(()=>r.latest().status==='blocked');assert.match(r.latest().error,/Composition/);
 assert.equal(f.db.getTask(imported.tasks[0].id).status,'todo');
 await r.restart();r.runner.resume(r.latest().id,true);await r.until(()=>r.latest().status==='waiting-validation');
 assert.equal(r.latest().currentTaskId,review.id);assert.equal(r.launches.length,1);
 f.db.updateTask(review.id,{status:'done'});
 await r.until(()=>r.latest().status==='waiting-validation'&&r.latest().currentTaskId===imported.tasks[0].id);
 assert.equal(workspaceFor(f.db,r.latest().sessionId).path,workspace.path);
 f.db.updateTask(imported.tasks[0].id,{status:'done'});await r.until(()=>r.latest().status==='succeeded');
})));

test('a removed or missing epic worktree refuses continuation instead of copying the project',async()=>fixture(async f=>withRunner(f,async r=>{
 const work=f.db.createTask(f.project.id,'Implémenter',null,r.epic.id);
 r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS);await r.until(()=>r.latest().status==='waiting-validation');
 const workspace=workspaceFor(f.db,r.latest().sessionId);
 f.db.updateTask(work.id,{status:'done'});await r.until(()=>r.latest().status==='succeeded');
 f.db.createTask(f.project.id,'Corriger',null,r.epic.id);
 f.db.connection.prepare('UPDATE session_workspaces SET data=? WHERE session_id=?').run(JSON.stringify({...workspace,removedAt:Date.now()}),workspace.sessionId);
 assert.throws(()=>r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS),/worktree.*introuvable/);
 f.db.connection.prepare('UPDATE session_workspaces SET data=? WHERE session_id=?').run(JSON.stringify(workspace),workspace.sessionId);
 git(f.repo,'worktree','remove','--force',workspace.root);
 assert.throws(()=>r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS),/worktree.*introuvable/);
 assert.equal(r.runner.list(r.epic.id).length,1);assert.equal(r.launches.length,1);
})));

test('successive runs in the shared project folder preserve the original epic review base',async()=>fixture(async f=>withRunner(f,async r=>{
 const originalHead=git(f.repo,'rev-parse','HEAD');const work=f.db.createTask(f.project.id,'Implémenter',null,r.epic.id);
 r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS);await r.until(()=>r.latest().status==='waiting-validation');
 writeFileSync(join(f.repo,'feature.txt'),'x\n');git(f.repo,'add','.');git(f.repo,'commit','-m','feature');
 f.db.updateTask(work.id,{status:'done'});await r.until(()=>r.latest().status==='succeeded');
 const fix=f.db.createTask(f.project.id,'Corriger',null,r.epic.id);r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS);
 assert.equal(r.latest().contextRoot,f.repo);assert.equal(r.latest().baseHead,originalHead);
 await r.until(()=>r.latest().status==='waiting-validation');
 const scope=await epicReviewScope(f.db,r.latest());assert.equal(scope.base,originalHead);assert.deepEqual(scope.files,['feature.txt']);
 f.db.updateTask(fix.id,{status:'done'});await r.until(()=>r.latest().status==='succeeded');
}),'shared'));

test('switching the project to shared mode keeps later epic runs in their original worktree',async()=>fixture(async f=>withRunner(f,async r=>{
 const work=f.db.createTask(f.project.id,'Implémenter',null,r.epic.id);
 r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS);await r.until(()=>r.latest().status==='waiting-validation');
 const workspace=workspaceFor(f.db,r.latest().sessionId);
 f.db.updateTask(work.id,{status:'done'});await r.until(()=>r.latest().status==='succeeded');
 f.db.updateProject(f.project.id,{workspaceMode:'shared'});
 const next=f.db.createTask(f.project.id,'Suite',null,r.epic.id);r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS);
 assert.equal(r.latest().contextRoot,workspace.path);await r.until(()=>r.latest().status==='waiting-validation');
 assert.equal(workspaceFor(f.db,r.latest().sessionId).mode,'isolated');
 assert.equal(workspaceFor(f.db,r.latest().sessionId).path,workspace.path);
 f.db.updateTask(next.id,{status:'done'});await r.until(()=>r.latest().status==='succeeded');
})));

test('switching a shared epic to isolation keeps later steps and reviews in its original folder',async()=>fixture(async f=>withRunner(f,async r=>{
 const work=f.db.createTask(f.project.id,'Implémenter',null,r.epic.id);
 r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS);await r.until(()=>r.latest().status==='waiting-validation');
 writeFileSync(join(f.repo,'feature.txt'),'travail partagé\n');
 f.db.updateTask(work.id,{status:'done'});await r.until(()=>r.latest().status==='succeeded');
 f.db.updateProject(f.project.id,{workspaceMode:'isolated'});await r.restart();
 const next=f.db.createTask(f.project.id,'Corriger',null,r.epic.id);r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS);
 assert.equal(r.latest().contextRoot,f.repo);await r.until(()=>r.latest().status==='waiting-validation');
 assert.equal(workspaceFor(f.db,r.latest().sessionId).mode,'shared');
 assert.equal(workspaceFor(f.db,r.latest().sessionId).path,f.repo);
 assert.equal((await epicReviewScope(f.db,r.latest())).path,f.repo);
 f.db.updateTask(next.id,{status:'done'});await r.until(()=>r.latest().status==='succeeded');
}),'shared'));

test('a command that starts an epic establishes one folder for later LLM steps',async()=>fixture(async f=>withRunner(f,async r=>{
 const command=r.commands.configure(f.project.id,{name:'Préparer',executable:process.execPath,args:['-e',"require('node:fs').writeFileSync('prepared.txt','ready')"],cwd:'.',timeoutSeconds:5});
 const prepare=f.db.createTask(f.project.id,'Préparer',null,r.epic.id,{type:'command',commandId:command.id,completion:'exit-zero'});
 const next=f.db.createTask(f.project.id,'Continuer',null,r.epic.id);f.db.setTaskDependencies(next.id,[prepare.id]);
 r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS);await r.until(()=>r.latest().status==='waiting-validation');
 assert.equal(r.latest().workspace.path,f.repo);assert.equal(workspaceFor(f.db,r.latest().sessionId).mode,'shared');
 assert.equal(readFileSync(join(workspaceFor(f.db,r.latest().sessionId).path,'prepared.txt'),'utf8'),'ready');
 assert.equal(git(f.repo,'worktree','list','--porcelain').split('\n').filter(line=>line.startsWith('worktree ')).length,1);
 f.db.updateTask(next.id,{status:'done'});await r.until(()=>r.latest().status==='succeeded');
})));

test('unrelated shared sessions do not choose the context of a new isolated epic',async()=>fixture(async f=>{
 f.db.updateProject(f.project.id,{workspaceMode:'shared'});f.session('unrelated');await createWorkspace(f.db,'unrelated',f.db.getProject(f.project.id));
 f.db.updateProject(f.project.id,{workspaceMode:'isolated'});
 await withRunner(f,async r=>{
  const task=f.db.createTask(f.project.id,'Commencer',null,r.epic.id);r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS);
  await r.until(()=>r.latest().status==='waiting-validation');
  assert.equal(workspaceFor(f.db,r.latest().sessionId).mode,'isolated');assert.notEqual(r.latest().contextRoot,f.repo);
  f.db.updateTask(task.id,{status:'done'});await r.until(()=>r.latest().status==='succeeded');
 });
}));

test('legacy epics with conflicting execution folders stay inspectable and refuse automatic continuation',async()=>fixture(async f=>withRunner(f,async r=>{
 for(const id of ['old-a','old-b']){
  f.session(id);const workspace=await createWorkspace(f.db,id,f.project);
  const run={id:randomUUID(),epicId:r.epic.id,projectId:f.project.id,status:'succeeded',order:[],members:[],versions:{},results:{},currentTaskId:null,sessionId:null,commandRunId:null,stepStartedAt:0,contextRoot:workspace.path,options:DEFAULT_SESSION_DEFAULTS,error:null,startedAt:1,updatedAt:1};
  f.db.connection.prepare('INSERT INTO epic_runs VALUES (?,?,?)').run(run.id,r.epic.id,JSON.stringify(run));
 }
 f.db.createTask(f.project.id,'Corriger',null,r.epic.id);
 assert.equal(r.runner.list(r.epic.id).length,2);
 assert.throws(()=>r.runner.start(r.epic.id,DEFAULT_SESSION_DEFAULTS),/plusieurs dossiers/);
 assert.equal(r.launches.length,0);
 assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS total FROM epic_workspaces').get().total,0);
})));

const epicSession=(f,epicId)=>f.db.createSession({id:randomUUID(),projectId:f.project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:'étape',status:'exited',agentSessionId:'fake'},'token',epicId);
const knownRun=(f,epicId,workspace)=>{
 const run={id:randomUUID(),epicId,projectId:f.project.id,status:'succeeded',order:[],members:[],versions:{},results:{},currentTaskId:null,sessionId:null,commandRunId:null,stepStartedAt:0,contextRoot:workspace.path,workspace:{path:workspace.path,mode:workspace.mode},options:DEFAULT_SESSION_DEFAULTS,error:null,startedAt:2,updatedAt:2};
 f.db.connection.prepare('INSERT INTO epic_runs VALUES (?,?,?)').run(run.id,epicId,JSON.stringify(run));
};
const savedContexts=f=>f.db.connection.prepare('SELECT epic_id,data,verified FROM epic_workspaces').all().map(row=>({...row}));

test('a known run does not hide an earlier epic session that worked in another folder',async()=>fixture(async f=>{
 const epic=f.db.createEpic(f.project.id,'Livraison','',null);
 const earlier=await createWorkspace(f.db,epicSession(f,epic.id).id,f.project);
 const later=await createWorkspace(f.db,epicSession(f,epic.id).id,f.project);
 knownRun(f,epic.id,later);
 assert.throws(()=>epicWorkspace(f.db,epic.id),error=>/plusieurs dossiers/.test(error.message)&&error.message.includes(earlier.path)&&error.message.includes(later.path));
 assert.deepEqual(savedContexts(f),[]);
 assert.equal(existsSync(earlier.path),true);assert.equal(existsSync(later.path),true);
}));

test('a consistent history is remembered as verified',async()=>fixture(async f=>{
 const epic=f.db.createEpic(f.project.id,'Livraison','',null);
 const workspace=await createWorkspace(f.db,epicSession(f,epic.id).id,f.project);
 await joinWorkspace(f.db,epicSession(f,epic.id).id,workspace);knownRun(f,epic.id,workspace);
 assert.deepEqual(epicWorkspace(f.db,epic.id),{path:workspace.path,mode:'isolated'});
 assert.deepEqual(savedContexts(f),[{epic_id:epic.id,data:JSON.stringify({path:workspace.path,mode:'isolated'}),verified:1}]);
}));

test('contexts remembered by the former incomplete recovery are checked against the whole history',async()=>fixture(async f=>{
 const conflicting=f.db.createEpic(f.project.id,'Conflit','',null);const consistent=f.db.createEpic(f.project.id,'Cohérent','',null);
 const earlier=await createWorkspace(f.db,epicSession(f,conflicting.id).id,f.project);
 const later=await createWorkspace(f.db,epicSession(f,conflicting.id).id,f.project);
 const own=await createWorkspace(f.db,epicSession(f,consistent.id).id,f.project);
 const legacy=(epicId,workspace)=>f.db.connection.prepare('INSERT INTO epic_workspaces (epic_id,data,verified) VALUES (?,?,0)').run(epicId,JSON.stringify({path:workspace.path,mode:workspace.mode}));
 legacy(conflicting.id,later);legacy(consistent.id,own);
 assert.throws(()=>epicWorkspace(f.db,conflicting.id),new RegExp(`plusieurs dossiers.*${earlier.path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));
 assert.throws(()=>rememberEpicWorkspace(f.db,conflicting.id,{path:earlier.path,mode:'isolated'}),/diffère du dossier d’origine/);
 assert.deepEqual(epicWorkspace(f.db,consistent.id),{path:own.path,mode:'isolated'});
 assert.deepEqual(savedContexts(f).map(row=>[row.epic_id,row.verified]).sort(),[[conflicting.id,0],[consistent.id,1]].sort());
}));

test('the legacy table gains the verification flag without trusting its existing rows',()=>{
 const path=join(mkdtempSync(join(root,'legacy-')),'cerebro.db');
 let db=new CerebroDatabase(path);const project=db.createProject('Demo',root);const epic=db.createEpic(project.id,'Ancien','',null);
 db.connection.exec('DROP TABLE epic_workspaces;CREATE TABLE epic_workspaces (epic_id TEXT PRIMARY KEY REFERENCES epics(id) ON DELETE CASCADE, data TEXT NOT NULL)');
 db.connection.prepare('INSERT INTO epic_workspaces VALUES (?,?)').run(epic.id,JSON.stringify({path:root,mode:'shared'}));db.close();
 db=new CerebroDatabase(path);
 try{assert.equal(db.connection.prepare('SELECT verified FROM epic_workspaces WHERE epic_id=?').get(epic.id).verified,0);}finally{db.close();}
});

test('choosing a historic copy preserves files and tasks, then restarts an interrupted LLM step in that copy',async()=>fixture(async f=>withRunner(f,async r=>{
 const original=epicSession(f,r.epic.id);const workspace=await createWorkspace(f.db,original.id,f.project);
 const wrong=epicSession(f,r.epic.id);await createWorkspaceInContext(f.db,wrong.id,f.project,{path:f.repo,mode:'shared'});
 writeFileSync(join(workspace.path,'only-in-copy.txt'),'original\n');writeFileSync(join(f.repo,'only-in-project.txt'),'other work\n');
 const finished=f.db.createTask(f.project.id,'Terminé',null,r.epic.id);f.db.updateTask(finished.id,{status:'done'});
 const pending=f.db.createTask(f.project.id,'À reprendre',null,r.epic.id);f.db.updateTask(pending.id,{status:'started',sessionId:wrong.id});
 const run={id:randomUUID(),epicId:r.epic.id,projectId:f.project.id,status:'blocked',order:[pending.id],members:[finished.id,pending.id],versions:{},results:{[finished.id]:'declared-done'},currentTaskId:pending.id,sessionId:wrong.id,commandRunId:null,stepStartedAt:1,contextRoot:f.repo,workspace:{path:f.repo,mode:'shared'},options:DEFAULT_SESSION_DEFAULTS,error:'Error: Cet epic a utilisé plusieurs dossiers de travail',startedAt:1,updatedAt:1};
 f.db.connection.prepare('INSERT INTO epic_runs VALUES (?,?,?)').run(run.id,r.epic.id,JSON.stringify(run));
 f.db.connection.prepare('INSERT INTO epic_workspaces (epic_id,data,verified) VALUES (?,?,0)').run(r.epic.id,JSON.stringify(run.workspace));
 const options=await epicWorkspaceOptions(f.db,r.epic.id);
 assert.equal(options.conflict,true);assert.equal(options.selected,null);assert.equal(options.choices.length,2);
 const copy=options.choices.find(choice=>choice.path===workspace.path);
 assert.equal(copy.head,git(workspace.path,'rev-parse','HEAD'));assert.equal(copy.branch,workspace.branch);
 assert.ok(copy.changes.includes('?? only-in-copy.txt'));assert.ok(copy.sessions.some(session=>session.id===original.id));
 assert.equal(savedContexts(f)[0].verified,0);assert.equal(r.latest().workspaceConflict,true);
 assert.throws(()=>r.runner.selectWorkspace(r.epic.id,root),/attesté/);
 const context=r.runner.selectWorkspace(r.epic.id,workspace.path);
 assert.deepEqual(context,{path:workspace.path,mode:'isolated'});assert.equal(savedContexts(f)[0].verified,1);
 assert.equal(r.latest().status,'blocked');assert.equal(r.latest().workspaceConflict,false);
 assert.equal(f.db.getTask(pending.id).status,'started');assert.equal(f.db.getTask(finished.id).status,'done');assert.equal(r.launches.length,0);
 assert.equal(existsSync(join(f.repo,'only-in-copy.txt')),false);assert.equal(existsSync(join(workspace.path,'only-in-project.txt')),false);
 assert.equal(readFileSync(join(workspace.path,'only-in-copy.txt'),'utf8'),'original\n');
 assert.equal(readFileSync(join(f.repo,'only-in-project.txt'),'utf8'),'other work\n');
 await r.restart();f.db.updateProject(f.project.id,{workspaceMode:'shared'});
 assert.deepEqual(epicWorkspace(f.db,r.epic.id),context);
 r.runner.resume(run.id,true);await r.until(()=>r.latest().status==='waiting-validation');
 assert.equal(r.latest().contextRoot,workspace.path);assert.notEqual(f.db.getTask(pending.id).sessionId,wrong.id);
 assert.equal(workspaceFor(f.db,r.latest().sessionId).path,workspace.path);
 f.db.updateTask(pending.id,{status:'done'});await r.until(()=>r.latest().status==='succeeded');
 assert.equal(r.latest().results[finished.id],'declared-done');
})));

test('a successful command from another folder is rerun in the chosen copy before it can be auto-validated',async()=>fixture(async f=>withRunner(f,async r=>{
 const workspace=await createWorkspace(f.db,epicSession(f,r.epic.id).id,f.project);
 await createWorkspaceInContext(f.db,epicSession(f,r.epic.id).id,f.project,{path:f.repo,mode:'shared'});
 const command=r.commands.configure(f.project.id,{name:'Cwd',executable:process.execPath,args:['-e','console.log(process.cwd())'],cwd:'.',timeoutSeconds:5});
 const task=f.db.createTask(f.project.id,'Vérifier',null,r.epic.id,{type:'command',commandId:command.id,completion:'manual'});
 f.db.updateTask(task.id,{status:'started'});
 const old={id:randomUUID(),taskId:task.id,pid:null,command,cwd:f.repo,status:'succeeded',output:f.repo,startedAt:1,finishedAt:2,exitCode:0,error:null};
 f.db.connection.prepare('INSERT INTO command_runs VALUES (?,?,?)').run(old.id,task.id,JSON.stringify(old));
 const run={id:randomUUID(),epicId:r.epic.id,projectId:f.project.id,status:'blocked',order:[task.id],members:[task.id],versions:{},results:{[task.id]:'execution-succeeded'},currentTaskId:task.id,sessionId:null,commandRunId:old.id,stepStartedAt:1,contextRoot:f.repo,options:DEFAULT_SESSION_DEFAULTS,autoValidate:true,error:'Error: Cet epic a utilisé plusieurs dossiers de travail',startedAt:1,updatedAt:1};
 f.db.connection.prepare('INSERT INTO epic_runs VALUES (?,?,?)').run(run.id,r.epic.id,JSON.stringify(run));
 r.runner.selectWorkspace(r.epic.id,workspace.path);assert.equal(f.db.getTask(task.id).status,'started');
 r.runner.resume(run.id,true);await r.until(()=>r.latest().status==='succeeded');
 const commands=r.commands.listRuns(task.id);assert.equal(commands.length,2);
 assert.equal(commands[0].cwd,workspace.path);assert.equal(commands[0].output.trim(),workspace.path);
 assert.equal(r.latest().contextRoot,workspace.path);assert.equal(f.db.getTask(task.id).status,'done');
 assert.equal(r.latest().results[task.id],'auto-validated');
})));
