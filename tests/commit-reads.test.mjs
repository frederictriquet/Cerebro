import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,test} from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-commit-reads-'));
process.env.HOME=root;process.env.CEREBRO_DATA_DIR=join(root,'data');process.env.CODEX_HOME=join(root,'codex');
// Every full read of the worktree starts by listing tracked and untracked files: a git wrapper counts those listings.
const bin=join(root,'bin');mkdirSync(bin);const log=join(root,'git.log');
const realGit=execFileSync('sh',['-c','command -v git'],{encoding:'utf8'}).trim();
writeFileSync(join(bin,'git'),`#!/bin/sh\ncase " $* " in *" ls-files "*"--cached --others"*) printf '%s\\n' "$*" >> ${JSON.stringify(log)};; esac\nexec ${JSON.stringify(realGit)} "$@"\n`,{mode:0o755});
process.env.PATH=`${bin}:${process.env.PATH}`;
const {CerebroDatabase}=await import('../server/db.ts');
const {AutomaticCommits}=await import('../server/automatic-commits.ts');
const {prepareSessionGit,executeSessionCommit}=await import('../server/session-git.ts');
const {createWorkspace}=await import('../server/provenance.ts');
const git=(path,...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const reads=()=>readFileSync(log,'utf8').split('\n').filter(Boolean).length;
after(()=>rmSync(root,{recursive:true,force:true}));

test('an automatic commit of an isolated session reads the worktree once per check, not once per caller',async()=>{
 const repo=join(root,'repo');mkdirSync(repo);
 git(repo,'init','-b','main');git(repo,'config','user.email','test@example.com');git(repo,'config','user.name','Test');
 writeFileSync(join(repo,'file'),'base\n');git(repo,'add','.');git(repo,'commit','-m','base');
 const db=new CerebroDatabase(join(root,'db.sqlite'));const project=db.createProject('Project',repo);const manager=new AutomaticCommits(db);
 try{
  const id=randomUUID();db.createSession({id,projectId:project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:'Step',status:'exited',agentSessionId:'fake'},'token');
  const workspace=await createWorkspace(db,id,project);
  writeFileSync(join(workspace.root,'file'),'changed\n');writeFileSync(join(workspace.root,'new'),'new\n');
  manager.propose=async input=>({commits:input.files.map(file=>({message:`change ${file.path}`,paths:[file.path]}))});
  const context={scope:`sessions/${id}`,path:workspace.root,projectId:project.id,sessionId:id,settings:{agent:'codex',model:null,effort:null,strategy:'atomic'},
   prepare:()=>prepareSessionGit(db,id),execute:plan=>executeSessionCommit(id,plan)};
  writeFileSync(log,'');
  const operation=await manager.start(context,randomUUID(),false);
  let result;for(let i=0;i<500&&(result=manager.get(operation.id)).status==='running';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(result.status,'succeeded',result.error);assert.equal(result.commits.length,2);
  // Collection before/after (provenance reuses it), check after drafting, before and after preparing the commits, after each commit.
  assert.equal(reads(),2+1+2+2);
 }finally{await manager.shutdown();db.close();}
});
