'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {createCloud}=require('../server.cjs');
const {digest}=require('../redx-state.cjs');
const workspace='a'.repeat(32),otherWorkspace='b'.repeat(32),key='receiver-fixture-key';
class Store {
 constructor(){this.map=new Map();this.failFinalDelete=false;this.onChange=()=>{};this.tail=Promise.resolve();}
 async ensure(owner,quota){if(!this.map.has(owner))this.map.set(owner,{schema:2,owner,id:owner,revision:0,quota,used:0,workspaces:{},objects:{},reservations:{},deletions:{},library:{}});return this.get(owner);}
 async get(owner){return this.map.has(owner)?structuredClone(this.map.get(owner)):null;}
 async change(owner,fn){const result=this.tail.then(async()=>{const x=await this.get(owner);fn(x);if(this.failFinalDelete&&x.deletedWorkspaces?.[workspace]){this.failFinalDelete=false;throw new Error('injected metadata outage');}x.revision++;this.map.set(owner,x);this.onChange(x);return structuredClone(x);});this.tail=result.catch(()=>{});return result;}
}
async function fixture(t,{workers=1,quota=1024}={}){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'receiver-lifecycle-')),store=new Store();
 let sub='fixture-owner',entitlementFetches=0;
 const entitlementURL='https://api.red-xai.com/gendragoon/v2/receiver-entitlements';
 const cloud=await createCloud({issuer:'https://red-xai.com',authProvider:'redx-site-session',productionReady:true,
  root,store,workspaceDeleteKey:key,entitlementURL,fetchImpl:async url=>{
   if(url.endsWith('/userinfo'))return Response.json({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub,email_verified:true});
   assert.equal(url,entitlementURL);
   entitlementFetches++;
   return Response.json({schema:1,projectLimit:10,ownerBenefits:false,workspaces:[workspace,otherWorkspace].map(id=>({id,projectId:id,name:id===workspace?'Main':'Other',active:true,readOnly:false,quotaBytes:quota,workers,status:'active'}))});
  }});
 const api=await cloud.listen(),headers={authorization:'Bearer rxca_'+'Z'.repeat(43)};
 t.after(async()=>{await cloud.close();await fs.rm(root,{recursive:true,force:true});});
 async function call(method,route,body,extra={}){
  const r=await fetch(api+'/v1/receivers/me'+route,{method,headers:{...headers,...extra},body});
  return {status:r.status,body:await r.json()};
 }
 const init=await call('PUT','');assert.equal(init.status,200);const owner=init.body.id;
 const timestamp=String(Date.now()),signed={'x-confirm-workspace':workspace,'x-control-delete-time':timestamp,'x-control-delete':crypto.createHmac('sha256',key).update(owner+'/'+workspace+'/'+timestamp).digest('hex')};
 return {api,root,store,headers,owner,call,signed,setSubject:v=>{sub=v;},entitlementFetches:()=>entitlementFetches};
}
test('billing deletion is internal, durable, isolated and idempotent even while old entitlements remain',async t=>{
 const f=await fixture(t);
 const blob='1'.repeat(32),legacy='2'.repeat(32),other='3'.repeat(32),payload=Buffer.from('fixture carrier bytes');
 const dir=path.join(f.root,f.owner,workspace);await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,blob+'.png'),payload);await fs.writeFile(path.join(f.root,f.owner,legacy+'.png'),payload);
 await fs.writeFile(path.join(f.root,f.owner,other+'.png'),payload);
 await f.store.change(f.owner,s=>{
  s.used=payload.length*3;s.workspaces[workspace].usedBytes=payload.length;s.workspaces[otherWorkspace].usedBytes=payload.length;
  s.objects[legacy]={id:legacy,workspace,bytes:payload.length,status:'ready'};
  s.objects[other]={id:other,workspace:otherWorkspace,bytes:payload.length,status:'ready'};
  s.library['a'.repeat(18)]={workspace};s.library['b'.repeat(18)]={workspace:otherWorkspace};
 });
 let r=await f.call('DELETE','/workspaces/'+workspace,undefined,{'x-confirm-workspace':workspace});
 assert.equal(r.status,403);assert.equal(r.body.error,'delete_project_through_billing');
 r=await f.call('DELETE','/workspaces/'+workspace,undefined,{...f.signed,'x-control-delete-time':String(Date.now()-600000)});
 assert.equal(r.status,403);assert.equal(r.body.error,'delete_project_through_billing');
 const fetchedBeforeDelete=f.entitlementFetches();
 r=await f.call('DELETE','/workspaces/'+workspace,undefined,f.signed);
 assert.equal(r.status,200);assert.equal(r.body.freedBytes,payload.length*2);assert.equal(r.body.usedBytes,payload.length);
 // Control holds its account lock through this call: querying it recursively
 // for entitlements would deadlock the deletion.
 assert.equal(f.entitlementFetches(),fetchedBeforeDelete);
 await assert.rejects(fs.stat(dir),{code:'ENOENT'});await assert.rejects(fs.stat(path.join(f.root,f.owner,legacy+'.png')),{code:'ENOENT'});
 assert.equal((await fs.stat(path.join(f.root,f.owner,other+'.png'))).size,payload.length);
 let s=await f.store.get(f.owner);assert.equal(Object.keys(s.library).length,1);assert.ok(s.deletedWorkspaces[workspace]);
 r=await f.call('DELETE','/workspaces/'+workspace,undefined,f.signed);assert.equal(r.status,200);assert.equal(r.body.freedBytes,0);
 r=await f.call('GET','');assert.deepEqual(r.body.workspaces.map(w=>w.id),[otherWorkspace]);
 f.setSubject('another-account');await f.call('PUT','');
 r=await f.call('DELETE','/workspaces/'+workspace,undefined,f.signed);assert.equal(r.status,403);
 s=await f.store.get(f.owner);assert.equal(s.used,payload.length);
});
test('workspace deletion resumes after final metadata failure without quota being released twice',async t=>{
 const f=await fixture(t),dir=path.join(f.root,f.owner,workspace);await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,'fixture'),Buffer.from('fixture'));
 await f.store.change(f.owner,s=>{s.used=7;s.workspaces[workspace].usedBytes=7;});
 f.store.failFinalDelete=true;
 let r=await f.call('DELETE','/workspaces/'+workspace,undefined,f.signed);assert.equal(r.status,503);
 let s=await f.store.get(f.owner);assert.ok(s.workspaceDeletions[workspace]);assert.equal(s.used,7);
 r=await f.call('GET','');assert.ok(!r.body.workspaces.some(w=>w.id===workspace));
 r=await f.call('DELETE','/workspaces/'+workspace,undefined,f.signed);assert.equal(r.status,200);assert.equal(r.body.freedBytes,7);
 s=await f.store.get(f.owner);assert.equal(s.used,0);assert.ok(s.deletedWorkspaces[workspace]);
});
test('signed deletion tombstones an unprovisioned Receiver against a stale entitlement response',async t=>{
 const f=await fixture(t);f.store.map.delete(f.owner);
 let r=await f.call('DELETE','/workspaces/'+workspace,undefined,f.signed);
 assert.equal(r.status,200);assert.equal(r.body.freedBytes,0);
 r=await f.call('PUT','');assert.equal(r.status,200);assert.ok(!r.body.workspaces.some(w=>w.id===workspace));
 assert.ok((await f.store.get(f.owner)).deletedWorkspaces[workspace]);
});
test('verified worker limit applies to both blob and legacy transfers and blocks deletion during upload',{timeout:10000},async t=>{
 const f=await fixture(t),payload=Buffer.alloc(10),id='1'.repeat(32);
 let reserved;const ready=new Promise(resolve=>{reserved=resolve;});
 f.store.onChange=s=>{if(s.reservations[id])reserved();};
 const request=http.request(f.api+'/v1/receivers/me/workspaces/'+workspace+'/blobs/'+id,{method:'PUT',headers:{...f.headers,'content-type':'image/png','content-length':'10','x-content-sha256':digest(payload)}});
 const completed=new Promise((resolve,reject)=>{request.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});request.on('error',reject);});
 request.write(payload.subarray(0,4));await ready;
 const uploadHeaders={'content-type':'image/png','content-length':'10','x-content-sha256':digest(payload)};
 for(const type of ['blobs','objects']){
  const r=await f.call('PUT','/workspaces/'+workspace+'/'+type+'/'+'2'.repeat(32),payload,uploadHeaders);
  assert.equal(r.status,429);assert.equal(r.body.error,'performance_limit_retry');
 }
 let r=await f.call('DELETE','/workspaces/'+workspace,undefined,f.signed);assert.equal(r.status,409);assert.equal(r.body.error,'workspace_busy');
 request.end(payload.subarray(4));assert.equal(await completed,422);
 r=await f.call('DELETE','/workspaces/'+workspace,undefined,f.signed);assert.equal(r.status,200);assert.equal(r.body.usedBytes,0);
});
test('legacy uploads enforce workspace quota before reading or decoding the carrier',async t=>{
 const f=await fixture(t,{quota:8}),payload=Buffer.alloc(10);
 const r=await f.call('PUT','/workspaces/'+workspace+'/objects/'+'1'.repeat(32),payload,{'content-type':'image/png','content-length':'10','x-content-sha256':digest(payload)});
 assert.equal(r.status,507);assert.equal(r.body.error,'quota_exceeded');
 assert.equal((await f.store.get(f.owner)).used,0);
});
test('preexisting legacy objects are included in the workspace ledger before another upload',async t=>{
 const f=await fixture(t,{quota:15}),payload=Buffer.alloc(10),legacy='1'.repeat(32);
 await f.store.change(f.owner,s=>{s.used=10;s.objects[legacy]={id:legacy,workspace,bytes:10,status:'ready'};});
 const r=await f.call('PUT','/workspaces/'+workspace+'/blobs/'+'2'.repeat(32),payload,{'content-type':'image/png','content-length':'10','x-content-sha256':digest(payload)});
 assert.equal(r.status,507);assert.equal(r.body.error,'quota_exceeded');
 const s=await f.store.get(f.owner);assert.equal(s.workspaces[workspace].usedBytes,10);assert.equal(s.used,10);
});
test('Max admits more than eight simultaneous chunk transfers while respecting its verified allowance',{timeout:15000},async t=>{
 const f=await fixture(t,{workers:20}),payload=Buffer.alloc(10),requests=[];
 // Keep the bodies pending so this checks admission, independent of codec speed.
 for(let i=0;i<9;i++){
  const id=i.toString(16).padStart(32,'0');
  let reserved;const ready=new Promise(resolve=>{reserved=resolve;});
  f.store.onChange=s=>{if(s.reservations[id])reserved();};
  const request=http.request(f.api+'/v1/receivers/me/workspaces/'+workspace+'/blobs/'+id,{method:'PUT',headers:{...f.headers,'content-type':'image/png','content-length':'10','x-content-sha256':digest(payload)}});
  const completed=new Promise((resolve,reject)=>{request.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});request.on('error',reject);});
  request.write(payload.subarray(0,4));requests.push({request,completed});await ready;
 }
 assert.equal(Object.keys((await f.store.get(f.owner)).reservations).length,9);
 for(const {request} of requests)request.end(payload.subarray(4));
 assert.deepEqual(await Promise.all(requests.map(x=>x.completed)),Array(9).fill(422));
 assert.equal((await f.store.get(f.owner)).used,0);
});
