import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-provenance-'));
process.env.CEREBRO_DATA_DIR=join(root,'data');process.env.HOME=root;
const {mkdirSync}=await import('node:fs');mkdirSync(process.env.CEREBRO_DATA_DIR);
const {CerebroDatabase}=await import('../server/db.ts');
const {createWorkspace,sessionProvenance,workspaceFor}=await import('../server/provenance.ts');
const repo=join(root,'repo');mkdirSync(repo);
const git=(path,...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git(repo,'init','-b','main');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.com');
for(const name of ['first','second','shared','initial'])writeFileSync(join(repo,name),'original\n');
writeFileSync(join(repo,'.gitignore'),'ignored\n');git(repo,'add','.');git(repo,'commit','-m','base');
writeFileSync(join(repo,'initial'),'preexisting\n');git(repo,'add','initial');
writeFileSync(join(repo,'untracked'),'existing untracked\n');writeFileSync(join(repo,'ignored'),'configuration\n');
let db=new CerebroDatabase(join(root,'test.db'));const project=db.createProject('Demo',repo);
function session(id){return db.createSession({id,projectId:project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:id,status:'exited',agentSessionId:id},'token');}
after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
let a,b;
test('new workspaces preserve initial context and index without changing the project',async()=>{
  session('a');session('b');const index=readFileSync(join(repo,'.git/index'));
  a=await createWorkspace(db,'a',project);b=await createWorkspace(db,'b',project);
  assert.equal(a.mode,'isolated');assert.notEqual(a.path,b.path);
  for(const ws of [a,b]){
    assert.equal(readFileSync(join(ws.path,'initial'),'utf8'),'preexisting\n');
    assert.equal(readFileSync(join(ws.path,'ignored'),'utf8'),'configuration\n');
    assert.equal(git(ws.path,'show',':initial'),'preexisting');
    assert.ok(ws.initialDirty.includes('initial'));
  }
  assert.deepEqual(readFileSync(join(repo,'.git/index')),index);
  assert.deepEqual((await sessionProvenance(db,'a')).changes,[]);
});
test('two sessions edit distinct then shared files, original human edits never enter their scope',async()=>{
  writeFileSync(join(a.path,'first'),'session a\n');writeFileSync(join(b.path,'second'),'session b\n');
  writeFileSync(join(a.path,'shared'),'a\n');writeFileSync(join(b.path,'shared'),'b\n');
  writeFileSync(join(repo,'first'),'human\n');
  let pa=await sessionProvenance(db,'a');const pb=await sessionProvenance(db,'b');
  assert.deepEqual(pa.changes.map(c=>c.path),['first','shared']);assert.deepEqual(pb.changes.map(c=>c.path),['second','shared']);
  assert.equal(readFileSync(join(a.path,'first'),'utf8'),'session a\n');
  writeFileSync(join(a.path,'initial'),'session after initial\n');
  pa=await sessionProvenance(db,'a');assert.equal(pa.changes.find(c=>c.path==='initial').certainty,'uncertain');
  assert.match(pa.warning,/humaine ou externe/);
});
test('commits remain attributable by isolated branch across restart and historical sessions stay unknown',async()=>{
  git(a.path,'add','first');git(a.path,'commit','--only','first','-m','session first');
  const oid=git(a.path,'rev-parse','HEAD');db.close();db=new CerebroDatabase(join(root,'test.db'));
  assert.equal(workspaceFor(db,'a').path,a.path);
  const pa=await sessionProvenance(db,'a');assert.equal(pa.commits[0].hash,oid);assert.equal(pa.commits[0].certainty,'workspace');
  session('historical');const old=await sessionProvenance(db,'historical');assert.equal(old.workspace.mode,'unknown');assert.deepEqual(old.changes,[]);assert.deepEqual(old.commits,[]);
  assert.match(old.workspace.reason,/historique/);
});
test('commits in the source and switching an isolated branch do not invent session attribution',async()=>{
  git(repo,'commit','--only','initial','-m','human source');
  const pa=await sessionProvenance(db,'a');assert.ok(pa.commits.every(c=>c.title!=='human source'));
  git(b.path,'checkout','--detach');const pb=await sessionProvenance(db,'b');
  assert.deepEqual(pb.commits,[]);assert.ok(pb.changes.every(c=>c.certainty==='uncertain'));
});
