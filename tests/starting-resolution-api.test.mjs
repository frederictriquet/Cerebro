import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, mock, test } from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-starting-resolution-api-'));process.env.HOME=root;process.env.CEREBRO_DATA_DIR=join(root,'data');process.env.CODEX_HOME=join(root,'codex');
delete process.env.CEREBRO_BIND_TOKEN;delete process.env.CEREBRO_SLACK_TOKEN;delete process.env.CEREBRO_SLACK_USER;
mkdirSync(process.env.CEREBRO_DATA_DIR);
const {CerebroDatabase}=await import('../server/db.ts');
const {createWorkspace,createWorkspaceInContext,joinWorkspace,workspaceFor}=await import('../server/provenance.ts');
const {SessionManager}=await import('../server/sessions.ts');
const {PeerSync}=await import('../server/peers.ts');const {UpdateManager}=await import('../server/updates.ts');
const {buildServer}=await import('../server/index.ts');
mock.method(UpdateManager.prototype,'start',()=>{});mock.method(PeerSync.prototype,'sync',async function(){this.markReady();this.markSynced();});
const launches=[];mock.method(SessionManager.prototype,'launch',async(...args)=>{
 launches.push(args);
 const [project,agent,mode,tuning,prompt,,,validate,joined,title,epicId,context]=args;
 const session=db.createSession({id:randomUUID(),projectId:project.id,agent,mode,...tuning,prompt,title:title??'Session de test',status:'idle',agentSessionId:'fake'},'token',epicId);
 const workspace=context?await createWorkspaceInContext(db,session.id,project,context):joined?await joinWorkspace(db,session.id,joined):await createWorkspace(db,session.id,project);
 await validate?.();return {...db.getSession(session.id),cwd:workspace.path};
});
const git=(path,...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const LINES=['un','deux','trois','quatre','cinq','six'];
const document=(edits={})=>LINES.map((line,i)=>edits[i+1]??line).join('\n')+'\n';
const repo=join(root,'repo');mkdirSync(repo);
git(repo,'init','-b','main');git(repo,'config','user.email','test@example.com');git(repo,'config','user.name','Test');
writeFileSync(join(repo,'doc'),document());writeFileSync(join(repo,'other'),'base\n');git(repo,'add','.');git(repo,'commit','-m','base');
// Uncommitted in the project when the copy is created: the starting content.
writeFileSync(join(repo,'doc'),document({2:'project edit'}));writeFileSync(join(repo,'extra'),'untracked in project\n');
const db=new CerebroDatabase();const project=db.createProject('Résolution',repo);
const conversation=db.createSession({id:randomUUID(),projectId:project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'Ajoute la ligne de la conversation',title:'Conversation d’origine',status:'exited',agentSessionId:'fake'},'token');
const workspace=await createWorkspace(db,conversation.id,project);
after(()=>{mock.restoreAll();db.close();rmSync(root,{recursive:true,force:true});});

test('resolution settings are stored per project and validated like the other LLM settings',async()=>{
 const app=await buildServer();const send=(method,url,payload)=>app.inject({method,url,...(payload===undefined?{}:{payload})});
 try{
  const url=`/api/projects/${project.id}`;
  assert.deepEqual((await send('GET','/api/projects')).json().find(item=>item.id===project.id).resolutionSettings,{agent:'claude',mode:'auto',model:null,effort:null});
  for(const invalid of [null,{agent:'unknown'},{mode:'nope'},{model:'unknown-model'},{strategy:'single'}])assert.equal((await send('PATCH',url,{resolutionSettings:invalid})).statusCode,400);
  const response=await send('PATCH',url,{resolutionSettings:{agent:'codex',mode:'acceptEdits'}});assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(response.json().resolutionSettings,{agent:'codex',mode:'acceptEdits',model:null,effort:null});
  assert.equal(response.json().commitSettings.agent,'claude');
  const reopened=new CerebroDatabase();try{assert.deepEqual(reopened.getProject(project.id).resolutionSettings,{agent:'codex',mode:'acceptEdits',model:null,effort:null});}finally{reopened.close();}
 }finally{await app.close();}
});

test('« Résoudre avec l’IA » launches a session in the copy, with the project settings and the files left for review',async()=>{
 const app=await buildServer();const send=(method,url,payload)=>app.inject({method,url,...(payload===undefined?{}:{payload})});
 try{
  const own=(await send('GET',`/api/projects/${project.id}/worktrees`)).json().worktrees.find(w=>w.sessionId===conversation.id);
  // Nothing overlaps yet: the automatic removal handles every file.
  let refused=await send('POST',`/api/worktrees/${own.id}/resolve-starting-content`);
  assert.equal(refused.statusCode,409);assert.match(refused.json().error,/Aucun fichier n’est laissé à examiner/);
  writeFileSync(join(workspace.path,'doc'),document({2:'conversation over the project edit'}));
  // A later preference for the project folder does not move the repair out of the copy.
  db.updateProject(project.id,{workspaceMode:'shared'});
  const response=await send('POST',`/api/worktrees/${own.id}/resolve-starting-content`);assert.equal(response.statusCode,201,response.body);
  const session=response.json();
  assert.equal(workspaceFor(db,session.id).path,workspace.path);
  assert.equal(session.agent,'codex');assert.equal(session.mode,'acceptEdits');assert.match(session.title,/Conversation d’origine/);
  const prompt=launches.at(-1)[4];
  assert.match(prompt,/- doc \(contenu de départ et travail de la conversation mélangés\)/);
  assert.ok(prompt.includes(`Contenu de départ : le fichier ${join(repo,'doc')}, encore non commité dans le dossier de main`));
  assert.match(prompt,/mêmes lignes/);assert.match(prompt,/extra\) seront traités automatiquement/);
  assert.match(prompt,/Ajoute la ligne de la conversation/);assert.match(prompt,/Ne crée aucun commit/);
  // The session's own launch preferences are untouched, and the copy is left as it was.
  assert.equal(db.getProject(project.id).sessionDefaults.agent,'claude');
  assert.equal(readFileSync(join(workspace.path,'doc'),'utf8'),document({2:'conversation over the project edit'}));
  // While a session works in the copy, a second resolution is refused.
  db.updateSession(session.id,{status:'running'});
  refused=await send('POST',`/api/worktrees/${own.id}/resolve-starting-content`);assert.equal(refused.statusCode,409);assert.match(refused.json().error,/running/);
  db.updateSession(session.id,{status:'exited'});
  assert.equal((await send('POST','/api/worktrees/missing/resolve-starting-content')).statusCode,404);
 }finally{await app.close();}
});

test('the prompt tells where each starting content can be read, and leaves the target update to Cerebro',async()=>{
 const {startingResolutionPrompt}=await import('../server/starting-resolution.ts');
 const view={path:'/copie',branch:'refs/heads/cerebro/x',expectedBranch:null,targetBranch:'refs/heads/main',targetPath:'/projet'};
 const step=(path,origin,reason)=>({path,state:'mixed',origin,action:'keep',reason,diff:''});
 const plan={targetUpdate:{branch:'refs/heads/main',commits:2},steps:[
  step('a',{kind:'snapshot'},'r1'),step('b',null,'Contenu de départ introuvable'),step('c',{kind:'target-commit',commit:'0123456789abcdef',subject:'Projet'},'r3'),
 ]};
 const prompt=startingResolutionPrompt(view,{base:'base0',startingSnapshot:'snap0'},plan,null);
 assert.match(prompt,/`git show snap0:a` \(instantané conservé par Cerebro/);
 assert.match(prompt,/b \(contenu[^\n]*\n {2}Contenu de départ : introuvable : ni dans la cible, ni identique dans l’instantané de création \(`git show snap0:b`/);
 assert.match(prompt,/`git show 0123456789abcdef:c` \(commit 0123456 « Projet » de main\)/);
 assert.match(prompt,/main a reçu 2 commits depuis la création : ne les intègre pas/);
 assert.match(prompt,/git log base0\.\.HEAD/);assert.doesNotMatch(prompt,/Conversation d’origine/);assert.doesNotMatch(prompt,/seront traités automatiquement/);
});
