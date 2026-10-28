'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const crypto=require('node:crypto');
const {createCloud}=require('../server.cjs');
const {digest,CloudError}=require('../redx-state.cjs');
const {initial,actor,workspaceRecords}=require('../gdg-account-state.cjs');
const wid='a'.repeat(32),second='b'.repeat(32),issuer='https://red-xai.com';
class Ledger{
 constructor(){this.map=new Map();this.tail=Promise.resolve();}
 async get(owner){return this.map.has(owner)?structuredClone(this.map.get(owner)):null;}
 async ensure(owner,quota){if(!this.map.has(owner))this.map.set(owner,{schema:2,owner,id:owner,revision:0,quota,used:0,workspaces:{},objects:{},reservations:{},deletions:{},library:{}});return this.get(owner);}
 async change(owner,fn){const task=this.tail.then(async()=>{const s=await this.get(owner);fn(s);s.revision++;this.map.set(owner,s);return structuredClone(s);});this.tail=task.catch(()=>{});return task;}
}
class Accounts{
 constructor(){this.map=new Map();this.receipts=new Map();}
 async get(identity){const a=actor(identity);return this.map.has(a.owner)?structuredClone(this.map.get(a.owner)):null;}
 async change(identity,fn){const a=actor(identity),s=(await this.get(identity))||initial(identity);fn(s);s.revision++;this.map.set(a.owner,s);return structuredClone(s);}
 async syncWorkspaces(identity,s){return this.change(identity,v=>{if(v.workspaceRevision>s.revision)return;v.GDGWS=workspaceRecords(s,identity.owner);v.workspaceRevision=s.revision;for(const [id,d]of Object.entries(v.GDGSigned))if(!v.GDGWS[d.workspaceId])delete v.GDGSigned[id];});}
 async writeReceipt(identity,workspace,id,qr){const a=actor(identity);this.receipts.set(a.owner+':'+id,{workspaceId:workspace,qr});}
 async readReceipt(identity,id){return structuredClone(this.receipts.get(actor(identity).owner+':'+id)||null);}
 async removeReceipt(identity,id){this.receipts.delete(actor(identity).owner+':'+id);}
 async remove(identity){this.map.delete(actor(identity).owner);}
}
function fixtureQR(){const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('disposable carrier fixture')]);return {format:'redsecretsxai-visual-v3',objectId:'c'.repeat(32),png:png.toString('base64'),sha256:digest(png)};}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'gdg-http-')),store=new Ledger(),accounts=new Accounts(),tokens=new Map();
 let validated=0;
 const cloud=await createCloud({root,store,issuer,gdgAccounts:accounts,gdgValidateCarrier:async raw=>{assert.equal(digest(raw),fixtureQR().sha256);validated++;},authProvider:'redx-site-session',entitlementURL:'https://api.red-xai.com/gendragoon/v2/receiver-entitlements',fetchImpl:async(url,options)=>{
  if(url.endsWith('/userinfo')){const sub=tokens.get(options.headers.authorization.slice(7));if(!sub)return new Response('',{status:401});return Response.json({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub,email_verified:true});}
  return Response.json({schema:1,projectLimit:10,ownerBenefits:false,workspaces:[wid,second].map(id=>({id,projectId:id,name:'Fixture '+id[0],active:true,readOnly:false,quotaBytes:1000000,workers:1,status:'active'}))});
 }});
 const api=await cloud.listen();t.after(async()=>{await cloud.close();await fs.rm(root,{recursive:true,force:true});});
 async function call(who,route,method='GET',value){const token='rxca_'+crypto.createHash('sha256').update(who).digest('base64url');tokens.set(token,who);const r=await fetch(api+'/v1/receivers/me'+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});return {status:r.status,body:await r.json()};}
 for(const who of ['alice','bob'])assert.equal((await call(who,'','PUT')).status,200);
 return {call,store,accounts,validated:()=>validated};
}
test('device HTTP flow persists encrypted GDGSigned, shows current user QR and fully revokes it',async t=>{
 const f=await fixture(t),route='/workspaces/'+wid+'/devices';
 let r=await f.call('alice',route,'POST',{name:'Fixture Mac',platform:'macos',deviceFingerprint:'f'.repeat(64),qr:fixtureQR()});
 assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.device.signed,true);assert.match(r.body.credential,/^[A-Za-z0-9_-]{43}$/);
 const id=r.body.device.id,credential=r.body.credential;
 assert.equal(f.validated(),1);
 r=await f.call('alice',route);assert.equal(r.body.devices.length,1);assert.equal(r.body.devices[0].signed,true);
 assert.ok(!JSON.stringify(r.body).includes(credential));
 r=await f.call('alice',route+'/'+id+'/qr');assert.equal(r.status,200);assert.equal(r.body.png,fixtureQR().png);
 assert.equal((await f.call('bob',route+'/'+id+'/qr')).status,404);
 assert.equal((await f.call('alice','/workspaces/'+second+'/devices/'+id+'/qr')).status,404);
 r=await f.call('alice','/gdg-settings');assert.equal(Object.keys(r.body.GDGWS).length,2);assert.equal(r.body.GDGSigned.length,1);
 assert.equal((await f.call('alice',route+'/'+id,'DELETE')).status,200);
 assert.equal((await f.call('alice',route+'/'+id+'/qr')).status,404);
 assert.equal((await f.call('alice',route)).body.devices.length,0);
 const identity={issuer,subject:'alice',owner:digest(JSON.stringify(['red-xai-receiver/v1',issuer,'alice']))};
 const user=await f.accounts.get(identity);assert.deepEqual(user.GDGSigned,{});assert.equal(Object.keys(user.GDGWS).length,2);assert.equal(f.accounts.receipts.size,0);
 assert.deepEqual((await f.store.get(identity.owner)).deviceAssignments[wid],{});
 assert.equal((await f.call('alice',route+'/'+id,'DELETE')).status,200);
});
test('missing identity or damaged encrypted receipt cannot leave a successful device registration',async t=>{
 const f=await fixture(t),route='/workspaces/'+wid+'/devices';
 assert.equal((await f.call('alice',route,'POST',{name:'Mac',platform:'macos'})).status,400);
 const r=await f.call('alice',route,'POST',{name:'Mac',platform:'macos',deviceFingerprint:'e'.repeat(64),qr:{...fixtureQR(),sha256:'0'.repeat(64)}});
 assert.equal(r.status,503);assert.equal((await f.call('alice',route)).body.devices.length,0);
 assert.equal((await f.call('alice','/gdg-settings')).body.GDGSigned.length,0);
});
