import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,mock,test} from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-offline-peer-'));process.env.HOME=root;process.env.CEREBRO_DATA_DIR=root;
process.env.CEREBRO_SLACK_TOKEN='test';process.env.CEREBRO_SLACK_USER='test';process.env.CEREBRO_PUBLIC_URL='http://cerebro.test/';
// Un Mac éteint depuis 3 jours (gardé 7 jours) et un portable synchronisé à l'instant.
const day=24*60*60*1000;
writeFileSync(join(root,'peers.json'),JSON.stringify({claims:{},renamedAt:{},notices:[],announced:[],peers:{
 'peer-off':{machine:'mac-mini',lastSeen:Date.now()-3*day,projects:[{name:'Atlas',origin:null,appearedAt:1},{name:'Orion',origin:null,appearedAt:1}]},
 // Identifiant supérieur à tout UUID : cette machine reste responsable des commandes générales.
 'zzzz-peer-on':{machine:'laptop',lastSeen:Date.now(),projects:[{name:'Beta',origin:null,appearedAt:1},{name:'Orion Bis',origin:null,appearedAt:1}]},
}}));
const {CerebroDatabase}=await import('../server/db.ts');const {SessionManager}=await import('../server/sessions.ts');
const {SlackNotifier}=await import('../server/slack.ts');const {PeerSync}=await import('../server/peers.ts');

const db=new CerebroDatabase(':memory:');const manager=new SessionManager(db);
const repo=join(root,'repo');mkdirSync(repo);db.createProject('Atlas Local',repo);
const peers=new PeerSync(db,()=>{});await peers.ready;
const notifier=new SlackNotifier(manager,db,peers);
const api=[];
mock.method(notifier,'slackApi',async(method,body)=>{api.push({method,body});return {ok:true,ts:String(Date.now()),channel:'DM'};});
after(()=>{notifier.stop();peers.stop();mock.restoreAll();db.close();rmSync(root,{recursive:true,force:true});});
const replies=async text=>{
 const start=api.length;await notifier.handleDmMessage('DM',{ts:String(start),text,user:'test'});
 return api.slice(start).filter(call=>call.method==='chat.postMessage').map(call=>call.body.text);
};

test('knownRemotely ignore les pairs périmés, signalés comme injoignables',()=>{
 assert.equal(peers.knownRemotely('Atlas',true),false);
 assert.equal(peers.knownRemotely('atl',false),false);
 assert.deepEqual(peers.unreachableMachines('Atlas',true),['mac-mini']);
 assert.deepEqual(peers.unreachableMachines('atl',false),['mac-mini']);
 assert.equal(peers.knownRemotely('Beta',true),true);
 assert.deepEqual(peers.unreachableMachines('Beta',true),[]);
 assert.equal(peers.activePeerProjects().some(project=>project.machine==='mac-mini'),false);
});

test('Slack répond explicitement pour un projet connu seulement sur une machine injoignable',async()=>{
 const posted=await replies('Atlas: lance les tests');
 assert.equal(posted.length,1);
 assert.match(posted[0],/Projet « Atlas » connu sur mac-mini, actuellement injoignable\./);
 // Le nom exact désigne le projet du Mac : pas de repli sur le préfixe local « Atlas Local ».
 assert.equal(db.listSessions().length,0);
});

test('un projet connu d’un pair actif reste traité par lui, sans réponse ici',async()=>{
 assert.deepEqual(await replies('Beta: lance les tests'),[]);
 // Préfixe connu à la fois du pair actif et du pair injoignable : le pair actif s'en charge.
 assert.deepEqual(await replies('Orio: statut'),[]);
 assert.equal(db.listSessions().length,0);
});
