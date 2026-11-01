'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createInternalEntitlements,createInternalEntitlementClient}=require('../internal-entitlements.cjs');
const {digest,CloudError}=require('../redx-state.cjs');
const token='T'.repeat(43),issuer='https://red-xai.com',subject='fixture-sub',workspaceId='a'.repeat(32);
const owner=digest(JSON.stringify(['red-xai-receiver/v1',issuer,subject]));
const body={owner,issuer,subject,workspaceId};
async function fixture(t,{credential=token,resolve,now=()=>Date.now()}={}){
 let called=0;
 const handler=createInternalEntitlements({token:credential,issuer,now,resolve:async(...args)=>{called++;return resolve?resolve(...args):{id:workspaceId,active:true,readOnly:false,quotaBytes:1000000,workers:4,checkedAtMs:now()};}});
 const server=http.createServer(async(req,res)=>{try{if(await handler(req,res,new URL(req.url,'http://localhost').pathname))return;res.writeHead(404);res.end('{}');}catch(e){res.writeHead(e instanceof CloudError?e.status:503,{'content-type':'application/json'});res.end(JSON.stringify({error:e instanceof CloudError?e.code:'unavailable'}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port+'/internal/receiver-entitlements';
 const call=async(value=body,authorization='Bearer '+token)=>{const r=await fetch(url,{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(value)});return{status:r.status,body:await r.json()};};
 return{call,url,count:()=>called};
}
test('disabled and unauthorized internal requests never invoke billing resolution',async t=>{
 const disabled=await fixture(t,{credential:null});assert.equal((await disabled.call()).status,404);assert.equal(disabled.count(),0);
 const f=await fixture(t);for(const value of ['', 'Bearer gdpk_fixture','Bearer '+ 'W'.repeat(43),'Bearer '+token+'x'])assert.equal((await f.call(body,value)).status,401);
 assert.equal(f.count(),0);
});
test('identity derives from the configured issuer and frozen subject, never customer fields',async t=>{
 const f=await fixture(t);
 for(const forged of [{...body,owner:'f'.repeat(64)},{...body,issuer:'https://other.invalid'},{...body,subject:'other-sub'},{...body,ownerAdmin:true},{...body,workspaceId:'../all'}])assert.equal((await f.call(forged)).status,403);
 assert.equal(f.count(),0);
 const r=await f.call();assert.equal(r.status,200);assert.equal(r.body.owner,owner);assert.equal(r.body.workspace.id,workspaceId);assert.equal('ownerAdmin' in r.body,false);
});
test('missing, stale, wrongly scoped or malformed entitlements fail closed',async t=>{
 for(const proof of [null,{id:'b'.repeat(32),active:true,readOnly:false,quotaBytes:1,workers:1,checkedAtMs:100000},
  {id:workspaceId,active:true,readOnly:false,quotaBytes:1,workers:1,checkedAtMs:1},
  {id:workspaceId,active:true,readOnly:false,quotaBytes:1,workers:25,checkedAtMs:100000}]){
   const f=await fixture(t,{resolve:()=>proof,now:()=>100000});assert.equal((await f.call()).status,proof===null?404:503);
 }
});
test('trusted client is pinned to authenticated IPv4 loopback and binds every returned proof',async t=>{
 for(const url of ['https://example.com/internal/receiver-entitlements','http://127.0.0.1:17778/not-the-route','http://user:pass@127.0.0.1/internal/receiver-entitlements'])assert.throws(()=>createInternalEntitlementClient({url,token,issuer}));
 const f=await fixture(t),client=createInternalEntitlementClient({url:f.url,token,issuer});
 const proof=await client({owner,issuer,subject},workspaceId);assert.equal(proof.workers,4);
 await assert.rejects(client({owner,issuer,subject:'other'},workspaceId),e=>e.status===403);
 const unavailable=createInternalEntitlementClient({issuer});await assert.rejects(unavailable({owner,issuer,subject},workspaceId),e=>e.status===503);
 const confused=createInternalEntitlementClient({url:f.url,token,issuer,fetchImpl:async()=>new Response(JSON.stringify({schema:1,owner:'f'.repeat(64),issuer,subject,workspace:{id:workspaceId}}),{status:200})});
 await assert.rejects(confused({owner,issuer,subject},workspaceId),e=>e.status===503);
});
