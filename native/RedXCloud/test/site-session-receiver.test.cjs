'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const {createBridge}=require('../../../../red-xai-accounts/bridge/site-session/server.cjs');
const {RedXAISiteAuth}=require('../../../../red-xai-installers/npm/vendor/redx-site-session.cjs');
const {createCloud}=require('../server.cjs');
const native='rxs1.'+'c'.repeat(22)+'.'+'d'.repeat(43);
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
class Store{
 constructor(){this.map=new Map();}
 async ensure(owner,quota){if(!this.map.has(owner))this.map.set(owner,{schema:1,owner,id:owner,revision:0,quota,used:0,workspaces:{},objects:{}});return structuredClone(this.map.get(owner));}
 async get(owner){return this.map.has(owner)?structuredClone(this.map.get(owner)):null;}
 async change(owner,fn){const x=structuredClone(this.map.get(owner));fn(x);x.revision++;this.map.set(owner,x);return structuredClone(x);}
}
async function approve(origin,url){
 const request=new URL(url).hash.slice('#request='.length);
 const cRes=await fetch(origin+'/redxai-connect/context',{method:'POST',headers:{origin,'content-type':'application/json',cookie:'redx_session='+native},body:JSON.stringify({request})});
 const c=await cRes.json(),browser=cRes.headers.get('set-cookie').split(';')[0];
 const a=await fetch(origin+'/redxai-connect/approve',{method:'POST',headers:{origin,'content-type':'application/json',cookie:'redx_session='+native+'; '+browser},body:JSON.stringify({request,csrf:c.csrf})});
 assert.equal(a.status,200);
}
test('existing red-xai.com app grant owns one Receiver, survives browser sign-out, and revokes on app logout',{timeout:20000},async t=>{
 const port=await freePort(),origin='http://127.0.0.1:'+port,sub='existing-site-account-id';
 let active=true;
 const bridge=createBridge({publicOrigin:origin,testMode:true,fetchImpl:async()=>new Response(JSON.stringify(active?{account:{id:sub,email_verified:true,username:'same-user'}}:{error:'signed_out'}),{status:active?200:401,headers:{'content-type':'application/json'}})});
 await bridge.listen(port);
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'site-receiver-'));
 const cloud=await createCloud({issuer:origin,dev:true,authProvider:'redx-site-session',store:new Store(),root});
 const api=await cloud.listen();
 t.after(async()=>{await cloud.close();await fs.rm(root,{recursive:true,force:true});await bridge.close();});
 const auth=new RedXAISiteAuth({origin,development:true,timeoutMs:12000,openBrowser:url=>approve(origin,url)});
 const user=await auth.loginWithBrowser();assert.equal(user.sub,sub);
 const token=await auth.accessToken();
 const one=await fetch(api+'/v1/receivers/me',{method:'PUT',headers:{authorization:'Bearer '+token}});assert.equal(one.status,200);
 const receiver=await one.json();
 const expected=crypto.createHash('sha256').update(JSON.stringify(['red-xai-receiver/v1',origin,sub])).digest('hex');
 assert.equal(receiver.id,expected);assert.equal(receiver.storageFormat,'redsecretsxai-png-v1');
 active=false;
 const afterBrowserSignout=await fetch(api+'/v1/receivers/me',{headers:{authorization:'Bearer '+token}});
 assert.equal(afterBrowserSignout.status,200);
 await auth.logout();
 const revoked=await fetch(api+'/v1/receivers/me',{headers:{authorization:'Bearer '+token}});
 assert.equal(revoked.status,401);
});

test('production health is explicit and uses the dedicated Receiver route',{timeout:5000},async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'prod-health-'));
 const cloud=await createCloud({issuer:'https://red-xai.com',dev:false,productionReady:true,authProvider:'redx-site-session',store:new Store(),root});
 const api=await cloud.listen();
 t.after(async()=>{await cloud.close();await fs.rm(root,{recursive:true,force:true});});
 const r=await fetch(api+'/v1/receivers/healthz');assert.equal(r.status,200);
 const h=await r.json();assert.equal(h.service,'Red-XAI-Reiceivers');assert.equal(h.productionReady,true);assert.equal(h.developmentOnly,false);assert.equal(h.authProvider,'redx-site-session');
});
test('RedX metadata may use plain HTTP only on explicit IPv4 loopback',()=>{
 const {RedXState}=require('../redx-state.cjs');
 assert.doesNotThrow(()=>new RedXState({url:'http://127.0.0.1:7790',key:'fixture',db:'gendragoon_receivers',local:true,fetchImpl:async()=>{}}));
 assert.throws(()=>new RedXState({url:'http://10.0.0.2:7790',key:'fixture',db:'gendragoon_receivers',local:true,fetchImpl:async()=>{}}));
});

test('billing entitlements control Receiver workspace quota, workers, creation and lapse state',{timeout:10000},async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'entitled-receiver-'));
 const workspace='1'.repeat(32),inactive='2'.repeat(32),subject='billing-account';
 let active=true,limit=10;
 const entitlementURL='https://gendragoon-free-10068843866.us-central1.run.app/v2/receiver-entitlements';
 const fetchImpl=async(url,opts)=>{
  if(url==='https://red-xai.com/redxai-connect/userinfo'){
   assert.match(opts.headers.authorization,/^Bearer rxca_/);
   return new Response(JSON.stringify({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',
    sub:subject,email_verified:true}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(url===entitlementURL){
   assert.match(opts.headers.authorization,/^Bearer rxca_/);
   return new Response(JSON.stringify({schema:1,ownerBenefits:false,projectLimit:limit,usedProjectSlots:2,workspaces:[
    {projectId:'project-a',id:workspace,name:'Paid 100GB',active,readOnly:!active,quotaBytes:active?80:0,workers:active?4:0,status:active?'active':'payment_revoked',storageTier:'100GB',performanceTier:'boost',entitlementSource:'subscription'},
    {projectId:'project-b',id:inactive,name:'Lapsed',active:false,readOnly:true,quotaBytes:0,workers:0,status:'payment_revoked',storageTier:'2TB',performanceTier:'turbo',entitlementSource:'subscription'}
   ]}),{status:200,headers:{'content-type':'application/json'}});
  }
  throw new Error('unexpected external URL '+url);
 };
 const cloud=await createCloud({issuer:'https://red-xai.com',dev:false,productionReady:true,authProvider:'redx-site-session',
  entitlementURL,fetchImpl,store:new Store(),root});
 const api=await cloud.listen();
 t.after(async()=>{await cloud.close();await fs.rm(root,{recursive:true,force:true});});
 const headers={authorization:'Bearer rxca_'+'Z'.repeat(43)};
 let response=await fetch(api+'/v1/receivers/me',{method:'PUT',headers});
 assert.equal(response.status,200);let state=await response.json();
 assert.equal(state.projectLimit,10);assert.equal(state.workspaces.length,2);
 const paid=state.workspaces.find(w=>w.id===workspace);assert.equal(paid.quotaBytes,80);assert.equal(paid.workers,4);assert.equal(paid.active,true);
 const lapsed=state.workspaces.find(w=>w.id===inactive);assert.equal(lapsed.readOnly,true);assert.equal(lapsed.quotaBytes,0);
 response=await fetch(api+'/v1/receivers/me/workspaces',{method:'POST',headers:{...headers,'idempotency-key':'a'.repeat(32),'content-type':'application/json'},body:JSON.stringify({name:'Bypass'})});
 assert.equal(response.status,409);assert.equal((await response.json()).error,'create_project_through_billing');
 const payload=Buffer.alloc(90);const digest=crypto.createHash('sha256').update(payload).digest('hex');
 response=await fetch(api+'/v1/receivers/me/workspaces/'+workspace+'/blobs/'+'a'.repeat(32),{method:'PUT',headers:{...headers,'content-type':'image/png','x-content-sha256':digest,'content-length':'90'},body:payload});
 assert.equal(response.status,507);assert.equal((await response.json()).error,'quota_exceeded');
 response=await fetch(api+'/v1/receivers/me/workspaces/'+inactive+'/blobs/'+'b'.repeat(32),{method:'PUT',headers:{...headers,'content-type':'image/png','x-content-sha256':digest,'content-length':'90'},body:payload});
 assert.equal(response.status,402);assert.equal((await response.json()).error,'workspace_subscription_required');
 active=false;limit=20;
 response=await fetch(api+'/v1/receivers/me',{headers});assert.equal(response.status,200);state=await response.json();
 assert.equal(state.projectLimit,20);assert.equal(state.workspaces.find(w=>w.id===workspace).readOnly,true);assert.equal(state.workspaces.find(w=>w.id===workspace).workers,0);
});
