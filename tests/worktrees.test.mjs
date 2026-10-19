import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root=mkdtempSync(join(tmpdir(),'cerebro-worktree-tests-'));
process.env.CEREBRO_DATA_DIR=join(root,'data');process.env.HOME=root;
const {CerebroDatabase}=await import('../server/db.ts');
const {createWorkspace,workspaceFor}=await import('../server/provenance.ts');
const {WorktreeManager}=await import('../server/worktrees.ts');
const {SessionManager}=await import('../server/sessions.ts');
const {assertWorktreeAvailable,deferWorktreeInput,lockWorktrees}=await import('../server/worktree-gate.ts');
const git=(path,...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
after(()=>rmSync(root,{recursive:true,force:true}));
async function fixture(run,initialDirty=false){
 const directory=mkdtempSync(join(root,'case-'));const repo=join(directory,'source');mkdirSync(repo);
 git(repo,'init','-b','main');git(repo,'config','user.email','test@example.com');git(repo,'config','user.name','Test');
 writeFileSync(join(repo,'file'),'base\n');writeFileSync(join(repo,'.gitignore'),'ignored\n');git(repo,'add','.');git(repo,'commit','-m','base');
 if(initialDirty)writeFileSync(join(repo,'file'),'changes already in project\n');
 let db=new CerebroDatabase(join(directory,'db.sqlite'));const project=db.createProject('Project',repo);const id=randomUUID();
 db.createSession({id,projectId:project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:'Conversation',status:'exited',agentSessionId:'fake'},'token');
 const workspace=await createWorkspace(db,id,project);let manager=new WorktreeManager(db);
 const view=async()=>{const listing=await manager.list(project.id);return listing.worktrees.find(w=>w.sessionId===id);};
 const untilFinished=async operation=>{for(let i=0;i<500;i++){const current=await manager.get(operation.worktreeId);if(current.operation?.id===operation.id&&current.operation.status!=='running')return current.operation;await new Promise(r=>setTimeout(r,10));}throw new Error('Operation timeout');};
 const merge=async()=>{const v=await view();const p=await manager.prepare(v.id,'merge');const op=await manager.start(v.id,'merge',p.token);return untilFinished(op);};
 const commit=(text='session work')=>{writeFileSync(join(workspace.path,'file'),text+'\n');git(workspace.path,'commit','-am',text);return git(workspace.path,'rev-parse','HEAD');};
 const f={repo,project,id,workspace,view,merge,commit,untilFinished,get db(){return db;},get manager(){return manager;},restart:async()=>{await manager.shutdown();db.close();db=new CerebroDatabase(join(directory,'db.sqlite'));manager=new WorktreeManager(db);}};
 try{await run(f);}finally{await manager.shutdown();db.close();}
}

test('global/project inventory includes primary, managed and external worktrees with explicit targets',async()=>fixture(async f=>{
 const external=join(root,randomUUID()+' external');git(f.repo,'worktree','add','-b','external',external);
 const list=await f.manager.list(f.project.id);assert.equal(list.worktrees.length,3);
 const own=await f.view();assert.equal(own.targetBranch,'refs/heads/main');assert.equal(own.dirty,0);assert.equal(own.ahead,0);assert.equal(own.integration,'integrated');assert.equal(own.managed,true);
 const primary=list.worktrees.find(w=>w.path===f.repo);assert.equal(primary.primary,true);assert.ok(primary.removeBlockers.length);
 const ext=list.worktrees.find(w=>w.path===external);assert.equal(ext.managed,false);assert.ok(ext.removeBlockers.length);
}));

test('deleting a conversation and then its project retains files and globally discoverable identity across restart',async()=>fixture(async f=>{
 writeFileSync(join(f.workspace.path,'uncommitted'),'valuable\n');f.commit();
 const sessions=new SessionManager(f.db);await sessions.delete(f.id);let list=await f.manager.list(f.project.id);let own=list.worktrees.find(w=>w.sessionId===f.id);
 assert.equal(own.session,null);assert.equal(own.projectName,'Project');assert.equal(own.dirty,1);assert.equal(own.ahead,1);assert.equal(readFileSync(join(own.path,'uncommitted'),'utf8'),'valuable\n');
 f.db.deleteProject(f.project.id);await f.restart();list=await f.manager.list();own=list.worktrees.find(w=>w.sessionId===f.id);assert.ok(own);assert.equal(own.projectExists,false);assert.equal(own.session,null);assert.ok(existsSync(own.path));
}));

test('merge then continued conversation reopens pending work on the same branch, across repeated merges/restart',async()=>fixture(async f=>{
 const first=f.commit('first');const operation=await f.merge();assert.equal(operation.status,'succeeded',JSON.stringify(operation));assert.equal(git(f.repo,'rev-parse','HEAD'),first);
 let own=await f.view();assert.equal(own.integration,'integrated');assert.equal(own.ahead,0);assert.ok(existsSync(own.path));assert.equal(git(own.path,'symbolic-ref','--short','HEAD'),f.workspace.branch);
 writeFileSync(join(own.path,'next'),'continued\n');own=await f.view();assert.equal(own.dirty,1);assert.equal(own.ahead,0);assert.equal(own.integration,'pending');assert.ok(own.removeBlockers.length);
 git(own.path,'add','next');git(own.path,'commit','-m','continued');own=await f.view();assert.equal(own.dirty,0);assert.equal(own.ahead,1);assert.equal(own.integration,'pending');
 assert.equal((await f.merge()).status,'succeeded');await f.restart();own=await f.view();assert.equal(own.integration,'integrated');assert.equal(own.ahead,0);assert.equal(git(f.repo,'show','HEAD:next'),'continued');
}));

test('dirty source, target, active sessions, command use and missing targets block unsafe actions',async()=>fixture(async f=>{
 f.commit();let own=await f.view();
 writeFileSync(join(own.path,'new'),'not committed');await assert.rejects(f.manager.prepare(own.id,'merge'),/modifié/);rmSync(join(own.path,'new'));
 writeFileSync(join(f.repo,'file'),'human local\n');await assert.rejects(f.manager.prepare(own.id,'merge'),/cible doit être propre/);assert.equal(readFileSync(join(f.repo,'file'),'utf8'),'human local\n');git(f.repo,'restore','file');
 f.db.updateSession(f.id,{status:'running'});await assert.rejects(f.manager.prepare(own.id,'merge'),/Session/);f.db.updateSession(f.id,{status:'idle'});
 assert.ok((await f.view()).mergeBlockers.length===0);assert.ok((await f.view()).removeBlockers.some(s=>s.includes('Session')));
 f.db.updateSession(f.id,{status:'exited'});
 const fake={id:'command',cwd:own.path,status:'running'};f.db.connection.prepare('INSERT INTO command_runs VALUES (?,?,?)').run(fake.id,'task',JSON.stringify(fake));await assert.rejects(f.manager.prepare(own.id,'merge'),/commande/);f.db.connection.prepare('DELETE FROM command_runs').run();
 await assert.rejects(f.manager.target(own.id,'refs/heads/nonexistent'),/Choisissez/);
}));

test('stale confirmations are refused and merge conflicts preserve both branches and worktree files',async()=>fixture(async f=>{
 f.commit('source');let own=await f.view();const plan=await f.manager.prepare(own.id,'merge');writeFileSync(join(f.repo,'other'),'new target');git(f.repo,'add','.');git(f.repo,'commit','-m','target change');
 await assert.rejects(f.manager.start(own.id,'merge',plan.token),/changé/);
 writeFileSync(join(f.repo,'file'),'target conflicting\n');git(f.repo,'commit','-am','conflict');const sourceHead=git(own.path,'rev-parse','HEAD');const targetHead=git(f.repo,'rev-parse','HEAD');
 const failed=await f.merge();assert.equal(failed.status,'failed');assert.match(failed.error,/conflits éventuels/);assert.equal(git(own.path,'rev-parse','HEAD'),sourceHead);assert.equal(git(f.repo,'rev-parse','HEAD'),targetHead);assert.ok(existsSync(join(f.repo,'.git/MERGE_HEAD')));assert.equal(readFileSync(join(own.path,'file'),'utf8'),'source\n');
 own=await f.view();assert.ok(own.mergeBlockers.some(s=>s.includes('cible doit être propre')));assert.equal(own.integration,'pending');
}));

test('removal requires integration, no local/ignored files and no live session; branch remains recoverable',async()=>fixture(async f=>{
 f.commit();let own=await f.view();await assert.rejects(f.manager.prepare(own.id,'remove'),/commits restent/);
 assert.equal((await f.merge()).status,'succeeded');writeFileSync(join(own.path,'ignored'),'config');own=await f.view();assert.equal(own.ignored,1);await assert.rejects(f.manager.prepare(own.id,'remove'),/ignoré/);rmSync(join(own.path,'ignored'));
 f.db.updateSession(f.id,{status:'idle'});await assert.rejects(f.manager.prepare(own.id,'remove'),/Session/);f.db.updateSession(f.id,{status:'exited'});
 const plan=await f.manager.prepare(own.id,'remove');const operation=await f.manager.start(own.id,'remove',plan.token);
 await f.manager.shutdown();assert.equal(existsSync(own.path),false);assert.equal(git(f.repo,'rev-parse',f.workspace.branch),git(f.repo,'rev-parse','HEAD'));assert.ok(workspaceFor(f.db,f.id).removedAt);
 const result=(await f.manager.list()).worktrees;assert.ok(!result.some(w=>w.id===own.id));assert.equal(f.db.getSession(f.id).title,'Conversation');
 const sessions=new SessionManager(f.db);await assert.rejects(sessions.resume(f.id),/supprimé/);
}));

test('merges serialize actions, defer interactive input, and obey hooks',async()=>fixture(async f=>{
 f.commit();writeFileSync(join(f.repo,'target'),'target');git(f.repo,'add','.');git(f.repo,'commit','-m','diverge');
 // A non-fast-forward merge exercises the standard pre-merge-commit hook.
 writeFileSync(join(f.repo,'.git/hooks/pre-merge-commit'),'#!/bin/sh\nsleep 0.3\necho refused >&2\nexit 1\n',{mode:0o755});
 const own=await f.view();const p=await f.manager.prepare(own.id,'merge');const operation=await f.manager.start(own.id,'merge',p.token);
 assert.throws(()=>assertWorktreeAvailable(own.path),/opération Git/);let delivered=false;assert.equal(deferWorktreeInput(own.path,()=>{delivered=true;}),true);
 await assert.rejects(f.manager.start(own.id,'merge',p.token),/déjà utilisée/);
 const result=await f.untilFinished(operation);assert.equal(result.status,'failed');assert.match(result.output,/refused/);assert.equal(delivered,true);assert.doesNotThrow(()=>assertWorktreeAvailable(own.path));
}));

test('target branch is explicit and never follows an unrelated checkout automatically',async()=>fixture(async f=>{
 f.commit();git(f.repo,'checkout','-b','alternate');let own=await f.view();assert.equal(own.targetBranch,'refs/heads/main');assert.equal(own.targetPath,null);assert.ok(own.mergeBlockers.some(s=>s.includes('ouverte')));
 await f.manager.target(own.id,'refs/heads/alternate');assert.equal((await f.merge()).status,'succeeded');assert.notEqual(git(f.repo,'rev-parse','main'),git(f.repo,'rev-parse','alternate'));
 await f.restart();own=await f.view();assert.equal(own.targetBranch,'refs/heads/alternate');assert.equal(own.integration,'integrated');
}));

test('a removal confirmation becomes invalid as soon as conversation produces a new commit',async()=>fixture(async f=>{
 f.commit();assert.equal((await f.merge()).status,'succeeded');const own=await f.view();const plan=await f.manager.prepare(own.id,'remove');f.commit('continued after confirmation');
 await assert.rejects(f.manager.start(own.id,'remove',plan.token),/changé/);assert.ok(existsSync(own.path));assert.equal((await f.view()).ahead,1);
}));

test('ordinary Git merges outside Cerebro are detected without any historical merged flag',async()=>fixture(async f=>{
 f.commit();git(f.repo,'merge','--ff-only',f.workspace.branch);assert.equal((await f.view()).integration,'integrated');f.commit('another change');assert.equal((await f.view()).integration,'pending');
}));

test('resume after merge keeps the same conversation and cwd (fake CLI, no model)',async()=>fixture(async f=>{
 f.commit();assert.equal((await f.merge()).status,'succeeded');
 const bin=join(root,randomUUID());mkdirSync(bin);const captured=join(bin,'cwd');
 writeFileSync(join(bin,'codex'),`#!/bin/sh\npwd > '${captured}'\nexec /bin/sleep 2\n`,{mode:0o755});
 const previous=process.env.PATH;process.env.PATH=`${bin}:${previous}`;const sessions=new SessionManager(f.db);
 try{const resumed=await sessions.resume(f.id);assert.equal(resumed.id,f.id);assert.equal(readFileSync(captured,'utf8').trim(),f.workspace.path);await sessions.terminate(f.id);}
 finally{process.env.PATH=previous;await sessions.terminate(f.id);await sessions.shutdown();}
}));

test('legacy session workspace records are backfilled before deletion and retain final labels',async()=>fixture(async f=>{
 f.db.connection.prepare('DELETE FROM worktree_inventory').run();
 const old=workspaceFor(f.db,f.id);delete old.projectId;delete old.projectName;delete old.projectRoot;delete old.targetBranch;
 f.db.connection.prepare('UPDATE session_workspaces SET data=? WHERE session_id=?').run(JSON.stringify(old),f.id);
 f.db.updateSession(f.id,{title:'Renamed conversation'});f.db.updateProject(f.project.id,{name:'Renamed project'});
 await new SessionManager(f.db).deleteProject(f.project.id);await f.restart();
 const own=(await f.manager.list()).worktrees.find(w=>w.sessionId===f.id);assert.ok(own);assert.equal(own.projectName,'Renamed project');assert.equal(own.sessionTitle,'Renamed conversation');assert.equal(own.session,null);
}));

test('unfinished operation results are restored as interrupted without replaying Git',async()=>fixture(async f=>{
 f.commit();const own=await f.view();const target=git(f.repo,'rev-parse','HEAD');
 const operation={id:randomUUID(),worktreeId:own.id,kind:'merge',status:'running',targetBranch:own.targetBranch,sourceHead:own.head,targetHead:target,resultHead:null,output:'',error:null,startedAt:Date.now(),finishedAt:null};
 f.db.connection.prepare('INSERT INTO worktree_operations VALUES (?,?)').run(operation.id,JSON.stringify(operation));await f.restart();
 const restored=await f.view();assert.equal(restored.operation.status,'interrupted');assert.equal(git(f.repo,'rev-parse','HEAD'),target);assert.equal(restored.ahead,1);
}));

test('unavailable registered worktrees remain visible when their conversation is deleted',async()=>fixture(async f=>{
 const moved=f.workspace.root+'-temporarily-moved';renameSync(f.workspace.root,moved);
 try {
  await new SessionManager(f.db).delete(f.id);
  const own=(await f.manager.list()).worktrees.find(w=>w.sessionId===f.id);
  assert.ok(own);assert.equal(own.session,null);assert.ok(own.error);assert.equal(own.integration,'unknown');assert.ok(own.removeBlockers.length);
 } finally {renameSync(moved,f.workspace.root);}
}));

test('symlink aliases cannot bypass activity checks or the worktree lease',async()=>fixture(async f=>{
 const alias=join(root,randomUUID()+'-alias');symlinkSync(f.workspace.root,alias,'dir');
 const release=lockWorktrees([f.workspace.root]);
 try {assert.throws(()=>assertWorktreeAvailable(alias),/opération Git/);} finally {release();}
 const workspace=workspaceFor(f.db,f.id);workspace.path=alias;
 f.db.connection.prepare('UPDATE session_workspaces SET data=? WHERE session_id=?').run(JSON.stringify(workspace),f.id);
 f.db.updateSession(f.id,{status:'running'});f.commit();
 const own=await f.view();assert.ok(own.mergeBlockers.some(reason=>reason.includes('Session')));
 assert.equal((await f.manager.list()).worktrees.filter(w=>w.sessionId===f.id).length,1);
}));

test('inherited dirty files and ignored dependencies are not presented as new conversation work',async()=>fixture(async f=>{
 let own=await f.view();assert.equal(own.dirty,1);assert.deepEqual(own.changesSinceCreation,{count:0,files:[],inheritedCount:1,needsReviewCount:0});
 writeFileSync(join(f.workspace.root,'ignored'),'dependencies');
 own=await f.view();assert.equal(own.ignored,1);assert.equal(own.changesSinceCreation.count,0);
 writeFileSync(join(f.workspace.root,'file'),'later human or agent edits\n');writeFileSync(join(f.workspace.root,'new'),'new work\n');
 own=await f.view();assert.equal(own.changesSinceCreation.count,2);assert.deepEqual(own.changesSinceCreation.files,['file','new']);assert.equal(own.changesSinceCreation.needsReviewCount,1);
 const index=readFileSync(join(f.repo,'.git/index'));await new SessionManager(f.db).delete(f.id);await f.restart();own=await f.view();assert.equal(own.session,null);assert.equal(own.changesSinceCreation.count,2);assert.equal(own.changesSinceCreation.needsReviewCount,1);assert.deepEqual(readFileSync(join(f.repo,'.git/index')),index);
},true));

test('the principal repository has no integration target or invented conversation baseline',async()=>fixture(async f=>{
 writeFileSync(join(f.repo,'file'),'project work\n');
 const main=(await f.manager.list()).worktrees.find(view=>view.primary);assert.equal(main.changesSinceCreation,null);assert.equal(main.integration,'unknown');assert.equal(main.ahead,null);
 const external=join(root,randomUUID());git(f.repo,'worktree','add','-b','without-metadata',external);
 const view=(await f.manager.list()).worktrees.find(view=>view.path===external);assert.equal(view.managed,false);assert.equal(view.changesSinceCreation,null);assert.equal(view.session,null);
}));
