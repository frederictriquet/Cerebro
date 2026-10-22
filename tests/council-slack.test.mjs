import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,mock,test} from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-council-slack-'));process.env.HOME=root;process.env.CEREBRO_DATA_DIR=root;
process.env.CEREBRO_SLACK_TOKEN='test';process.env.CEREBRO_SLACK_USER='test';process.env.CEREBRO_PUBLIC_URL='http://cerebro.test/';
const {CerebroDatabase}=await import('../server/db.ts');const {SessionManager}=await import('../server/sessions.ts');
const {SlackNotifier,parseCouncilCommand,councilSlackText}=await import('../server/slack.ts');
const {CouncilRuns}=await import('../server/council-runner.ts');const {ANSWER_SCHEMA,REVIEW_SCHEMA}=await import('../server/council.ts');
const {PUBLIC_URL}=await import('../server/config.ts');
const base=PUBLIC_URL.replace(/\/+$/,'');

test('parseCouncilCommand recognizes general and project councils only',()=>{
 assert.deepEqual(parseCouncilCommand('council: Faut-il migrer ?'),{projectName:null,question:'Faut-il migrer ?'});
 assert.deepEqual(parseCouncilCommand('  Council :  question\nsur deux lignes  '),{projectName:null,question:'question\nsur deux lignes'});
 assert.deepEqual(parseCouncilCommand('acme/council: SQLite ou Postgres ?'),{projectName:'acme',question:'SQLite ou Postgres ?'});
 assert.deepEqual(parseCouncilCommand('Mon Projet / COUNCIL: q'),{projectName:'Mon Projet',question:'q'});
 for(const text of ['council:','council:   ','acme/council:','acme: council: q','acme/codex: q','acme/council+: q','/council: q','? council: q','councils: q'])assert.equal(parseCouncilCommand(text),null,text);
});

const run=(changes={})=>({id:'00000000-0000-4000-8000-000000000001',projectId:null,origin:'slack',question:'Q',context:'',readProject:false,settings:{},advisors:[],status:'succeeded',phase:'finished',letters:{},answers:[],reviews:[],
 synthesis:{agreements:'Tous **d’accord**.',disagreements:'- A < B',blindSpots:'Le coût.',recommendation:'Faire X.',firstAction:'Mesurer.'},error:null,startedAt:0,finishedAt:1,...changes});

test('councilSlackText posts the synthesis essentials and the report link',()=>{
 const text=councilSlackText(run(),'Acme <&>');
 assert.match(text,/Council \*Acme &lt;&amp;&gt;\*/);
 for(const part of ['*Recommandation*\nFaire X.','*Première action*\nMesurer.','*Accords*\nTous *d’accord*.','*Désaccords*\n• A &lt; B'])assert.ok(text.includes(part),part);
 assert.ok(!text.includes('Le coût.'));
 assert.ok(text.endsWith(`<${base}/#/c/00000000-0000-4000-8000-000000000001|Ouvrir le rapport dans Cerebro>`));
 const failed=councilSlackText(run({status:'failed',synthesis:null,error:'1 réponse obtenue <x>'}),null);
 assert.match(failed,/^:x: Council hors projet en échec : 1 réponse obtenue &lt;x&gt;\n<http/);
 assert.match(councilSlackText(run({status:'cancelled',synthesis:null,error:null}),null),/annulé : aucune synthèse produite\./);
});

const db=new CerebroDatabase(':memory:');const manager=new SessionManager(db);
let general=true;let owns=true;
const peers={ready:Promise.resolve(),owns:()=>owns,setSlackPoster:()=>{},generalResponder:()=>general,knownRemotely:()=>false,conflictMachines:()=>[],conflictResponder:()=>true,activePeerProjects:()=>[]};
const notifier=new SlackNotifier(manager,db,peers);const councils=new CouncilRuns(db);notifier.councils=councils;
const repo=join(root,'repo');mkdirSync(repo);const project=db.createProject('Acme Platform',repo);
const calls=[];let fail=false;
mock.method(CouncilRuns.prototype,'availableAgents',async()=>['claude','codex']);
mock.method(CouncilRuns.prototype,'invoke',async options=>{
 const kind=options.schema===ANSWER_SCHEMA?'answer':options.schema===REVIEW_SCHEMA?'review':'synthesis';calls.push({...options,kind});
 await new Promise(resolve=>setTimeout(resolve,5));
 if(fail)throw new Error('quota épuisé');
 if(kind==='answer')return {answer:`Avis via ${options.agent}`};
 if(kind==='review')return {ranking:[...options.prompt.matchAll(/<reponse lettre="([A-H])">/g)].map(match=>({letter:match[1],reason:'Solide.'})),blindSpot:'Le coût.',missed:'Les tests.'};
 return {agreements:'Accord.',disagreements:'Désaccord.',blindSpots:'Angle mort.',recommendation:'Recommandation finale.',firstAction:'Mesurer.'};
});
const api=[];
mock.method(notifier,'slackApi',async(method,body)=>{api.push({method,body});return {ok:true,ts:String(Date.now()),channel:'DM'};});
after(async()=>{notifier.stop();await councils.shutdown();mock.restoreAll();db.close();rmSync(root,{recursive:true,force:true});});
// La commande rend la main avant la fin du council : on attend le retrait du sablier.
const handled=async(ts,text)=>{
 const start=api.length;await notifier.handleDmMessage('DM',{ts,text,user:'test'});
 for(let i=0;i<500&&!api.slice(start).some(call=>call.method==='reactions.remove');i++)await new Promise(resolve=>setTimeout(resolve,10));
 return api.slice(start);
};
const replies=calls=>calls.filter(call=>call.method==='chat.postMessage').map(call=>call.body.text).join('\n');

test('Slack general council runs without tools and answers in the request thread',async()=>{
 calls.length=0;
 const sent=await handled('10.1','council: Quelle base choisir ?');
 assert.deepEqual(sent.map(call=>call.method).filter(method=>method!=='chat.postMessage'),['reactions.add','reactions.remove']);
 assert.equal(sent[0].body.name,'hourglass_flowing_sand');assert.equal(sent[0].body.timestamp,'10.1');
 assert.ok(sent.filter(call=>call.method==='chat.postMessage').every(call=>call.body.thread_ts==='10.1'));
 const text=replies(sent);assert.match(text,/Council hors projet/);assert.match(text,/\*Recommandation\*\nRecommandation finale\./);assert.match(text,/\*Désaccords\*\nDésaccord\./);
 const stored=councils.list(null);assert.equal(stored.length,1);assert.equal(stored[0].origin,'slack');assert.equal(stored[0].readProject,false);assert.equal(stored[0].question,'Quelle base choisir ?');
 assert.ok(text.includes(`${base}/#/c/${stored[0].id}`));
 assert.ok(calls.every(call=>call.access==='none'&&call.cwd===undefined));
 // Une autre machine traite les commandes générales : rien ici.
 general=false;assert.deepEqual(await notifier.handleDmMessage('DM',{ts:'10.2',text:'council: Encore ?',user:'test'}).then(()=>api.filter(call=>call.body.timestamp==='10.2'||call.body.thread_ts==='10.2')),[]);
 assert.equal(councils.list(null).length,1);general=true;
});

test('Slack project council resolves the project by prefix and reads the repository per its settings',async()=>{
 calls.length=0;
 const sent=await handled('11.1','acme/council: Faut-il découper le serveur ?');
 const [stored]=councils.list(project.id);assert.equal(stored.origin,'slack');assert.equal(stored.readProject,true);
 assert.match(replies(sent),/Council \*Acme Platform\*/);
 assert.ok(calls.filter(call=>call.kind==='answer').every(call=>call.access==='read-only'&&call.cwd===repo));
 assert.ok(calls.filter(call=>call.kind!=='answer').every(call=>call.access==='none'));
 db.updateProject(project.id,{councilSettings:{...stored.settings,readProject:false}});calls.length=0;
 await handled('11.2','Acme Platform/council: Et sans lecture ?');
 assert.equal(councils.list(project.id)[0].readProject,false);assert.ok(calls.every(call=>call.access==='none'));
});

test('Slack project council: unknown project, other owner and failed runs',async()=>{
 const before=councils.list().length;
 await notifier.handleDmMessage('DM',{ts:'12.1',text:'inconnu/council: q',user:'test'});
 assert.match(api.at(-1).body.text,/Projet introuvable : « inconnu »/);assert.equal(api.at(-1).body.thread_ts,'12.1');
 owns=false;const count=api.length;await notifier.handleDmMessage('DM',{ts:'12.2',text:'acme/council: q',user:'test'});assert.equal(api.length,count);owns=true;
 assert.equal(councils.list().length,before);
 fail=true;const sent=await handled('12.3','council: Va échouer');fail=false;
 assert.match(replies(sent),/^:x: Council hors projet en échec : 0 réponse obtenue/);assert.equal(sent.at(-1).method,'reactions.remove');
 notifier.councils=null;const missing=await handled('12.4','council: Sans gestionnaire');notifier.councils=councils;
 assert.match(replies(missing),/^:x: Council impossible : council indisponible/);
});
