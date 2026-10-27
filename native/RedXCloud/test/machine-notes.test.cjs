'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createCloud}=require('../server.cjs');
const {digest}=require('../redx-state.cjs');
const issuer='https://red-xai.com';
const receiverId=sub=>digest(JSON.stringify(['red-xai-receiver/v1',issuer,sub]));
class Store {
 constructor(){this.map=new Map();this.queries=[];}
 async ensure(owner,quota){if(!this.map.has(owner))this.map.set(owner,{owner,id:owner,revision:0,quota,used:0,workspaces:{},objects:{},library:{}});return this.get(owner);}
 async get(owner){return this.map.has(owner)?structuredClone(this.map.get(owner)):null;}
 async change(owner,fn){const s=await this.get(owner);fn(s);s.revision++;this.map.set(owner,s);return structuredClone(s);}
 async call(method,route,body){
  this.queries.push({method,route,body});assert.equal(method,'POST');assert.equal(route,'bx');
  assert.equal(body.q,'{Get[]} = "receivers.red-xai.db":Receiver[ID > $after] -> [ID, Owner], Sort = ID, Limit = $limit');
  return {columns:['ID','Owner'],rows:[...this.map.keys()].map(owner=>[Number.parseInt(owner.slice(0,13),16),owner])
   .filter(row=>row[0]>body.params.after).sort((a,b)=>a[0]-b[0]).slice(0,body.params.limit)};
 }
}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'machine-notes-')),store=new Store();
 const identities={O:{sub:'owner',email:'SUPPORT@INFECTED-NATION.COM',email_verified:true},A:{sub:'alice',email:'alice@example.test',email_verified:true},
  B:{sub:'bob',email:'bob@example.test',email_verified:true},U:{sub:'unverified',email:'support@infected-nation.com',email_verified:false},
  M:{sub:'owner',email:'changed@example.test',email_verified:true}};
 const cloud=await createCloud({issuer,authProvider:'redx-site-session',root,store,fetchImpl:async(url,opts)=>{
  assert.equal(url,issuer+'/redxai-connect/userinfo');const user=identities[opts.headers.authorization.slice('Bearer rxca_'.length)[0]];
  return Response.json({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',...user});
 }});
 const api=await cloud.listen();t.after(async()=>{await cloud.close();await fs.rm(root,{recursive:true,force:true});});
 const alice=receiverId('alice'),bob=receiverId('bob'),owner=receiverId('owner');
 for(const id of [alice,bob,owner])await store.ensure(id,1000);
 await store.change(alice,s=>{
  s.used=10;s.ownerBenefits=true; // A stored benefit is never admin authority.
  s.workspaces['a'.repeat(32)]={id:'a'.repeat(32),name:'Alice MachineNote',active:true,readOnly:false,quotaBytes:1000,usedBytes:10,workers:1};
  s.control={storageSecret:'DO-NOT-EXPOSE-SECRET',stripeCustomerId:'DO-NOT-EXPOSE-CUSTOMER',projects:{
   ['a'.repeat(32)]:{id:'a'.repeat(32),name:'Alice MachineNote',active:true,readOnly:false,quotaBytes:1000,workers:1,status:'active',storageTier:'100GB',performanceTier:'free',feeWaived:true},
   ['d'.repeat(32)]:{id:'d'.repeat(32),name:'Deleted MachineNote',status:'active'},
  }};s.deletedWorkspaces={['d'.repeat(32)]:{deletedMs:1}};
  s.library['f'.repeat(18)]={name:'Visible name.txt',kind:'file',workspace:'a'.repeat(32),archiveBytes:8,generation:1,updatedMs:1,manifestId:'DO-NOT-EXPOSE-MANIFEST'};
 });
 await store.change(bob,s=>{s.control={projects:{['b'.repeat(32)]:{id:'b'.repeat(32),name:'Bob Pending MachineNote',active:false,readOnly:true,quotaBytes:0,workers:0,status:'pending_payment',storageTier:'1TB',performanceTier:'max',feeWaived:false}}};});
 async function call(who,route){const r=await fetch(api+route,{headers:{authorization:'Bearer rxca_'+who.repeat(43)}});return{status:r.status,body:await r.json()};}
 return {root,store,api,alice,bob,owner,call};
}
test('regular users see only their own MachineNotes and cannot enumerate other accounts',async t=>{
 const f=await fixture(t);
 let r=await f.call('A','/v1/receivers/me/machine-notes');assert.equal(r.status,200);assert.equal(r.body.scope,'own');assert.equal(r.body.ownerAdmin,false);
 assert.deepEqual(r.body.machineNotes.map(n=>n.name),['Alice MachineNote']);assert.equal(r.body.machineNotes[0].receiverId,f.alice);
 assert.equal(r.body.machineNotes[0].usedBytes,10);assert.equal(r.body.machineNotes[0].libraryItemCount,1);
 assert.equal(r.body.machineNotes[0].libraryItems[0].name,'Visible name.txt');
 assert.ok(!JSON.stringify(r.body).includes('DO-NOT-EXPOSE'));assert.ok(!JSON.stringify(r.body).includes('Bob Pending'));
 r=await f.call('A','/v1/receivers/admin/machine-notes');assert.equal(r.status,403);assert.equal(r.body.error,'owner_access_required');
 assert.equal(f.store.queries.length,0);
 r=await f.call('B','/v1/receivers/me/machine-notes');assert.equal(r.status,200);assert.equal(r.body.machineNotes[0].name,'Bob Pending MachineNote');
 r=await f.call('A','/v1/receivers/me');assert.deepEqual(r.body.machineNotes,r.body.workspaces);
});
test('fresh verified owner identity can page all MachineNote metadata including pending unprovisioned accounts',async t=>{
 const f=await fixture(t),notes=[],cursors=[];let cursor=null;
 do {
  const r=await f.call('O','/v1/receivers/admin/machine-notes?limit=1'+(cursor?'&cursor='+cursor:''));
  assert.equal(r.status,200);assert.equal(r.body.scope,'all');assert.equal(r.body.ownerAdmin,true);assert.equal(r.body.receiversScanned,1);
  notes.push(...r.body.machineNotes);cursor=r.body.nextCursor;if(cursor)cursors.push(Number(cursor));
 } while(cursor);
 assert.equal(cursors.length,2);assert.ok(cursors[1]>cursors[0]);
 assert.deepEqual(notes.map(n=>n.name).sort(),['Alice MachineNote','Bob Pending MachineNote']);
 assert.equal(notes.find(n=>n.receiverId===f.bob).status,'pending_payment');
 assert.equal(notes.find(n=>n.receiverId===f.bob).workspaceMonthlyCents,500);
 assert.ok(!JSON.stringify(notes).includes('DO-NOT-EXPOSE'));
 await assert.rejects(fs.stat(path.join(f.root,f.bob)),{code:'ENOENT'});
 // Losing the verified owner email revokes admin access on the very next call.
 const changed=await f.call('M','/v1/receivers/admin/machine-notes');assert.equal(changed.status,403);
 const unverified=await f.call('U','/v1/receivers/admin/machine-notes');assert.equal(unverified.status,403);assert.equal(unverified.body.error,'account_setup_required');
});
test('admin MachineNotes pagination is bounded and rejects unknown, duplicate and injected selectors',async t=>{
 const f=await fixture(t);
 for(const query of ['limit=0','limit=21','limit=1&limit=2','cursor=-1','cursor=9007199254740991','cursor=abc','owner=alice','limit=1&path=redxai_accounts']){
  const r=await f.call('O','/v1/receivers/admin/machine-notes?'+query);assert.equal(r.status,400,query);
 }
 assert.equal(f.store.queries.length,0);
 const r=await f.call('A','/v1/receivers/me/machine-notes?owner='+f.bob);assert.equal(r.status,400);
});
test('verified owner inventory accepts RedX exact empty projection and rejects malformed empty-looking data',async t=>{
 const f=await fixture(t);let result={columns:[],rows:[]};f.store.call=async()=>result;
 let response=await f.call('O','/v1/receivers/admin/machine-notes');assert.equal(response.status,200);
 assert.deepEqual(response.body.machineNotes,[]);assert.equal(response.body.receiversScanned,0);assert.equal(response.body.nextCursor,null);
 for(const bad of [{columns:[],rows:[[1,'bad']]},{columns:['unexpected'],rows:[]},{rows:[]},{columns:[]}]){
  result=bad;response=await f.call('O','/v1/receivers/admin/machine-notes');assert.equal(response.status,503);assert.equal(response.body.error,'metadata_invalid');
 }
 assert.equal((await f.call('A','/v1/receivers/admin/machine-notes')).status,403);
});
test('MachineNotes admin enumeration reads actual scoped RedX Receiver records and control-only notes',
 {skip:!process.env.REDX_INTEGRATION_ROOT,timeout:30000},async t=>{
 const {startStack}=require('./stack.cjs'),{RedXState}=require('../redx-state.cjs'),{ControlState}=require('../control-state.cjs');
 const stack=await startStack();let cloud;
 t.after(async()=>{if(cloud)await cloud.close();await stack.close();});
 const options={url:stack.redxURL,key:stack.receiverKey,db:'gendragoon_receivers',local:true};
 const store=new RedXState(options),control=new ControlState(options),alice=receiverId('alice'),bob=receiverId('bob');
 await store.ensure(alice,1000);
 await store.change(alice,s=>{s.workspaces['a'.repeat(32)]={id:'a'.repeat(32),name:'Provisioned MachineNote',usedBytes:0};});
 await control.ensure(bob,{projects:{['b'.repeat(32)]:{id:'b'.repeat(32),name:'Unpaid MachineNote',status:'pending_payment',feeWaived:true}}});
 cloud=await createCloud({issuer,authProvider:'redx-site-session',root:path.join(stack.dir,'notes-receiver'),store,
  fetchImpl:async()=>Response.json({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:'owner',email_verified:true,email:'support@infected-nation.com'})});
 const api=await cloud.listen(),r=await fetch(api+'/v1/receivers/admin/machine-notes?limit=20',{headers:{authorization:'Bearer rxca_'+'O'.repeat(43)}});
 assert.equal(r.status,200);const body=await r.json();
 assert.deepEqual(body.machineNotes.map(n=>n.name).sort(),['Provisioned MachineNote','Unpaid MachineNote']);
 assert.equal(body.receiversScanned,2);assert.equal(body.nextCursor,null);
});
