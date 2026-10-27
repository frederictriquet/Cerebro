import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root=mkdtempSync(join(tmpdir(),'cerebro-worktree-tests-'));
process.env.CEREBRO_DATA_DIR=join(root,'data');process.env.HOME=root;
const {CerebroDatabase}=await import('../server/db.ts');
const {createWorkspace,joinWorkspace,sessionProvenance,workspaceFor}=await import('../server/provenance.ts');
const {WorktreeManager,rememberWorktree}=await import('../server/worktrees.ts');
const {SessionManager}=await import('../server/sessions.ts');
const {assertWorktreeAvailable,deferWorktreeInput,lockWorktrees}=await import('../server/worktree-gate.ts');
const git=(path,...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
after(()=>rmSync(root,{recursive:true,force:true}));
async function fixture(run,initialDirty=false){
 const directory=mkdtempSync(join(root,'case-'));const repo=join(directory,'source');mkdirSync(repo);
 git(repo,'init','-b','main');git(repo,'config','user.email','test@example.com');git(repo,'config','user.name','Test');
 writeFileSync(join(repo,'file'),'base\n');writeFileSync(join(repo,'.gitignore'),'ignored\nnode_modules/\n');git(repo,'add','.');git(repo,'commit','-m','base');
 mkdirSync(join(repo,'node_modules','dependency'),{recursive:true});writeFileSync(join(repo,'node_modules','dependency','index.js'),'module.exports = true;\n');
 if(initialDirty===true||initialDirty==='untracked-too')writeFileSync(join(repo,'file'),'changes already in project\n');
 if(initialDirty==='untracked-too')writeFileSync(join(repo,'extra'),'untracked in project\n');
 if(typeof initialDirty==='function')initialDirty(repo);
 let db=new CerebroDatabase(join(directory,'db.sqlite'));const project=db.createProject('Project',repo);const id=randomUUID();
 db.createSession({id,projectId:project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:'Conversation',status:'exited',agentSessionId:'fake'},'token');
 const workspace=await createWorkspace(db,id,project);let manager=new WorktreeManager(db);
 assert.equal(lstatSync(join(workspace.path,'node_modules')).isSymbolicLink(),true);
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

async function discoverBeforeProvenance(f){
 f.db.connection.prepare('DELETE FROM worktree_inventory').run();
 f.db.connection.prepare('DELETE FROM session_workspaces WHERE session_id=?').run(f.id);
 const inventory=await f.manager.list(f.project.id);
 const discovered=inventory.worktrees.find(view=>view.path===f.workspace.root);
 assert.equal(discovered.managed,false);assert.equal(discovered.session,null);
 f.db.connection.prepare('INSERT INTO session_workspaces VALUES (?,?)').run(f.id,JSON.stringify(f.workspace));
 return discovered;
}

test('workspace registration associates a copy already discovered without its provenance',async()=>fixture(async f=>{
 const discovered=await discoverBeforeProvenance(f);
 writeFileSync(join(f.workspace.root,'new'),'conversation work\n');
 const refs=git(f.repo,'show-ref');const indexPath=git(f.workspace.root,'rev-parse','--git-path','index');
 const index=readFileSync(indexPath);const sourceIndex=readFileSync(join(f.repo,'.git/index'));
 await rememberWorktree(f.db,f.workspace);
 const own=await f.manager.get(discovered.id);
 assert.equal(own.managed,true);assert.equal(own.sessionId,f.id);assert.equal(own.session.title,'Conversation');
 assert.equal(own.sessionTitle,'Conversation');assert.equal(own.createdAt,f.workspace.createdAt);
 assert.equal(own.expectedBranch,`refs/heads/${f.workspace.branch}`);assert.equal(own.targetBranch,'refs/heads/main');
 assert.deepEqual(own.changesSinceCreation,{count:1,files:['new'],inheritedCount:0,needsReviewCount:0});
 assert.equal(readFileSync(join(f.workspace.root,'new'),'utf8'),'conversation work\n');
 assert.equal(git(f.repo,'show-ref'),refs);assert.deepEqual(readFileSync(indexPath),index);
 assert.deepEqual(readFileSync(join(f.repo,'.git/index')),sourceIndex);
 assert.equal((await f.manager.list()).worktrees.filter(view=>view.path===f.workspace.root).length,1);
}));

test('inventory repairs persisted unassociated copies from workspace records after restart',async()=>fixture(async f=>{
 const discovered=await discoverBeforeProvenance(f);
 const external=join(root,randomUUID());git(f.repo,'worktree','add','-b','external',external);
 f.db.updateSession(f.id,{title:'Still here',status:'idle'});
 await f.restart();
 const inventory=await f.manager.list(f.project.id);
 assert.deepEqual(inventory.errors,[]);
 const own=inventory.worktrees.find(view=>view.id===discovered.id);
 assert.equal(own.managed,true);assert.equal(own.session.id,f.id);assert.equal(own.session.title,'Still here');
 assert.equal(inventory.worktrees.filter(view=>view.managed&&!view.primary).length,1);
 assert.equal(inventory.worktrees.find(view=>view.path===external).managed,false);
 assert.equal(inventory.worktrees.find(view=>view.primary).managed,false);
 await f.manager.target(own.id,'refs/heads/external');
 await rememberWorktree(f.db,f.workspace);await f.restart();
 const restored=await f.manager.get(own.id);
 assert.equal(restored.id,own.id);assert.equal(restored.targetBranch,'refs/heads/external');
 assert.equal(restored.createdAt,f.workspace.createdAt);assert.equal(restored.session.id,f.id);
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

test('an integrated orphan can remove its shared dependency link without touching source dependencies',async()=>fixture(async f=>{
 const own=await f.view();f.db.updateSession(f.id,{status:'exited'});await new SessionManager(f.db).delete(f.id);
 assert.equal(f.db.getSession(f.id),null);assert.equal(lstatSync(join(own.path,'node_modules')).isSymbolicLink(),true);
 const plan=await f.manager.prepare(own.id,'remove');await f.manager.start(own.id,'remove',plan.token);
 await f.manager.shutdown();assert.equal(existsSync(own.path),false);
 assert.equal(readFileSync(join(f.repo,'node_modules','dependency','index.js'),'utf8'),'module.exports = true;\n');
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

test('an integrated copy is published once its commits reach the target upstream',async()=>fixture(async f=>{
 assert.equal((await f.view()).published,null);
 const remote=join(f.repo,'..','remote.git');git(f.repo,'init','--bare',remote);git(f.repo,'remote','add','origin',remote);git(f.repo,'push','-u','origin','main');
 assert.equal((await f.view()).published,true);
 f.commit();assert.equal((await f.view()).published,null);assert.equal((await f.merge()).status,'succeeded');assert.equal((await f.view()).published,false);
 git(f.repo,'push','origin','main');assert.equal((await f.view()).published,true);
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
test('an epic copy shared by several steps stays one entry and its removal reaches every step',async()=>fixture(async f=>{
 const step=randomUUID();f.db.createSession({id:step,projectId:f.project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:'Next step',status:'exited',agentSessionId:'fake'},'token');
 await joinWorkspace(f.db,step,f.workspace);f.commit();
 const copies=(await f.manager.list(f.project.id)).worktrees.filter(w=>w.managed&&!w.primary);assert.equal(copies.length,1);assert.equal(copies[0].sessionId,f.id);
 assert.equal((await f.merge()).status,'succeeded');const own=await f.view();
 const plan=await f.manager.prepare(own.id,'remove');await f.manager.start(own.id,'remove',plan.token);await f.manager.shutdown();assert.equal(existsSync(own.path),false);
 assert.ok(workspaceFor(f.db,f.id).removedAt);assert.ok(workspaceFor(f.db,step).removedAt);
 await assert.rejects(new SessionManager(f.db).resume(step),/supprimé/);
}));
test('discarding the inherited content restores only files untouched since the copy, then integration proceeds',async()=>fixture(async f=>{
 writeFileSync(join(f.workspace.root,'work'),'step work\n');git(f.workspace.root,'add','work');git(f.workspace.root,'commit','-m','step work');
 writeFileSync(join(f.workspace.root,'new'),'later edit\n');
 let own=await f.view();assert.equal(own.changesSinceCreation.inheritedCount,2);assert.ok(own.mergeBlockers.some(reason=>/modifié/.test(reason)));
 const result=await f.manager.discardInherited(own.id);assert.deepEqual(result.restored.sort(),['extra','file']);
 assert.equal(readFileSync(join(f.workspace.root,'file'),'utf8'),'base\n');assert.equal(existsSync(join(f.workspace.root,'extra')),false);
 assert.equal(readFileSync(join(f.workspace.root,'new'),'utf8'),'later edit\n');assert.equal(readFileSync(join(f.repo,'extra'),'utf8'),'untracked in project\n');
 await assert.rejects(f.manager.discardInherited(own.id),/Aucun fichier/);
 rmSync(join(f.workspace.root,'new'));own=await f.view();assert.equal(own.dirty,0);assert.equal(own.ahead,1);
 git(f.repo,'stash','--include-untracked');assert.equal((await f.merge()).status,'succeeded');assert.equal(readFileSync(join(f.repo,'work'),'utf8'),'step work\n');
},'untracked-too'));

// Automatic cleanup at the end of a conversation. The server wires SessionManager.onSessionReleased to releaseSession.
function wire(f){
 const sessions=new SessionManager(f.db);const released=[];
 sessions.onSessionReleased=(id,root)=>released.push(f.manager.releaseSession(id,root));
 return {sessions,settled:()=>Promise.all(released)};
}
const record=(f,id)=>f.db.connection.prepare('SELECT data FROM worktree_inventory').all().map(row=>JSON.parse(row.data)).find(r=>r.id===id);
const automaticRemovals=f=>f.db.connection.prepare('SELECT data FROM worktree_operations').all().map(row=>JSON.parse(row.data)).filter(op=>op.automatic&&op.kind==='remove');

test('a question-only conversation is cleaned automatically once its process stops; history, branch and dependencies remain',async()=>fixture(async f=>{
 const own=await f.view();const branch=git(f.repo,'rev-parse',f.workspace.branch);
 f.db.updateSession(f.id,{status:'running'});const {sessions,settled}=wire(f);
 sessions.finishSession(f.id,0);await settled();
 assert.equal(existsSync(own.path),false);assert.equal(git(f.repo,'rev-parse',f.workspace.branch),branch);
 assert.equal(readFileSync(join(f.repo,'node_modules','dependency','index.js'),'utf8'),'module.exports = true;\n');
 const workspace=workspaceFor(f.db,f.id);assert.ok(workspace.removedAt);assert.equal(workspace.removedAutomatically,true);
 const session=f.db.getSession(f.id);assert.equal(session.title,'Conversation');assert.equal(session.worktree.removed,true);assert.equal(session.worktree.removedAutomatically,true);
 assert.equal(record(f,own.id).autoCleanup.status,'removed');assert.equal(automaticRemovals(f).length,1);
 const inventory=await f.manager.list(f.project.id);assert.ok(!inventory.worktrees.some(w=>w.id===own.id));
 assert.deepEqual(inventory.cleaned.map(c=>[c.id,c.session.id,c.branch]),[[own.id,f.id,`refs/heads/${f.workspace.branch}`]]);
 await assert.rejects(sessions.resume(f.id),/nettoyée automatiquement.*ne peut plus être reprise/s);
}));

test('deleting an unused conversation cleans its copy automatically, but an idle conversation keeps it',async()=>fixture(async f=>{
 const own=await f.view();f.db.updateSession(f.id,{status:'idle'});
 await f.manager.releaseSession(f.id,f.workspace.root);await f.manager.resumeAutomaticCleanup();
 assert.ok(existsSync(own.path));assert.equal(record(f,own.id).autoCleanup,undefined);
 const {sessions,settled}=wire(f);await sessions.delete(f.id);await settled();
 assert.equal(existsSync(own.path),false);assert.equal(f.db.getSession(f.id),null);
 const cleaned=(await f.manager.list()).cleaned.find(c=>c.id===own.id);assert.equal(cleaned.session,null);assert.equal(cleaned.sessionTitle,'Conversation');
}));

test('deleting cleanup history preserves branches, conversations and provenance across restart',async()=>fixture(async f=>{
 const own=await f.view();
 await f.manager.releaseSession(f.id,f.workspace.root);
 const refs=git(f.repo,'show-ref');const session=f.db.getSession(f.id);const workspace=workspaceFor(f.db,f.id);
 f.manager.deleteHistory([own.id]);f.manager.deleteHistory([own.id]);
 assert.equal((await f.manager.list(f.project.id)).cleaned.length,0);
 await f.restart();await f.manager.resumeAutomaticCleanup();
 assert.equal((await f.manager.list()).cleaned.length,0);
 assert.equal(git(f.repo,'show-ref'),refs);
 assert.deepEqual(f.db.getSession(f.id),session);assert.deepEqual(workspaceFor(f.db,f.id),workspace);
 assert.ok(record(f,own.id).historyDeletedAt);assert.equal(automaticRemovals(f).length,1);
}));

test('history deletion validates the whole batch and cannot remove live copies',async()=>fixture(async f=>{
 const own=await f.view();
 for(const ids of [undefined,[],[null],'all'])assert.throws(()=>f.manager.deleteHistory(ids),/Liste/);
 assert.throws(()=>f.manager.deleteHistory([own.id]),/déjà nettoyées/);
 assert.ok(existsSync(own.path));
 await f.manager.releaseSession(f.id,f.workspace.root);
 const secondId=randomUUID();f.db.createSession({id:secondId,projectId:f.project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:'Second',status:'exited',agentSessionId:'fake'},'token');
 const second=await createWorkspace(f.db,secondId,f.project);
 await f.manager.releaseSession(secondId,second.root);
 const inventory=await f.manager.list();const primary=inventory.worktrees.find(w=>w.primary);
 assert.equal(inventory.cleaned.length,2);
 for(const invalid of [primary.id,'unknown']){
  assert.throws(()=>f.manager.deleteHistory([own.id,invalid]));
  assert.equal((await f.manager.list()).cleaned.length,2);assert.equal(record(f,own.id).historyDeletedAt,undefined);
 }
 f.manager.deleteHistory(inventory.cleaned.map(c=>c.id));
 assert.equal((await f.manager.list()).cleaned.length,0);
 assert.ok(existsSync(f.repo));assert.ok(f.db.getSession(secondId));
 assert.ok(git(f.repo,'rev-parse','--verify',second.branch));
}));

test('inherited changes are never cleaned automatically, even with no change since creation',async()=>fixture(async f=>{
 const own=await f.view();assert.equal(own.changesSinceCreation.count,0);
 await f.manager.releaseSession(f.id,f.workspace.root);
 assert.equal(readFileSync(join(own.path,'file'),'utf8'),'changes already in project\n');
 const decision=record(f,own.id).autoCleanup;assert.equal(decision.status,'kept');assert.ok(decision.reasons.some(r=>/modifié/.test(r)));
 assert.equal((await f.view()).autoCleanup.status,'kept');
},true));

test('local edits, unintegrated commits, ignored files and concurrent uses block the automatic cleanup',async()=>fixture(async f=>{
 const own=await f.view();
 const kept=async pattern=>{await f.manager.releaseSession(f.id,f.workspace.root);assert.ok(existsSync(own.path));const decision=record(f,own.id).autoCleanup;assert.equal(decision.status,'kept');assert.ok(decision.reasons.some(r=>pattern.test(r)),JSON.stringify(decision));};
 writeFileSync(join(own.path,'new'),'answer notes\n');await kept(/modifié/);rmSync(join(own.path,'new'));
 const head=f.commit();await kept(/commits restent/);git(own.path,'reset','--hard','HEAD~1');
 writeFileSync(join(own.path,'ignored'),'local config\n');await kept(/ignoré/);rmSync(join(own.path,'ignored'));
 const run={id:'command',cwd:own.path,status:'running'};f.db.connection.prepare('INSERT INTO command_runs VALUES (?,?,?)').run(run.id,'task',JSON.stringify(run));await kept(/commande/);f.db.connection.prepare('DELETE FROM command_runs').run();
 const epic={id:'epic-run',projectId:f.project.id,status:'running',contextRoot:f.repo};f.db.connection.prepare('INSERT INTO epic_runs VALUES (?,?,?)').run(epic.id,f.db.createEpic(f.project.id,'Epic','',null).id,JSON.stringify(epic));await kept(/epic/);f.db.connection.prepare('DELETE FROM epic_runs').run();
 const step=randomUUID();f.db.createSession({id:step,projectId:f.project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:'Next step',status:'idle',agentSessionId:'fake'},'token');
 await joinWorkspace(f.db,step,f.workspace);await kept(/Session Next step/);f.db.updateSession(step,{status:'exited'});
 const release=lockWorktrees([own.path]);try{await kept(/opération Git/);}finally{release();}
 git(own.path,'worktree','lock',own.path);await kept(/verrouillé/);git(own.path,'worktree','unlock',own.path);
 git(own.path,'checkout','-q','--detach');await kept(/Branche du worktree/);git(own.path,'checkout','-q',f.workspace.branch);
 assert.equal(git(own.path,'rev-parse','HEAD'),git(f.repo,'rev-parse','HEAD'));assert.notEqual(head,git(own.path,'rev-parse','HEAD'));
 // Once nothing remains to keep, the shared copy is released through the step that joined it too.
 await f.manager.releaseSession(step,workspaceFor(f.db,step).root);assert.equal(existsSync(own.path),false);assert.ok(workspaceFor(f.db,step).removedAutomatically);
}));

test('cleanup resumes after a restart and repeated or concurrent triggers remove a copy only once',async()=>fixture(async f=>{
 const own=await f.view();const external=join(root,randomUUID());git(f.repo,'worktree','add','-b','external-copy',external);
 await f.restart();
 await Promise.all([f.manager.resumeAutomaticCleanup(),f.manager.releaseSession(f.id,f.workspace.root),f.manager.releaseSession(f.id,f.workspace.root),f.manager.resumeAutomaticCleanup()]);
 assert.equal(existsSync(own.path),false);assert.ok(existsSync(external));assert.ok(existsSync(f.repo));
 await f.restart();await f.manager.resumeAutomaticCleanup();await f.manager.releaseSession(f.id,f.workspace.root);
 assert.equal(automaticRemovals(f).length,1);assert.equal(automaticRemovals(f)[0].status,'succeeded');assert.equal(record(f,own.id).autoCleanup.status,'removed');
 const inventory=await f.manager.list();assert.equal(inventory.cleaned.filter(c=>c.id===own.id).length,1);
 assert.equal(inventory.worktrees.find(w=>w.path===external).managed,false);
}));

test('a manual removal confirmed before an automatic cleanup cannot run twice',async()=>fixture(async f=>{
 const own=await f.view();const plan=await f.manager.prepare(own.id,'remove');
 await f.manager.releaseSession(f.id,f.workspace.root);assert.equal(existsSync(own.path),false);
 await assert.rejects(f.manager.start(own.id,'remove',plan.token),/introuvable/);
 assert.equal(git(f.repo,'rev-parse','--verify',f.workspace.branch).length>0,true);
}));
test('ignored copies identical to the project, links into it and regenerable directories do not block removal, other ignored files do',async()=>fixture(async f=>{
 f.commit();assert.equal((await f.merge()).status,'succeeded');f.db.updateSession(f.id,{status:'exited'});
 writeFileSync(join(f.repo,'.git','info','exclude'),'.claude/\nlinked\ndist\n');
 for(const root of [f.repo,f.workspace.root]){mkdirSync(join(root,'.claude'),{recursive:true});writeFileSync(join(root,'.claude','settings.local.json'),'{"permissions":{}}\n');}
 mkdirSync(join(f.repo,'linked'));writeFileSync(join(f.repo,'linked','data'),'kept\n');symlinkSync(join(f.repo,'linked'),join(f.workspace.root,'linked'),'dir');
 writeFileSync(join(f.repo,'ignored'),'project value\n');writeFileSync(join(f.workspace.root,'ignored'),'local value\n');
 mkdirSync(join(f.workspace.root,'dist','assets'),{recursive:true});writeFileSync(join(f.workspace.root,'dist','assets','index.js'),'built in the copy\n');
 let own=await f.view();assert.equal(own.ignored,1);assert.deepEqual(own.ignoredFiles,['ignored']);await assert.rejects(f.manager.prepare(own.id,'remove'),/ignoré/);
 writeFileSync(join(f.workspace.root,'ignored'),'project value\n');own=await f.view();assert.equal(own.ignored,0);assert.deepEqual(own.disposableIgnored.sort(),['.claude/','dist/','ignored','linked']);
 const plan=await f.manager.prepare(own.id,'remove');await f.manager.start(own.id,'remove',plan.token);await f.manager.shutdown();
 assert.equal(existsSync(f.workspace.root),false);assert.equal(readFileSync(join(f.repo,'linked','data'),'utf8'),'kept\n');assert.equal(readFileSync(join(f.repo,'.claude','settings.local.json'),'utf8'),'{"permissions":{}}\n');
}));

// A twelve-line document: the project edits line 2 before the copy, the conversation edits a line of its choice.
const LINES=Array.from({length:12},(_,i)=>`line ${i+1}`);
const document=(edits={})=>LINES.map((line,i)=>edits[i+1]??line).join('\n')+'\n';
const projectWithEditedDocument=extra=>repo=>{
 writeFileSync(join(repo,'doc'),document());git(repo,'add','doc');git(repo,'commit','-m','doc');
 writeFileSync(join(repo,'doc'),document({2:'project edit'}));
 if(extra)writeFileSync(join(repo,'extra'),'untracked in project\n');
};
test('removing the starting content keeps only the work done since the copy, found in the snapshot taken at creation',async()=>fixture(async f=>{
 const copy=f.workspace.root;
 assert.ok(f.workspace.startingSnapshot);assert.equal(git(f.repo,'rev-parse',`refs/cerebro/starting/${f.id}`),f.workspace.startingSnapshot);
 writeFileSync(join(copy,'doc'),document({2:'project edit',9:'conversation'}));
 // The project folder moves on: the copied content now only exists in the snapshot.
 writeFileSync(join(f.repo,'doc'),document({2:'other project edit'}));rmSync(join(f.repo,'extra'));
 let own=await f.view();
 assert.deepEqual(own.startingContent.map(file=>[file.path,file.state,file.origin?.kind,file.separable]),[['doc','mixed','snapshot',true],['extra','inherited','snapshot',false]]);
 const plan=await f.manager.startingContentPlan(own.id);
 assert.equal(plan.targetUpdate,null);
 assert.deepEqual(plan.steps.map(step=>[step.path,step.action]),[['doc','separate'],['extra','restore']]);
 assert.match(plan.steps[0].diff,/^\+conversation$/m);assert.doesNotMatch(plan.steps[0].diff,/project edit/);
 const result=await f.manager.discardInherited(own.id);
 assert.deepEqual(result.separated,['doc']);assert.deepEqual(result.restored,['extra']);
 assert.equal(readFileSync(join(copy,'doc'),'utf8'),document({9:'conversation'}));assert.equal(existsSync(join(copy,'extra')),false);
 own=await f.view();assert.deepEqual(own.changesSinceCreation,{count:1,files:['doc'],inheritedCount:0,needsReviewCount:0});assert.deepEqual(own.startingContent,[]);
 // The conversation's change is now attributed to the copy and can be committed automatically.
 assert.equal((await sessionProvenance(f.db,f.id)).changes.find(change=>change.path==='doc').certainty,'workspace');
},projectWithEditedDocument(true)));
test('when the target received the starting content, the copy is first updated with it, then keeps only its own work',async()=>fixture(async f=>{
 const copy=f.workspace.root;
 writeFileSync(join(copy,'doc'),document({2:'project edit',3:'conversation'}));
 git(f.repo,'commit','-am','project edit');writeFileSync(join(f.repo,'doc'),document({2:'project edit',6:'target later'}));git(f.repo,'commit','-am','target later');
 let own=await f.view();
 assert.equal(own.startingContent[0].origin.kind,'target-commit');assert.equal(own.startingContent[0].origin.subject,'project edit');assert.equal(own.behind,2);
 const plan=await f.manager.startingContentPlan(own.id);
 assert.deepEqual(plan.targetUpdate,{branch:'refs/heads/main',commits:2});assert.equal(plan.steps[0].action,'separate');
 const before=git(copy,'rev-parse','HEAD');
 const result=await f.manager.discardInherited(own.id);assert.deepEqual(result.separated,['doc']);assert.ok(result.targetUpdate);
 // Line 3 sits next to the copied edit: only a separation onto the updated version keeps it without conflict.
 assert.equal(readFileSync(join(copy,'doc'),'utf8'),document({2:'project edit',3:'conversation',6:'target later'}));
 assert.equal(git(copy,'rev-list','--parents','-n','1','HEAD').split(' ').length,3);assert.equal(git(copy,'rev-parse','HEAD^1'),before);
 assert.deepEqual(git(copy,'diff','--name-only','HEAD').split('\n'),['doc']);
 const provenance=await sessionProvenance(f.db,f.id);
 assert.doesNotMatch(provenance.warning,/incertaine/);assert.equal(provenance.changes.find(change=>change.path==='doc').certainty,'workspace');
 git(copy,'commit','-qam','conversation');
 own=await f.view();assert.equal(own.behind,0);assert.equal((await f.merge()).status,'succeeded');
 assert.equal(readFileSync(join(f.repo,'doc'),'utf8'),document({2:'project edit',3:'conversation',6:'target later'}));
},projectWithEditedDocument()));
test('a file whose recent changes overlap the starting content is left for a manual review',async()=>fixture(async f=>{
 writeFileSync(join(f.workspace.root,'doc'),document({2:'conversation over the project edit'}));
 const own=await f.view();
 // The inventory announces the same outcome as the action, before it is attempted.
 assert.deepEqual(own.startingContent.map(file=>[file.path,file.origin?.kind,file.separable]),[['doc','target-worktree',false]]);
 const plan=await f.manager.startingContentPlan(own.id);
 assert.equal(plan.steps[0].action,'keep');assert.match(plan.steps[0].reason,/mêmes lignes/);
 await assert.rejects(f.manager.discardInherited(own.id),/Aucun contenu de départ ne peut être retiré automatiquement/);
 assert.equal(readFileSync(join(f.workspace.root,'doc'),'utf8'),document({2:'conversation over the project edit'}));
},projectWithEditedDocument()));
test('a file whose starting content was already taken out is settled unchanged as the conversation’s work',async()=>fixture(async f=>{
 const copy=f.workspace.root;
 // The conversation (or a resolution session) rewrote the file without the project's edit of line 2.
 writeFileSync(join(copy,'doc'),document({3:'conversation'}));
 let own=await f.view();
 assert.deepEqual(own.startingContent.map(file=>[file.path,file.state,file.separable]),[['doc','settled',false]]);
 const plan=await f.manager.startingContentPlan(own.id);
 assert.deepEqual(plan.steps.map(step=>[step.path,step.state,step.action]),[['doc','settled','settle']]);
 assert.match(plan.steps[0].diff,/^\+conversation$/m);
 const result=await f.manager.discardInherited(own.id);
 assert.deepEqual(result.settled,['doc']);assert.deepEqual(result.kept,[]);
 assert.equal(readFileSync(join(copy,'doc'),'utf8'),document({3:'conversation'}));
 own=await f.view();assert.deepEqual(own.startingContent,[]);assert.equal(own.changesSinceCreation.needsReviewCount,0);
 assert.equal((await sessionProvenance(f.db,f.id)).changes.find(change=>change.path==='doc').certainty,'workspace');
},projectWithEditedDocument()));
test('a kept file is settled once checked, only with the content it was checked with',async()=>fixture(async f=>{
 const copy=f.workspace.root;
 writeFileSync(join(copy,'doc'),document({2:'conversation over the project edit'}));
 let own=await f.view();
 const plan=await f.manager.startingContentPlan(own.id);
 assert.equal(plan.steps[0].action,'keep');assert.match(plan.steps[0].diff,/^\+conversation over the project edit$/m);
 const confirmed=[{path:'doc',version:plan.steps[0].version}];
 writeFileSync(join(copy,'doc'),document({2:'conversation, edited again'}));
 await assert.rejects(f.manager.discardInherited(own.id,confirmed),/modifié depuis votre vérification/);
 await assert.rejects(f.manager.discardInherited(own.id,[{path:'doc'}]),/Confirmations invalides/);
 writeFileSync(join(copy,'doc'),document({2:'conversation over the project edit'}));
 const result=await f.manager.discardInherited(own.id,confirmed);
 assert.deepEqual(result.settled,['doc']);
 assert.equal(readFileSync(join(copy,'doc'),'utf8'),document({2:'conversation over the project edit'}));
 own=await f.view();assert.deepEqual(own.startingContent,[]);
},projectWithEditedDocument()));
test('conflicts with the target are forecast, then resolved in the copy by updating it',async()=>fixture(async f=>{
 const copy=f.workspace.root;f.commit('session work');
 writeFileSync(join(f.repo,'file'),'project work\n');git(f.repo,'commit','-am','project work');
 let own;
 for(let i=0;i<200;i++){own=await f.view();if(own.integrationConflicts)break;await new Promise(r=>setTimeout(r,10));}
 assert.deepEqual(own.integrationConflicts,['file']);
 await f.manager.updateFromTarget(own.id);
 own=await f.view();assert.equal(own.mergeInProgress,true);assert.deepEqual(own.conflicts,['file']);
 await f.manager.abortTargetUpdate(own.id);own=await f.view();assert.equal(own.mergeInProgress,false);assert.equal(own.dirty,0);
 await f.manager.updateFromTarget(own.id);
 await assert.rejects(f.manager.finishTargetUpdate(own.id),/Marqueurs de conflit/);
 writeFileSync(join(copy,'file'),'session and project work\n');
 own=await f.manager.finishTargetUpdate(own.id);assert.equal(own.mergeInProgress,false);assert.equal(own.behind,0);assert.equal(own.dirty,0);
 assert.doesNotMatch((await sessionProvenance(f.db,f.id)).warning,/incertaine/);
 assert.equal((await f.merge()).status,'succeeded');assert.equal(readFileSync(join(f.repo,'file'),'utf8'),'session and project work\n');
}));
test('a copy without conflicts is updated with the target in one merge commit',async()=>fixture(async f=>{
 const copy=f.workspace.root;f.commit('session work');
 writeFileSync(join(f.repo,'other'),'project\n');git(f.repo,'add','other');git(f.repo,'commit','-m','other');
 let own=await f.view();await assert.rejects((async()=>{writeFileSync(join(copy,'pending'),'x');try{await f.manager.updateFromTarget(own.id);}finally{rmSync(join(copy,'pending'));}})(),/non commité/);
 own=await f.manager.updateFromTarget(own.id);assert.equal(own.behind,0);assert.equal(own.ahead,2);assert.equal(readFileSync(join(copy,'other'),'utf8'),'project\n');
 assert.match(git(copy,'reflog','-1','--format=%gs'),/^commit \(merge\): /);
 await assert.rejects(f.manager.updateFromTarget(own.id),/déjà tous les commits/);
}));
