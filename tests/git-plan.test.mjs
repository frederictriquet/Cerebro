import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareCommit, executeCommitPlan } from '../server/git-plan.ts';
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
test('a staged new file edited again in the worktree commits its worktree content',async()=>fixture(async repo=>{
  git(repo,'mv','other','moved');writeFileSync(join(repo,'moved'),'edited\n');
  const s=await prepareCommit(repo);
  const r=await executeCommitPlan(repo,plan(s,[{message:'move',selection:[one('moved'),one('other')]}]));
  assert.equal(r.error,null,JSON.stringify(r));
  assert.equal(git(repo,'show','HEAD:moved'),'edited');assert.equal(git(repo,'show',':moved'),'edited');
  assert.equal(git(repo,'status','--porcelain'),'');
}));
