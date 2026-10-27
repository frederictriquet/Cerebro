import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,mock,test} from 'node:test';
const root=mkdtempSync(join(tmpdir(),'cerebro-peer-timeout-'));process.env.HOME=root;process.env.CEREBRO_DATA_DIR=root;
const {CerebroDatabase}=await import('../server/db.ts');const {PeerSync}=await import('../server/peers.ts');

const db=new CerebroDatabase(':memory:');
const instances=[];
after(()=>{for(const peers of instances)peers.stop();mock.restoreAll();db.close();rmSync(root,{recursive:true,force:true});});

test('un dépôt figé (config FIFO sans écrivain) ne bloque ni ready ni sync()',async()=>{
 // git ouvre .git/config et attend indéfiniment un écrivain, comme sur un montage réseau figé.
 const frozen=join(root,'frozen');mkdirSync(join(frozen,'.git','objects'),{recursive:true});mkdirSync(join(frozen,'.git','refs'));
 writeFileSync(join(frozen,'.git','HEAD'),'ref: refs/heads/master\n');execFileSync('mkfifo',[join(frozen,'.git','config')]);
 const project=db.createProject('Frozen',frozen);
 const started=Date.now();const peers=new PeerSync(db,()=>{});instances.push(peers);
 await peers.ready;
 const elapsed=Date.now()-started;
 assert.ok(elapsed<10_000,`ready résolu en ${elapsed} ms`);
 assert.equal(peers.origins.get(project.id),null);
 // sync() se résout aussi, malgré le dépôt figé.
 await peers.sync();
 assert.ok(Date.now()-started<20_000);
});

test('un tour de synchronisation bloqué est abandonné : ready, synced et sync() se résolvent',async()=>{
 mock.method(PeerSync.prototype,'refreshOrigins',()=>new Promise(()=>{}));
 mock.timers.enable({apis:['setTimeout']});
 const warn=mock.method(console,'warn',()=>{});
 try{
  const peers=new PeerSync(db,()=>{});instances.push(peers);
  let ready=false;void peers.ready.then(()=>{ready=true;});
  const pending=peers.sync();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ready,false);
  mock.timers.tick(60_000);
  await pending;await peers.ready;await peers.synced;
  assert.match(warn.mock.calls.at(-1).arguments[0],/synchronisation interrompue/);
  // Plus de tour en cours : un nouvel appel relance une synchronisation.
  assert.notEqual(peers.sync(),pending);
 }finally{mock.timers.reset();warn.mock.restore();}
});
