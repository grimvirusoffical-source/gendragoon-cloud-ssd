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
test('existing red-xai.com account app token owns exactly one Receiver and revokes live',{timeout:20000},async t=>{
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
 const revoked=await fetch(api+'/v1/receivers/me',{headers:{authorization:'Bearer '+token}});assert.equal(revoked.status,401);
});
