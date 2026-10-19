import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {test,after} from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-findings-'));process.env.CEREBRO_DATA_DIR=root;
const {CerebroDatabase}=await import('../server/db.ts');const {parseReport,saveReport,listReports,importFindings}=await import('../server/findings.ts');
let db=new CerebroDatabase(join(root,'test.db'));const project=db.createProject('Demo',root);db.createSession({id:'source',projectId:project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:'review',status:'exited',agentSessionId:'source'},'token');
const f=(id,dependsOn=[])=>({id,title:`Bug ${id}`,severity:'high',file:'server/file.ts',line:12,problem:'Valeur non vérifiée',scenario:'Entrée vide',expectedFix:'Valider la valeur avant traitement',dependsOn,taskDependencies:[]});
after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
test('partial selection, autonomous tasks, dependencies, epic and source preserved without an agent',()=>{
  const report=saveReport(db,'source',{title:'Review',findings:[f('a'),f('b',['a']),f('c')]});
  assert.throws(()=>importFindings(db,'source',report.id,['b']),/prérequis/);
  let result=importFindings(db,'source',report.id,['a']);assert.equal(result.tasks.length,1);assert.equal(result.tasks[0].sourceSessionId,'source');assert.match(result.tasks[0].text,/server\/file.ts:12/);
  const epic=result.epic.id;result=importFindings(db,'source',report.id,['b']);assert.equal(result.epic.id,epic);assert.deepEqual(result.tasks[0].dependsOn,[listReports(db,'source')[0].imported.a]);
  assert.equal(db.listTasks().length,2);assert.equal(listReports(db,'source')[0].imported.c,undefined);
});
test('double report submission/import and restart remain idempotent',()=>{
  const before=listReports(db,'source')[0];const repeated=saveReport(db,'source',{title:'Review',findings:[f('a'),f('b',['a']),f('c')]});assert.equal(before.id,repeated.id);
  db.close();db=new CerebroDatabase(join(root,'test.db'));
  const result=importFindings(db,'source',before.id,['a','b']);assert.equal(result.tasks.length,0);assert.equal(db.listTasks().length,2);assert.equal(db.listEpics().length,1);
});
test('invalid, incomplete, oversized or cyclic findings do not create backlog entries',()=>{
  for(const invalid of [{},{title:'x',findings:[{id:'x'}]},{title:'x',findings:[f('x',['x'])]},{title:'x',findings:Array.from({length:101},(_,i)=>f(String(i)))},{title:'x',findings:[{...f('x'),problem:'x'.repeat(6000)}]}])assert.throws(()=>parseReport(invalid));
  assert.equal(db.listTasks().length,2);
});
test('findings CLI preserves Unicode split between stdin chunks without an agent turn',async()=>{
 const {createServer}=await import('node:http');const {spawn}=await import('node:child_process');let received;
 const server=createServer((request,response)=>{request.setEncoding('utf8');let text='';request.on('data',chunk=>text+=chunk);request.on('end',()=>{received=JSON.parse(text);response.setHeader('Content-Type','application/json');response.end(JSON.stringify({id:'published'}));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const payload={title:'évaluation',findings:[f('unicode')]};const buffer=Buffer.from(JSON.stringify(payload));const split=buffer.indexOf(Buffer.from('é'))+1;
  const child=spawn(process.execPath,['bin/cerebro-findings'],{env:{...process.env,CEREBRO_SESSION_ID:'source',CEREBRO_TOKEN:'test',CEREBRO_URL:`http://127.0.0.1:${server.address().port}`},stdio:['pipe','pipe','pipe']});
  let output='';child.stdout.on('data',data=>output+=data);const ended=new Promise(resolve=>child.once('close',resolve));child.stdin.write(buffer.subarray(0,split));await new Promise(r=>setTimeout(r,30));child.stdin.end(buffer.subarray(split));
  assert.equal(await ended,0);assert.deepEqual(received,payload);assert.match(output,/published/);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
