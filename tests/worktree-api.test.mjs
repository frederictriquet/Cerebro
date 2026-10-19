import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, mock, test } from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-worktree-api-'));process.env.HOME=root;process.env.CEREBRO_DATA_DIR=join(root,'data');process.env.CODEX_HOME=join(root,'codex');
delete process.env.CEREBRO_BIND_TOKEN;delete process.env.CEREBRO_SLACK_TOKEN;delete process.env.CEREBRO_SLACK_USER;
mkdirSync(process.env.CEREBRO_DATA_DIR);
const {CerebroDatabase}=await import('../server/db.ts');
const {createWorkspace}=await import('../server/provenance.ts');
const {SessionManager}=await import('../server/sessions.ts');
const {PeerSync}=await import('../server/peers.ts');const {UpdateManager}=await import('../server/updates.ts');
const {buildServer}=await import('../server/index.ts');
mock.method(UpdateManager.prototype,'start',()=>{});mock.method(PeerSync.prototype,'sync',async function(){this.markReady();this.markSynced();});
let launches=0;mock.method(SessionManager.prototype,'launch',async()=>{launches++;throw new Error('Unexpected LLM launch');});
const repo=join(root,'repo');mkdirSync(repo);const git=(path,...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git(repo,'init','-b','main');git(repo,'config','user.email','test@example.com');git(repo,'config','user.name','Test');writeFileSync(join(repo,'file'),'base\n');git(repo,'add','.');git(repo,'commit','-m','base');
const db=new CerebroDatabase();const project=db.createProject('API Project',repo);const id=randomUUID();db.createSession({id,projectId:project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:'Original conversation',status:'exited',agentSessionId:'fake'},'token');const workspace=await createWorkspace(db,id,project);db.close();
after(()=>{mock.restoreAll();rmSync(root,{recursive:true,force:true});});
test('API keeps orphaned worktrees, executes explicit commits/merges without agents and validates stale actions',async()=>{
 let app=await buildServer();const send=(method,url,payload)=>app.inject({method,url,...(payload===undefined?{}:{payload})});
 try{
  let inventory=(await send('GET',`/api/projects/${project.id}/worktrees`)).json();let own=inventory.worktrees.find(w=>w.sessionId===id);assert.ok(own);const wid=own.id;
  assert.equal((await send('DELETE',`/api/sessions/${id}`)).statusCode,204);
  writeFileSync(join(workspace.path,'new'),'orphan work\n');
  const prepared=await send('POST',`/api/worktrees/${wid}/git/prepare-commit`);assert.equal(prepared.statusCode,200);
  const result=await send('POST',`/api/worktrees/${wid}/git/commit`,{snapshotId:prepared.json().id,commits:[{message:'orphan commit',selection:[{path:'new',all:true}]}],acknowledged:[],push:false});assert.equal(result.statusCode,200);assert.equal(result.json().error,null);
  assert.equal((await send('PATCH',`/api/worktrees/${wid}/target`,{branch:'refs/heads/missing'})).statusCode,400);
  let plan=(await send('POST',`/api/worktrees/${wid}/prepare-merge`)).json();assert.ok(plan.token);
  writeFileSync(join(repo,'human'),'human\n');git(repo,'add','.');git(repo,'commit','-m','target moved');
  assert.equal((await send('POST',`/api/worktrees/${wid}/merge`,{token:plan.token})).statusCode,409);
  plan=(await send('POST',`/api/worktrees/${wid}/prepare-merge`)).json();assert.equal((await send('POST',`/api/worktrees/${wid}/merge`,{token:plan.token})).statusCode,202);
  for(let i=0;i<100;i++){own=(await send('GET',`/api/worktrees/${wid}`)).json();if(own.operation?.status!=='running')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(own.operation.status,'succeeded',JSON.stringify(own));assert.equal(own.ahead,0);assert.equal(own.session,null);assert.equal(git(repo,'show','HEAD:new'),'orphan work');assert.equal(launches,0);
  await app.close();app=await buildServer();own=(await send('GET','/api/worktrees')).json().worktrees.find(w=>w.id===wid);assert.equal(own.projectName,'API Project');assert.equal(own.session,null);
  assert.equal((await send('DELETE',`/api/projects/${project.id}`)).statusCode,204);
  own=(await send('GET','/api/worktrees')).json().worktrees.find(w=>w.id===wid);assert.ok(own);assert.equal(own.projectExists,false);assert.equal(own.integration,'integrated');assert.equal(launches,0);
 }finally{await app.close();}
});
