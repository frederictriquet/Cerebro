import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {after,test,mock} from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-slack-429-'));process.env.CEREBRO_DATA_DIR=root;process.env.HOME=root;process.env.CEREBRO_SLACK_TOKEN='test';process.env.CEREBRO_SLACK_USER='test';process.env.CEREBRO_SLACK_API_URL='http://slack.test/api';
const {CerebroDatabase}=await import('../server/db.ts');const {SessionManager}=await import('../server/sessions.ts');const {SlackNotifier}=await import('../server/slack.ts');
const db=new CerebroDatabase(':memory:');const manager=new SessionManager(db);const peers={ready:Promise.resolve(),owns:()=>true,setSlackPoster:()=>{}};
const notifier=new SlackNotifier(manager,db,peers);const project=db.createProject('Demo',root);
// Faux Slack : chaque chat.postMessage listé dans `limited` répond 429 (Retry-After 0,1 s), les autres 200.
const calls=[];let limited=0;
mock.method(globalThis,'fetch',async(url,init)=>{
 const method=String(url).replace('http://slack.test/api/','');const body=Object.fromEntries(new URLSearchParams(init.body));
 if(method==='chat.postMessage'&&limited>0){limited--;calls.push({method,body,status:429});return new Response('',{status:429,headers:{'retry-after':'0.1'}});}
 calls.push({method,body,status:200});
 const payload=method==='conversations.open'?{ok:true,channel:{id:'DM'}}:{ok:true,ts:String(Date.now()),channel:'DM'};
 return new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});
});
mock.method(manager,'screenText',()=>['screen']);mock.method(notifier,'poll',async()=>{});notifier.updateSettings({idle:true,waiting:true,delaySeconds:0.02});
function session(id){const s=db.createSession({id,projectId:project.id,agent:'codex',mode:'auto',model:null,effort:null,prompt:'',title:id,status:'running',agentSessionId:id},'token');notifier.onSessionEvent({type:'session',session:s});return s;}
const posts=status=>calls.filter(call=>call.method==='chat.postMessage'&&call.status===status);
async function until(ready){for(let i=0;i<300;i++){if(ready())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Envoi différé attendu non effectué.');}
after(()=>{notifier.stop();mock.restoreAll();db.close();rmSync(root,{recursive:true,force:true});});

test('an automatic alert hitting a Slack 429 window is rescheduled, not lost',async()=>{
 session('alert');limited=1;const start=calls.length;
 manager.setReliableState('alert','idle','Tour terminé');
 await until(()=>posts(429).length===1);
 assert.equal(posts(200).length,0);
 await until(()=>posts(200).length===1);
 const [sent]=posts(200);assert.match(sent.body.text,/Tour terminé/);
 assert.ok(db.connection.prepare('SELECT automatic_at FROM notification_turns WHERE session_id=?').get('alert').automatic_at);
 await new Promise(r=>setTimeout(r,700));assert.equal(calls.slice(start).filter(call=>call.method==='chat.postMessage').length,2,'une seule tentative supplémentaire');
});

test('an agent message during a Slack 429 window is queued and delivered once the window ends',async()=>{
 session('ask');manager.markAsked('ask','Quel choix ?');limited=1;const sentBefore=posts(200).length;
 assert.equal(await notifier.agentMessage('ask','ask','Quel choix ?'),'queued');
 assert.equal(posts(200).length,sentBefore);
 await until(()=>posts(200).length===sentBefore+1);
 assert.match(posts(200).at(-1).body.text,/Quel choix \?/);assert.equal(notifier.threads.get('ask').kind,'ask');
 // Fenêtre déjà active : la requête n'attend pas Slack, le message part ensuite.
 notifier.rateLimitedUntil=Date.now()+100;
 assert.equal(await notifier.agentMessage('ask','notify','Précision'),'queued');
 await until(()=>posts(200).length===sentBefore+2);assert.match(posts(200).at(-1).body.text,/Précision/);
 assert.equal(await notifier.agentMessage('ask','notify','Sans limite'),'sent');
});

test('agent messages waiting behind a deferred one are reported queued too',async()=>{
 session('serie');limited=2;const sentBefore=posts(200).length;
 // Sans signal « queued », cerebro-notify abandonnerait au bout de 10 s puis renverrait le message.
 const prompt=promise=>Promise.race([promise,new Promise(r=>setTimeout(()=>r('attente'),300))]);
 assert.deepEqual(await Promise.all([prompt(notifier.agentMessage('serie','notify','Message-1')),prompt(notifier.agentMessage('serie','notify','Message-2'))]),['queued','queued']);
 // Fenêtre expirée mais réessai du premier encore en attente (marge) : le suivant patiente derrière lui.
 await new Promise(r=>setTimeout(r,150));assert.ok(Date.now()>=notifier.rateLimitedUntil);
 assert.equal(await prompt(notifier.agentMessage('serie','notify','Message-3')),'queued');
 await until(()=>posts(200).length===sentBefore+3);
 assert.equal(posts(429).filter(call=>/Message-1/.test(call.body.text)).length,2,'le réessai du premier reçoit un nouveau 429');
 assert.deepEqual(posts(200).slice(-3).map(call=>call.body.text.match(/Message-\d/)[0]),['Message-1','Message-2','Message-3']);
 assert.equal(notifier.deferredDeliveries.size+notifier.waitingAgentMessages.size,0);
});
