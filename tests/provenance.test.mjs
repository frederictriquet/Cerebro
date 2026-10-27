import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-provenance-'));
process.env.CEREBRO_DATA_DIR=join(root,'data');process.env.HOME=root;
mkdirSync(process.env.CEREBRO_DATA_DIR);
const {CerebroDatabase}=await import('../server/db.ts');
const {createWorkspace,joinWorkspace,sessionProvenance,workspaceAt,workspaceFor}=await import('../server/provenance.ts');
const {SessionGitScopes}=await import('../server/session-git.ts');
const repo=join(root,'repo');mkdirSync(repo);
const git=(path,...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git(repo,'init','-b','main');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.com');
for(const name of ['first','second','shared','initial'])writeFileSync(join(repo,name),'original\n');
writeFileSync(join(repo,'.gitignore'),'ignored\nnode_modules/\n.cache/\n');git(repo,'add','.');git(repo,'commit','-m','base');
writeFileSync(join(repo,'initial'),'preexisting\n');git(repo,'add','initial');
writeFileSync(join(repo,'untracked'),'existing untracked\n');writeFileSync(join(repo,'ignored'),'configuration\n');
mkdirSync(join(repo,'node_modules','dependency'),{recursive:true});writeFileSync(join(repo,'node_modules','dependency','large.bin'),Buffer.alloc(8*1024*1024,7));
mkdirSync(join(repo,'.cache'),{recursive:true});writeFileSync(join(repo,'.cache','generated.bin'),Buffer.alloc(8*1024*1024,8));
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
    assert.equal(lstatSync(join(ws.path,'node_modules')).isSymbolicLink(),true);
    assert.equal(readFileSync(join(ws.path,'node_modules','dependency','large.bin')).length,8*1024*1024);
    assert.deepEqual(ws.sharedIgnored,['node_modules']);
    assert.ok(!Object.keys(ws.baseline).some(name=>name.startsWith('node_modules/')));
    assert.equal(existsSync(join(ws.path,'.cache')),false);
    assert.equal(git(ws.path,'show',':initial'),'preexisting');
    assert.ok(ws.initialDirty.includes('initial'));
  }
  assert.deepEqual(readFileSync(join(repo,'.git/index')),index);
  assert.deepEqual((await sessionProvenance(db,'a')).changes,[]);
  assert.ok(!(await new SessionGitScopes(db).prepare('a')).files.some(file=>file.path==='node_modules'),'shared dependency link stays out of the commit plan');
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
test('a later epic step joins the first copy and inherits its uncommitted work as initial changes',async()=>{
  session('step1');session('step2');const first=await createWorkspace(db,'step1',project);
  writeFileSync(join(first.path,'second'),'step one\n');
  assert.equal(workspaceAt(db,first.path).sessionId,'step1');
  const second=await joinWorkspace(db,'step2',workspaceAt(db,first.path));
  assert.equal(second.path,first.path);assert.equal(second.branch,first.branch);assert.deepEqual(second.sharedIgnored,['node_modules']);
  assert.ok(second.initialDirty.includes('second'));assert.ok(!second.initialDirty.includes('node_modules'));
  assert.equal(workspaceAt(db,first.path).sessionId,'step1','the copy stays owned by the first step');
  writeFileSync(join(first.path,'shared'),'step two\n');
  assert.deepEqual((await sessionProvenance(db,'step2')).changes.map(change=>change.path),['shared']);
  assert.deepEqual((await sessionProvenance(db,'step1')).changes.map(change=>change.path),['second','shared']);
});
test('permissions Git does not track do not block the copy, an executable bit still counts as a change',async()=>{
  const modes=join(root,'modes');mkdirSync(modes);
  git(modes,'init','-b','main');git(modes,'config','user.name','Test');git(modes,'config','user.email','test@example.com');
  for(const name of ['private','shared','script'])writeFileSync(join(modes,name),`${name}\n`);
  chmodSync(join(modes,'script'),0o775);git(modes,'add','.');git(modes,'commit','-m','base');
  // Cloned under another umask than the server's: checkout-index recreates these with the server's permissions.
  chmodSync(join(modes,'private'),0o600);chmodSync(join(modes,'shared'),0o664);chmodSync(join(modes,'script'),0o700);
  const modesProject=db.createProject('Modes',modes);
  db.createSession({id:'modes',projectId:modesProject.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:'modes',status:'exited',agentSessionId:'modes'},'token');
  const workspace=await createWorkspace(db,'modes',modesProject);
  assert.equal(workspace.mode,'isolated');
  assert.equal(lstatSync(join(workspace.path,'script')).mode&0o100,0o100);
  assert.deepEqual((await sessionProvenance(db,'modes')).changes,[]);
  chmodSync(join(workspace.path,'shared'),0o755);
  assert.deepEqual((await sessionProvenance(db,'modes')).changes.map(change=>change.path),['shared']);
});
test('a project registered through a symbolic link runs inside its copy, never beside it or in the source',async()=>{
  const nested=join(repo,'packages','app');mkdirSync(nested,{recursive:true});writeFileSync(join(nested,'index'),'app\n');
  git(repo,'add','packages');git(repo,'commit','-m','nested package');
  const links=join(root,'links');mkdirSync(links);
  symlinkSync(repo,join(links,'link'),'dir');symlinkSync(nested,join(links,'app'),'dir');
  for(const [id,path,inside] of [['via-link',join(links,'link'),''],['via-nested-link',join(links,'app'),join('packages','app')]]){
    const linked=db.createProject(id,path);
    db.createSession({id,projectId:linked.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:id,status:'exited',agentSessionId:id},'token');
    const workspace=await createWorkspace(db,id,linked);
    assert.equal(workspace.mode,'isolated');
    assert.equal(workspace.path,join(workspace.root,inside));
    assert.ok(existsSync(workspace.path),'the session directory exists in the copy');
    assert.ok(!realpathSync(workspace.path).startsWith(`${realpathSync(repo)}/`)&&realpathSync(workspace.path)!==realpathSync(repo),'the session never runs in the source');
    assert.equal(workspaceAt(db,workspace.path).sessionId,id);
  }
});
test('a commit touching a non-ASCII file modified before the session stays uncertain',async()=>{
  const accents=join(root,'accents');mkdirSync(accents);
  git(accents,'init','-b','main');git(accents,'config','user.name','Test');git(accents,'config','user.email','test@example.com');
  writeFileSync(join(accents,'café.txt'),'original\n');git(accents,'add','.');git(accents,'commit','-m','base');
  writeFileSync(join(accents,'café.txt'),'human edit\n');
  const accentsProject=db.createProject('Accents',accents);
  db.createSession({id:'accents',projectId:accentsProject.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:'accents',status:'exited',agentSessionId:'accents'},'token');
  const workspace=await createWorkspace(db,'accents',accentsProject);
  assert.deepEqual(workspace.initialDirty,['café.txt']);
  // core.quotePath is left at its default: a quoted "caf\303\251.txt" would never match initialDirty.
  git(workspace.path,'commit','-am','session commit');
  const [commit]=(await sessionProvenance(db,'accents')).commits;
  assert.equal(commit.title,'session commit');assert.equal(commit.certainty,'uncertain');
});
test('a branch of 300 commits is attributed with a bounded number of Git processes',async()=>{
  const long=join(root,'long');mkdirSync(long);
  git(long,'init','-b','main');git(long,'config','user.name','Test');git(long,'config','user.email','test@example.com');
  writeFileSync(join(long,'dirty.txt'),'original\n');git(long,'add','.');git(long,'commit','-m','base');
  writeFileSync(join(long,'dirty.txt'),'human edit\n');
  const longProject=db.createProject('Long',long);
  db.createSession({id:'long',projectId:longProject.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:'long',status:'exited',agentSessionId:'long'},'token');
  const workspace=await createWorkspace(db,'long',longProject);
  // 300 first-parent commits built in one fast-import run, among them a merge, an empty commit,
  // a commit on a file modified before the session and one on a quoted name.
  const author='committer Test <test@example.com> 1700000000 +0000\n';
  const blob=text=>`data ${Buffer.byteLength(text)}\n${text}\n`;
  let stream=`commit refs/perf/side\nmark :9999\n${author}${blob('side')}from ${workspace.base}\nM 100644 inline side.txt\n${blob('side\n')}`;
  for(let i=1;i<=300;i++){
    const name=i===100?'dirty.txt':i===200?'é t.txt':`f${i}.txt`;
    stream+=`commit refs/perf/tip\nmark :${i}\n${author}${blob(`c${i}`)}from ${i===1?workspace.base:`:${i-1}`}\n`;
    if(i===150)stream+='merge :9999\n';
    else if(i!==250)stream+=`M 100644 inline "${name}"\n${blob(`${i}\n`)}`;
  }
  execFileSync('git',['-C',workspace.root,'fast-import','--quiet'],{input:`${stream}done\n`,stdio:['pipe','ignore','pipe']});
  git(workspace.root,'update-ref','-m','commit: imported',`refs/heads/${workspace.branch}`,git(workspace.root,'rev-parse','refs/perf/tip'));
  git(workspace.root,'read-tree','-u','--reset','HEAD');
  const bin=join(root,'counting-bin');mkdirSync(bin);const log=join(root,'git-calls.log');writeFileSync(log,'');
  const realGit=execFileSync('sh',['-c','command -v git'],{encoding:'utf8'}).trim();
  writeFileSync(join(bin,'git'),`#!/bin/sh\necho x >> '${log}'\nexec '${realGit}' "$@"\n`);chmodSync(join(bin,'git'),0o755);
  const path=process.env.PATH;process.env.PATH=`${bin}:${path}`;
  let provenance;const started=Date.now();
  try{provenance=await sessionProvenance(db,'long');}finally{process.env.PATH=path;}
  const elapsed=Date.now()-started;const calls=readFileSync(log,'utf8').split('\n').filter(Boolean).length;
  assert.equal(provenance.commits.length,300);
  const byTitle=Object.fromEntries(provenance.commits.map(commit=>[commit.title,commit.certainty]));
  assert.equal(byTitle.c1,'workspace');assert.equal(byTitle.c200,'workspace');assert.equal(byTitle.c250,'workspace');
  assert.equal(byTitle.c100,'uncertain');assert.equal(byTitle.c150,'uncertain');
  assert.equal(provenance.commits.filter(commit=>commit.certainty==='uncertain').length,2);
  assert.ok(calls<30,`${calls} processus Git pour 300 commits`);
  assert.ok(elapsed<10_000,`${elapsed} ms pour 300 commits`);
});
test('provenance stays readable during a merge without remaining conflicts; only a session commit plan is refused',async()=>{
  session('merging');const workspace=await createWorkspace(db,'merging',project);const {SessionGitScopes}=await import('../server/session-git.ts');
  git(workspace.root,'checkout','-q','-b','merging-target');writeFileSync(join(workspace.root,'shared'),'target\n');git(workspace.root,'commit','-qm','target','--','shared');
  git(workspace.root,'checkout','-q',workspace.branch);writeFileSync(join(workspace.root,'shared'),'session\n');git(workspace.root,'commit','-qm','session','--','shared');
  assert.throws(()=>git(workspace.root,'merge','--no-ff','--no-commit','merging-target'));
  writeFileSync(join(workspace.root,'shared'),'resolved\n');git(workspace.root,'add','shared');
  const provenance=await sessionProvenance(db,'merging');assert.ok(provenance.changes.some(change=>change.path==='shared'));
  await assert.rejects(new SessionGitScopes(db).prepare('merging'),/Opération Git en cours \(une fusion/);
  assert.ok(existsSync(git(workspace.root,'rev-parse','--path-format=absolute','--git-path','MERGE_HEAD')));
  git(workspace.root,'merge','--abort');
});
