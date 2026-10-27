import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {after,test} from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-session-git-'));process.env.CEREBRO_DATA_DIR=join(root,'data');mkdirSync(process.env.CEREBRO_DATA_DIR);process.env.HOME=root;
const {CerebroDatabase}=await import('../server/db.ts');const {createWorkspace}=await import('../server/provenance.ts');
const {SessionGitScopes}=await import('../server/session-git.ts');
const repo=join(root,'repo');mkdirSync(repo);const git=(p,...a)=>execFileSync('git',['-C',p,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git(repo,'init','-b','main');git(repo,'config','user.email','test@example.com');git(repo,'config','user.name','Test');
writeFileSync(join(repo,'shared'),'original\n');writeFileSync(join(repo,'initial'),'original\n');git(repo,'add','.');git(repo,'commit','-m','base');
writeFileSync(join(repo,'initial'),'preexisting\n');git(repo,'add','initial');
const db=new CerebroDatabase(':memory:');const project=db.createProject('Demo',repo);
for(const id of ['a','b','old'])db.createSession({id,projectId:project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:id,status:'exited',agentSessionId:id},'token');
const scopes=new SessionGitScopes(db);const prepareSessionGit=(_db,id)=>scopes.prepare(id),executeSessionCommit=(id,raw)=>scopes.executeCommit(id,raw),sessionReviewContext=(id,raw)=>scopes.reviewContext(id,raw);
const a=await createWorkspace(db,'a',project);const b=await createWorkspace(db,'b',project);
after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
const plan=(s,path)=>({snapshotId:s.id,commits:[{message:'session',selection:[{path,all:true}]}],acknowledged:[],push:false});
test('stopped concurrent sessions commit only their explicit isolated selection',async()=>{
  writeFileSync(join(a.path,'shared'),'a\n');writeFileSync(join(b.path,'shared'),'b\n');
  const sa=await prepareSessionGit(db,'a'),sb=await prepareSessionGit(db,'b');
  assert.ok(sa.files.find(f=>f.path==='initial').warnings.length);
  const ra=await executeSessionCommit('a',plan(sa,'shared'));const rb=await executeSessionCommit('b',plan(sb,'shared'));
  assert.equal(ra.error,null);assert.equal(rb.error,null);assert.notEqual(ra.commits[0].hash,rb.commits[0].hash);
  assert.equal(git(a.path,'show','HEAD:shared'),'a');assert.equal(git(b.path,'show','HEAD:shared'),'b');
  assert.equal(git(a.path,'show',':initial'),'preexisting');assert.equal(git(repo,'show','HEAD:shared'),'original');
  await assert.rejects(executeSessionCommit('b',plan(sa,'shared')),/Sélection de session/);
});
test('review includes explicit attributed commits, no reconstruction of ownership',async()=>{
  const s=await prepareSessionGit(db,'a');const c=s.provenance.commits[0].hash;
  const r=await sessionReviewContext('a',{snapshotId:s.id,selection:[],commits:[c],acknowledged:[]});
  assert.ok(r.prompt.includes(c));assert.ok(r.prompt.includes('+a'));assert.ok(!r.prompt.includes('+b\n'));
  await assert.rejects(sessionReviewContext('a',{snapshotId:s.id,selection:[],commits:['unrelated'],acknowledged:[]}),/absent/);
});
test('historical sessions require manual confirmation and stale selections are refused',async()=>{
  const s=await prepareSessionGit(db,'old');assert.equal(s.provenance.workspace.mode,'unknown');assert.ok(s.files.every(f=>f.warnings.length));
  await assert.rejects(executeSessionCommit('old',plan(s,'initial')),/incertaine/);
  await assert.rejects(sessionReviewContext('old',{snapshotId:s.id,selection:[{path:'initial',all:true}],commits:[],acknowledged:[]}),/incertaine/);
  const r=await sessionReviewContext('old',{snapshotId:s.id,selection:[{path:'initial',all:true}],commits:[],acknowledged:['initial']});assert.ok(r.prompt.includes('+preexisting'));
  writeFileSync(join(repo,'initial'),'external\n');
  await assert.rejects(sessionReviewContext('old',{snapshotId:s.id,selection:[{path:'initial',all:true}],commits:[],acknowledged:['initial']}),/obsolète/);
});
test('prepared session selections expire and stay private to their store',async()=>{
  let now=0;const store=new SessionGitScopes(db,{ttlMs:1000,now:()=>now});
  writeFileSync(join(a.path,'shared'),'expiring\n');const s=await store.prepare('a');
  await assert.rejects(new SessionGitScopes(db).executeCommit('a',plan(s,'shared')),/expirée/);
  now=1000;await assert.rejects(store.executeCommit('a',plan(s,'shared')),/expirée/);
  await assert.rejects(store.reviewContext('a',{snapshotId:s.id,selection:[{path:'shared',all:true}],commits:[],acknowledged:[]}),/expirée/);
});
