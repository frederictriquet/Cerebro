import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fsPromises, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { assertNoGitOperation, prepareCommit, executeCommitPlan } from '../server/git-plan.ts';
const git = (repo,...args) => execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function fixture(run, unborn=false) {
  const root = mkdtempSync(join(tmpdir(),'cerebro-plan-test-'));
  git(root,'init','-b','main'); git(root,'config','user.name','Test'); git(root,'config','user.email','test@example.com');
  writeFileSync(join(root,'file'),Array.from({length:30},(_,i)=>`line ${i}`).join('\n')+'\n');
  writeFileSync(join(root,'other'),'old\n');
  if (!unborn) {git(root,'add','.');git(root,'commit','-m','initial');}
  try { await run(root); } finally {rmSync(root,{recursive:true,force:true});}
}
const plan = (s, commits) => ({snapshotId:s.id, commits, acknowledged:[],push:false});
const one = path => ({path,all:true});
test('collection detects same-size edits with unchanged stat timestamps without changing the real index',async()=>fixture(async repo=>{
  const file=join(repo,'other');const index=join(repo,'.git/index');const timestamp=1_700_000_000;
  git(repo,'config','core.trustctime','false');utimesSync(file,timestamp,timestamp);git(repo,'add','other');utimesSync(index,timestamp,timestamp);
  writeFileSync(file,'new\n');utimesSync(file,timestamp,timestamp);
  const before=readFileSync(index);const s=await prepareCommit(repo);
  assert.ok(s.files.some(candidate=>candidate.path==='other'&&candidate.diff.includes('+new')));
  assert.deepEqual(readFileSync(index),before);assert.equal(readFileSync(file,'utf8'),'new\n');
}));
test('explicit plan commits ordered files, including new ones, preserving unrelated staged content',async()=>fixture(async repo=>{
  writeFileSync(join(repo,'other'),'staged\n');git(repo,'add','other');
  writeFileSync(join(repo,'file'),'changed\n');writeFileSync(join(repo,'new'),'new\n');
  const s=await prepareCommit(repo);
  const r=await executeCommitPlan(repo,plan(s,[{message:'first',selection:[one('file')]},{message:'second',selection:[one('new')]}]));
  assert.equal(r.error,null,JSON.stringify(r));assert.equal(r.commits.length,2);
  assert.equal(git(repo,'show','HEAD:other'),'old'); assert.equal(git(repo,'show',':other'),'staged');
  assert.equal(git(repo,'show',':file'),'changed');assert.equal(git(repo,'show',':new'),'new');
  assert.deepEqual(r.exclusions,['other']);
}));
test('partial hunks across ordered commits preserve preexisting staged hunks in the same file',async()=>fixture(async repo=>{
  const file=join(repo,'file');const original=readFileSync(file,'utf8');
  const staged=original.replace('line 25\n','staged 25\n');writeFileSync(file,staged);git(repo,'add','file');
  writeFileSync(file,staged.replace('line 1\n','selected 1\n').replace('line 12\n','selected 12\n'));
  const s=await prepareCommit(repo);assert.equal(s.files[0].hunks.length,3);
  const h=s.files[0].hunks;
  const r=await executeCommitPlan(repo,plan(s,[{message:'one',selection:[{path:'file',hunks:[h[0].id]}]},{message:'two',selection:[{path:'file',hunks:[h[1].id]}]}]));
  assert.equal(r.error,null,JSON.stringify(r));assert.equal(r.commits.length,2);
  assert.ok(git(repo,'show','HEAD:file').includes('line 25'));assert.ok(git(repo,'show',':file').includes('staged 25'));
  assert.ok(git(repo,'show',':file').includes('selected 1'));
}));
test('stale worktree, index, or HEAD cannot mutate anything',async()=>fixture(async repo=>{
  writeFileSync(join(repo,'file'),'planned\n');
  for(const mutate of [()=>writeFileSync(join(repo,'file'),'concurrent\n'),()=>git(repo,'add','file'),()=>git(repo,'commit','--allow-empty','-m','concurrent')]) {
    const s=await prepareCommit(repo);mutate();const before=git(repo,'rev-parse','HEAD');const index=readFileSync(join(repo,'.git/index'));
    const r=await executeCommitPlan(repo,plan(s,[{message:'planned',selection:[one('file')]}]));
    assert.match(r.error,/obsolète/);assert.equal(git(repo,'rev-parse','HEAD'),before);assert.deepEqual(readFileSync(join(repo,'.git/index')),index);
  }
}));
test('a change during collection is refused with a plain message, without Git debugging details',async()=>fixture(async repo=>{
  // A git wrapper edits the work tree while the per-file diffs are collected, once.
  const bin=mkdtempSync(join(tmpdir(),'cerebro-plan-git-'));const real=execFileSync('sh',['-c','command -v git'],{encoding:'utf8'}).trim();const marker=join(bin,'done');
  writeFileSync(join(bin,'git'),`#!/bin/sh\ncase " $* " in *" --binary "*" -- "*) [ -e '${marker}' ] || { touch '${marker}'; echo concurrent > '${join(repo,'other')}'; } ;; esac\nexec '${real}' "$@"\n`);chmodSync(join(bin,'git'),0o755);
  writeFileSync(join(repo,'file'),'planned\n');const path=process.env.PATH;process.env.PATH=`${bin}:${path}`;
  try { await assert.rejects(prepareCommit(repo),error=>error.message==='Le dépôt a changé pendant la préparation : relancez.'); }
  finally { process.env.PATH=path;rmSync(bin,{recursive:true,force:true}); }
  assert.equal(readFileSync(join(repo,'other'),'utf8'),'concurrent\n');
}));
test('failed hook stops plan and preserves the original index',async()=>fixture(async repo=>{
  writeFileSync(join(repo,'file'),'changed\n');writeFileSync(join(repo,'other'),'staged\n');git(repo,'add','other');
  writeFileSync(join(repo,'.git/hooks/pre-commit'),'#!/bin/sh\necho stop >&2\nexit 1\n',{mode:0o755});
  const s=await prepareCommit(repo);const index=readFileSync(join(repo,'.git/index'));const before=git(repo,'rev-parse','HEAD');
  const r=await executeCommitPlan(repo,plan(s,[{message:'fail',selection:[one('file')]},{message:'never',selection:[one('other')]}]));
  assert.match(r.error,/stop/);assert.equal(r.commits.length,0);assert.equal(git(repo,'rev-parse','HEAD'),before);assert.deepEqual(readFileSync(join(repo,'.git/index')),index);
}));
test('unborn repository and exclusions/scanners are explicit',async()=>fixture(async repo=>{
  writeFileSync(join(repo,'.env'),'TOKEN=value\n');
  const s=await prepareCommit(repo);assert.ok(s.files.find(f=>f.path==='.env').warnings.length);
  const refused=await executeCommitPlan(repo,plan(s,[{message:'bad',selection:[one('.env')]}]));assert.match(refused.error,/explicite/);
  const r=await executeCommitPlan(repo,plan(s,[{message:'initial',selection:[one('file'),one('other')]}]));assert.equal(r.error,null,JSON.stringify(r));assert.deepEqual(r.exclusions,['.env']);
},true));
test('multiple nonadjacent hunks in a single commit and duplicate execution refusal',async()=>fixture(async repo=>{
  const file=join(repo,'file');writeFileSync(file,readFileSync(file,'utf8').replace('line 1\n','selected 1\n').replace('line 25\n','selected 25\n'));
  const s=await prepareCommit(repo);const p=plan(s,[{message:'two hunks',selection:[{path:'file',hunks:s.files[0].hunks.map(h=>h.id)}]}]);
  const r=await executeCommitPlan(repo,p);assert.equal(r.error,null,JSON.stringify(r));
  assert.equal(git(repo,'diff','HEAD'),'');
  await assert.rejects(executeCommitPlan(repo,p),/déjà exécuté/);
}));
test('identical edits in repeated blocks of one file get distinct, separately committable hunks',async()=>fixture(async repo=>{
  const block=['a','b','c','x','d','e','f'];const filler=Array.from({length:10},(_,i)=>`f${i}`);const file=join(repo,'file');
  writeFileSync(file,[...block,...filler,...block].join('\n')+'\n');git(repo,'add','file');git(repo,'commit','-m','blocks');
  writeFileSync(file,readFileSync(file,'utf8').replaceAll('\nx\n','\nY\n'));
  const s=await prepareCommit(repo);const h=s.files[0].hunks;
  assert.equal(h.length,2);assert.notEqual(h[0].id,h[1].id);
  const r=await executeCommitPlan(repo,plan(s,[{message:'second block',selection:[{path:'file',hunks:[h[1].id]}]},{message:'first block',selection:[{path:'file',hunks:[h[0].id]}]}]));
  assert.equal(r.error,null,JSON.stringify(r));assert.deepEqual(r.exclusions,[]);
  assert.equal(git(repo,'show','HEAD~1:file').split('\n').filter(l=>l==='Y').length,1);
  assert.equal(git(repo,'diff','HEAD'),'');
}));
test('diffs larger than a pipe chunk keep multi-byte characters intact and commit the exact file',async()=>fixture(async repo=>{
  const content='a'+'é'.repeat(200_000)+'\n';writeFileSync(join(repo,'big.txt'),content);
  const s=await prepareCommit(repo);const candidate=s.files.find(f=>f.path==='big.txt');
  assert.ok(!candidate.diff.includes('\uFFFD'));
  const r=await executeCommitPlan(repo,plan(s,[{message:'big',selection:[one('big.txt')]}]));assert.equal(r.error,null,JSON.stringify(r));
  assert.equal(execFileSync('git',['-C',repo,'show','HEAD:big.txt'],{encoding:'utf8',maxBuffer:16*1024*1024}),content);
  assert.equal(git(repo,'status','--porcelain','--','big.txt'),'');
}));
test('a merge in progress with resolved conflicts is refused instead of becoming a partial two-parent commit',async()=>fixture(async repo=>{
  git(repo,'checkout','-q','-b','target');writeFileSync(join(repo,'other'),'target\n');git(repo,'commit','-qam','target');
  git(repo,'checkout','-q','main');writeFileSync(join(repo,'other'),'main\n');git(repo,'commit','-qam','main');
  assert.throws(()=>git(repo,'merge','--no-ff','--no-commit','target'));
  writeFileSync(join(repo,'other'),'resolved\n');git(repo,'add','other');writeFileSync(join(repo,'file'),'unrelated\n');
  const before=git(repo,'rev-parse','HEAD');
  // Preparation is also a read-only view (provenance, push status, review): it stays available during the merge.
  const s=await prepareCommit(repo);assert.ok(s.files.some(f=>f.path==='file'));
  await assert.rejects(assertNoGitOperation(repo),/Opération Git en cours \(une fusion/);
  const r=await executeCommitPlan(repo,plan(s,[{message:'partial',selection:[one('file')]}]));
  assert.match(r.error,/Opération Git en cours \(une fusion/);assert.equal(r.blocked,true);assert.deepEqual(r.commits,[]);
  assert.equal(git(repo,'rev-parse','HEAD'),before);assert.equal(git(repo,'rev-parse','MERGE_HEAD'),git(repo,'rev-parse','target'));
}));
test('an operation started after preparation stops execution before git commit reads its state',async()=>fixture(async repo=>{
  writeFileSync(join(repo,'file'),'changed\n');const s=await prepareCommit(repo);const before=git(repo,'rev-parse','HEAD');
  writeFileSync(join(repo,'.git/MERGE_HEAD'),before+'\n');
  const r=await executeCommitPlan(repo,plan(s,[{message:'partial',selection:[one('file')]}]));
  assert.match(r.error,/Opération Git en cours/);assert.deepEqual(r.commits,[]);
  assert.equal(git(repo,'rev-parse','HEAD'),before);assert.ok(existsSync(join(repo,'.git/MERGE_HEAD')));
}));
test('an index.lock held by an external git is a translated, retryable refusal that leaves the lock in place',async()=>fixture(async repo=>{
  writeFileSync(join(repo,'file'),'changed\n');const s=await prepareCommit(repo);const before=git(repo,'rev-parse','HEAD');
  writeFileSync(join(repo,'.git/index.lock'),'');
  const r=await executeCommitPlan(repo,plan(s,[{message:'partial',selection:[one('file')]}]));
  assert.equal(r.error,'Une autre opération Git est en cours (index.lock) : réessayez.');assert.equal(r.blocked,true);assert.deepEqual(r.commits,[]);
  assert.equal(git(repo,'rev-parse','HEAD'),before);assert.ok(existsSync(join(repo,'.git/index.lock')));
}));
test('an index.lock taken by an external git after the first commit of a plan is a partial failure, not a retryable refusal',async()=>fixture(async repo=>{
  writeFileSync(join(repo,'file'),'changed\n');writeFileSync(join(repo,'new'),'new\n');const s=await prepareCommit(repo);const before=git(repo,'rev-parse','HEAD');
  const lock=join(repo,'.git/index.lock');const original=fsPromises.rename;
  // An editor's `git status` takes index.lock right after the merged index is installed, before the lock is reopened.
  fsPromises.rename=async(from,to)=>{await original(from,to);if(to===join(repo,'.git/index'))writeFileSync(lock,'',{flag:'wx'});};syncBuiltinESMExports();
  let r;try{r=await executeCommitPlan(repo,plan(s,[{message:'first',selection:[one('file')]},{message:'second',selection:[one('new')]}]));}
  finally{fsPromises.rename=original;syncBuiltinESMExports();}
  assert.equal(r.commits.length,1);assert.notEqual(r.blocked,true);
  assert.match(r.error,/Plan appliqué partiellement : 1 commit\(s\) sur 2 .*\(index\.lock\)/);assert.doesNotMatch(r.error,/réessayez/);
  assert.equal(git(repo,'rev-parse','HEAD^'),before);assert.equal(git(repo,'log','-1','--format=%s'),'first');assert.ok(existsSync(lock));
}));
test('cherry-pick, revert and rebase states block commits but not preparation, including in a linked worktree',async()=>fixture(async repo=>{
  const linked=join(repo,'..',`${basename(repo)}-linked`);git(repo,'worktree','add','-q','-b','linked',linked);
  try{
    for(const name of ['CHERRY_PICK_HEAD','REVERT_HEAD','REBASE_HEAD','rebase-merge','rebase-apply'])for(const path of [repo,linked]){
      const location=git(path,'rev-parse','--path-format=absolute','--git-path',name);
      writeFileSync(join(path,'file'),`${name}\n`);const s=await prepareCommit(path);
      if(name.startsWith('rebase-'))mkdirSync(location);else writeFileSync(location,git(repo,'rev-parse','HEAD')+'\n');
      await prepareCommit(path);
      await assert.rejects(assertNoGitOperation(path),/Opération Git en cours/,`${name} in ${path}`);
      const r=await executeCommitPlan(path,plan(s,[{message:name,selection:[one('file')]}]));
      assert.match(r.error,/Opération Git en cours/,`${name} in ${path}`);assert.deepEqual(r.commits,[]);
      rmSync(location,{recursive:true,force:true});git(path,'checkout','--','file');
    }
  }finally{rmSync(linked,{recursive:true,force:true});}
}));
test('a bisect in progress neither blocks preparation nor commits',async()=>fixture(async repo=>{
  writeFileSync(join(repo,'file'),'changed\n');git(repo,'bisect','start');
  await assertNoGitOperation(repo);const s=await prepareCommit(repo);
  const r=await executeCommitPlan(repo,plan(s,[{message:'during bisect',selection:[one('file')]}]));assert.equal(r.error,null,JSON.stringify(r));
  assert.equal(git(repo,'log','-1','--format=%s'),'during bisect');
}));
test('secret scanning excludes content before writing any blob; simultaneous execution is refused',async()=>fixture(async repo=>{
  const secret='-----BEGIN PRIVATE KEY-----\nprivate-content\n';writeFileSync(join(repo,'secret'),secret);
  const s=await prepareCommit(repo);assert.equal(s.files.find(f=>f.path==='secret').blocked,true);
  const oid=execFileSync('git',['hash-object','--stdin'],{input:secret,encoding:'utf8'}).trim();
  assert.throws(()=>git(repo,'cat-file','-e',oid));
  const r=await executeCommitPlan(repo,plan(s,[{message:'no',selection:[one('secret')]}]));assert.match(r.error,/Secret/);
  writeFileSync(join(repo,'file'),'new\n');const fresh=await prepareCommit(repo);const p=plan(fresh,[{message:'yes',selection:[one('file')]}]);
  const results=await Promise.allSettled([executeCommitPlan(repo,p),executeCommitPlan(repo,p)]);
  assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.error===null).length,1);
}));
