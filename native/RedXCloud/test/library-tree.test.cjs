'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createCloud}=require('../server.cjs');
const {digest}=require('../redx-state.cjs');
const workspace='1'.repeat(32),other='2'.repeat(32),file='f'.repeat(18),issuer='https://red-xai.com';
class Store{
 constructor(){this.map=new Map();}
 async get(owner){return this.map.has(owner)?structuredClone(this.map.get(owner)):null;}
 async ensure(owner,quota){if(!this.map.has(owner))this.map.set(owner,{id:owner,owner,revision:0,quota,used:0,workspaces:{},objects:{},library:{}});return this.get(owner);}
 async change(owner,fn){const s=await this.get(owner);fn(s);s.revision++;this.map.set(owner,s);return structuredClone(s);}
}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'library-tree-')),store=new Store();let active=true;
 const cloud=await createCloud({issuer,root,store,authProvider:'redx-site-session',
  entitlementURL:'https://api.red-xai.com/gendragoon/v2/receiver-entitlements',fetchImpl:async(url,opts)=>{
   if(url.endsWith('/userinfo'))return Response.json({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:opts.headers.authorization.slice(-1),email_verified:true});
   return Response.json({schema:1,projectLimit:10,workspaces:[workspace,other].map(id=>({id,projectId:id,name:'Note',active,readOnly:!active,quotaBytes:active?1000:0,workers:active?1:0}))});
  }});
 const api=await cloud.listen();t.after(async()=>{await cloud.close();await fs.rm(root,{recursive:true,force:true});});
 async function call(route,method='GET',body,who='A'){
  const r=await fetch(api+'/v1/receivers/me'+route,{method,headers:{authorization:'Bearer rxca_'+who.repeat(43),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return{status:r.status,body:await r.json()};
 }
 await call('','PUT');await call('','PUT',undefined,'B');
 const owner=digest(JSON.stringify(['red-xai-receiver/v1',issuer,'A']));
 await store.change(owner,s=>{s.used=42;s.workspaces[workspace].usedBytes=42;s.library[file]={key:file,name:'report.txt',kind:'file',workspace,manifestId:'a'.repeat(32),archiveBytes:42,archiveSha256:'b'.repeat(64),generation:1};});
 const snapshot=()=>call('/workspaces/'+workspace+'/library');
 const op=(operation,keys=[],extra={})=>call('/library/operations','POST',{workspace,operation,keys,...extra});
 return{call,op,snapshot,store,owner,lapse:()=>{active=false;}};
}
test('authenticated folder tree create/move/rename/copy/delete keeps encrypted archive identity stable',async t=>{
 const f=await fixture(t);let r=await f.snapshot();assert.equal(r.body.revision,0);
 r=await f.op('create-folder',[],{name:'Documents',expectedRevision:0});assert.equal(r.status,200);
 const folder=r.body.changedKeys[0];assert.equal(r.body.items.find(i=>i.key===folder).virtualFolder,true);
 r=await f.op('move',[file],{parentKey:folder,expectedRevision:1});assert.equal(r.status,200);
 r=await f.op('rename',[file],{name:'renamed.txt',expectedRevision:2});assert.equal(r.status,200);
 let original=r.body.items.find(i=>i.key===file);assert.equal(original.name,'report.txt');assert.equal(original.displayName,'renamed.txt');assert.equal(original.manifestId,'a'.repeat(32));
 r=await f.op('copy',[folder],{expectedRevision:3});assert.equal(r.status,200);
 const clone=r.body.items.find(i=>i.virtualFolder&&i.key!==folder),copied=r.body.items.find(i=>i.parentKey===clone.key);
 assert.equal(clone.displayName,'Documents copy');assert.equal(copied.archiveKey,file);assert.equal(copied.manifestId,original.manifestId);assert.equal(copied.name,'report.txt');
 r=await f.op('delete',[folder],{expectedRevision:4});assert.equal(r.status,200);assert.equal(r.body.deletedKeys.length,2);
 assert.equal(r.body.freedBytes,0);assert.equal(r.body.retainedArchiveData,true);assert.ok(r.body.items.some(i=>i.key===copied.key));
 assert.equal((await f.store.get(f.owner)).used,42);
});
test('tree operations reject cycles, stale revisions, cross-note parents and colliding batches atomically',async t=>{
 const f=await fixture(t);let r=await f.op('create-folder',[],{name:'A',expectedRevision:0});const a=r.body.changedKeys[0];
 r=await f.op('create-folder',[],{name:'B',parentKey:a,expectedRevision:1});const b=r.body.changedKeys[0];
 r=await f.op('move',[a],{parentKey:b,expectedRevision:2});assert.equal(r.status,409);assert.equal(r.body.error,'library_cycle');
 r=await f.op('rename',[file],{name:'other.txt',expectedRevision:1});assert.equal(r.status,409);assert.equal(r.body.error,'library_revision_conflict');
 r=await f.op('create-folder',[],{name:'REPORT.TXT',expectedRevision:2});assert.equal(r.status,409);assert.equal(r.body.error,'library_name_collision');
 const foreign='e'.repeat(18);await f.store.change(f.owner,s=>{s.library[foreign]={key:foreign,name:'Foreign',kind:'folder',virtualFolder:true,workspace:other};});
 r=await f.op('move',[file],{parentKey:foreign,expectedRevision:2});assert.equal(r.status,404);
 r=await f.op('move',[file,'d'.repeat(18)],{parentKey:a,expectedRevision:2});assert.equal(r.status,404);
 const unchanged=(await f.snapshot()).body;assert.equal(unchanged.revision,2);assert.equal(unchanged.items.find(i=>i.key===file).parentKey,null);
 const duplicate='c'.repeat(18);
 await f.store.change(f.owner,s=>{s.library[duplicate]={...s.library[file],key:duplicate,name:'REPORT.TXT',parentKey:a};});
 r=await f.op('move',[file,duplicate],{parentKey:b,expectedRevision:2});assert.equal(r.status,409);assert.equal(r.body.error,'library_name_collision');
 const afterBatch=(await f.snapshot()).body;assert.equal(afterBatch.revision,2);
 assert.equal(afterBatch.items.find(i=>i.key===file).parentKey,null);assert.equal(afterBatch.items.find(i=>i.key===duplicate).parentKey,a);
 r=await f.op('copy',[a],{parentKey:b,expectedRevision:2});assert.equal(r.status,409);assert.equal(r.body.error,'library_cycle');
});
test('regular accounts cannot mutate another account and lapsed notes retain read-only tree access',async t=>{
 const f=await fixture(t);
 let r=await f.call('/library/operations','POST',{workspace,operation:'rename',keys:[file],name:'stolen.txt',expectedRevision:0},'B');assert.equal(r.status,404);
 f.lapse();r=await f.snapshot();assert.equal(r.status,200);assert.equal(r.body.items[0].name,'report.txt');
 r=await f.op('delete',[file],{expectedRevision:0});assert.equal(r.status,402);assert.equal(r.body.error,'workspace_subscription_required');
});
test('copying a folder into itself or a descendant rejects the whole batch without changing metadata',async t=>{
 const f=await fixture(t);
 let r=await f.op('create-folder',[],{name:'Parent',expectedRevision:0});assert.equal(r.status,200);const parent=r.body.changedKeys[0];
 r=await f.op('create-folder',[],{name:'Child',parentKey:parent,expectedRevision:1});assert.equal(r.status,200);const child=r.body.changedKeys[0];
 const before=(await f.snapshot()).body,stateBefore=await f.store.get(f.owner);
 for(const target of [parent,child]){
  // An unrelated first selection must not be copied before a later folder
  // invalidates the batch. Paste can submit this independently of UI guards.
  r=await f.op('copy',[file,parent],{parentKey:target,expectedRevision:2});
  assert.equal(r.status,409);assert.equal(r.body.error,'library_cycle');
  assert.deepEqual((await f.snapshot()).body,before);
  const stateAfter=await f.store.get(f.owner);
  assert.deepEqual(stateAfter.library,stateBefore.library);
  assert.deepEqual(stateAfter.libraryRevisions,stateBefore.libraryRevisions);
  assert.equal(stateAfter.used,stateBefore.used);
 }
});
test('real RedX CAS permits only one operation at a given library revision',
 {skip:!process.env.REDX_INTEGRATION_ROOT,timeout:30000},async t=>{
 const {startStack}=require('./stack.cjs'),{RedXState}=require('../redx-state.cjs');const stack=await startStack();let cloud;
 t.after(async()=>{if(cloud)await cloud.close();await stack.close();});
 const store=new RedXState({url:stack.redxURL,key:stack.receiverKey,db:'gendragoon_receivers',local:true});
 const owner=digest(JSON.stringify(['red-xai-receiver/v1',issuer,'A']));await store.ensure(owner,1000);
 await store.change(owner,s=>{s.workspaces[workspace]={id:workspace,name:'Note'};});
 cloud=await createCloud({issuer,root:path.join(stack.dir,'tree-cas'),store,authProvider:'redx-site-session',fetchImpl:async()=>Response.json({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:'A',email_verified:true})});
 const api=await cloud.listen();
 async function create(name){const r=await fetch(api+'/v1/receivers/me/library/operations',{method:'POST',headers:{authorization:'Bearer rxca_'+'A'.repeat(43),'content-type':'application/json'},body:JSON.stringify({workspace,operation:'create-folder',keys:[],name,expectedRevision:0})});return r.status;}
 assert.deepEqual((await Promise.all([create('One'),create('Two')])).sort(),[200,409]);
 const state=await store.get(owner);assert.equal(state.libraryRevisions[workspace],1);assert.equal(Object.keys(state.library).length,1);
});
