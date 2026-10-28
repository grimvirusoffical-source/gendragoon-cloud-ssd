'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const crypto=require('node:crypto');
const {createIntegrations,routeAccess,validateEntitlement,filterState}=require('../integrations.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const wid='a'.repeat(32),other='b'.repeat(32),object='c'.repeat(32);
function actor(subject){const issuer='https://accounts.fixture';return {issuer,subject,owner:hash(JSON.stringify(['red-xai-receiver/v1',issuer,subject])),ownerAdmin:true,bearer:'fixture-session'};}
class Metadata {
 constructor(){this.accounts=new Map();this.pointers=new Map();this.grants=new Map();}
 async account(owner){return structuredClone(this.accounts.get(owner)||{keys:{},byo:{}});}
 async update(owner,operation){const v=await this.account(owner);operation(v);this.accounts.set(owner,v);return v;}
 async linkKey(id,owner){if(this.pointers.has(id))throw Error('collision');this.pointers.set(id,owner);}
 async ownerForKey(id){return this.pointers.get(id);}
 async createGrant(id,value){assert(!this.grants.has(id));this.grants.set(id,structuredClone(value));}
 async grant(id){return structuredClone(this.grants.get(id));}
 async consumeGrant(id,verify,now){const g=this.grants.get(id);if(!g||g.usedAtMs!==null||g.expiresAtMs<=now||!verify(g))throw Object.assign(Error('invalid_grant'),{status:400});g.usedAtMs=now;return structuredClone(g);}
}
function fixture(){let at=1000000;const metadata=new Metadata();let proof={id:wid,active:true,readOnly:false,quotaBytes:1000000,workers:4};let available=true;const calls=[];const api=createIntegrations({metadata,now:()=>at,authorizeWorkspace:async(identity,id)=>{calls.push({identity,id});if(!available)throw Object.assign(Error('offline'),{status:503});return {...proof,id,checkedAtMs:at};}});return {api,metadata,calls,setTime:n=>at=n,setProof:p=>proof={...proof,...p},setAvailable:v=>available=v};}
function req(method,data,token){const r=Readable.from(data===undefined?[]:[Buffer.from(JSON.stringify(data))]);r.method=method;r.headers=token?{authorization:'Bearer '+token}:{};return r;}
async function handle(f,path,method,data,identity=actor('one')){return f.api.handle(req(method,data),new URL(path,'https://receiver.fixture'),identity);}
async function create(f,scopes=['files:read','files:write']){return (await handle(f,'/v1/integrations/keys','POST',{service:'quick-launcher',workspaceId:wid,scopes,name:'Fixture'})).body;}
test('keys are shown once, hashed, bound to verified account, workspace and least scopes',async()=>{
 const f=fixture(),key=await create(f);assert.match(key.apiKey,/^gdpk_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/);
 const listing=await handle(f,'/v1/integrations/keys','GET');assert(!JSON.stringify(listing).includes(key.apiKey));assert(!JSON.stringify(listing).includes('digest'));
 const stored=JSON.stringify(await f.metadata.account(actor('one').owner));assert(!stored.includes(key.apiKey));assert(!stored.includes('fixture-session'));assert(stored.includes(hash(key.apiKey)));
 const id=await f.api.authenticateAPIKey(req('PUT',null,key.apiKey),`/v1/receivers/me/workspaces/${wid}/blobs/${object}`);assert.equal(id.ownerAdmin,false);assert.equal(id.bearer,null);assert.equal(id.workspaceId,wid);
 await assert.rejects(f.api.authenticateAPIKey(req('GET',null,key.apiKey),`/v1/receivers/me/workspaces/${other}/blobs/${object}`),e=>e.status===403);
 await assert.rejects(f.api.authenticateAPIKey(req('POST',null,key.apiKey),'/v1/integrations/keys'),e=>e.status===403);
 await assert.rejects(f.api.authenticateAPIKey(req('GET',null,key.apiKey),'/v1/receivers/me/library'),e=>e.status===403);
 await assert.rejects(handle(f,'/v1/integrations/keys','POST',{service:'redxai-host',workspaceId:wid,scopes:['files:read'],name:'No'}),e=>e.status===409);
 await assert.rejects(handle(f,'/v1/integrations/keys','POST',{service:'redxai-db',workspaceId:wid,scopes:['admin'],name:'No'}),e=>e.status===400);
 await assert.rejects(handle(f,'/v1/integrations/keys','GET',null,{...actor('one'),subject:'forged'}),e=>e.status===403);
});
test('revocation, expiration, read-only entitlement, absent fresh proof fail closed',async()=>{
 const f=fixture(),key=await create(f,['files:read']);
 await assert.rejects(f.api.authenticateAPIKey(req('PUT',null,key.apiKey),`/v1/receivers/me/workspaces/${wid}/blobs/${object}`),e=>e.status===403);
 f.setProof({active:false,readOnly:true,workers:0});await f.api.authenticateAPIKey(req('GET',null,key.apiKey),`/v1/receivers/me/workspaces/${wid}/blobs/${object}`);
 f.setAvailable(false);await assert.rejects(f.api.authenticateAPIKey(req('GET',null,key.apiKey),'/v1/receivers/me'),e=>e.status===503);f.setAvailable(true);
 await assert.rejects(handle(f,'/v1/integrations/keys/'+key.id,'DELETE',undefined,actor('two')),e=>e.status===404);
 await handle(f,'/v1/integrations/keys/'+key.id,'DELETE');await assert.rejects(f.api.authenticateAPIKey(req('GET',null,key.apiKey),'/v1/receivers/me'),e=>e.status===401);
 f.setProof({active:true,readOnly:false,workers:1});const second=await create(f);f.setTime(1000000+90*86400000);await assert.rejects(f.api.authenticateAPIKey(req('GET',null,second.key),'/v1/receivers/me'),e=>e.status===401);
 assert.throws(()=>validateEntitlement({id:wid,active:true,readOnly:false,workers:0,quotaBytes:1,checkedAtMs:0},wid,true,0),e=>e.status===403);
 assert.throws(()=>validateEntitlement({id:wid,active:true,readOnly:false,workers:1,quotaBytes:1,checkedAtMs:0},wid,false,61000),e=>e.status===503);
});
test('BYO metadata has zero hosting fee, no secrets/network requests or paid MachineNote grants',async()=>{
 const f=fixture(),value={name:'Own host',origin:'https://db.fixture',database:'my_storage',pack:'gendragoon'};
 const added=(await handle(f,'/v1/integrations/byo','POST',value)).body.workspace;assert.equal(added.hostingFeeCents,0);assert.equal(added.billingRequired,false);assert.equal(f.calls.length,0);
 assert.equal((await handle(f,'/v1/integrations/byo','GET',undefined,actor('two'))).body.workspaces.length,0);
 for(const extra of [{key:'never-store'},{origin:'https://user:secret@db.fixture'},{origin:'https://db.fixture/path'},{origin:'http://192.168.1.10'},{database:'redxai_accounts'}])await assert.rejects(handle(f,'/v1/integrations/byo','POST',{...value,...extra}),e=>e.status===400);
 const removed=await handle(f,'/v1/integrations/byo/'+added.id,'DELETE');assert.equal(removed.body.externalDataDeleted,false);assert.equal(f.calls.length,0);
});
test('single-use provider grants and S256 authorization return exact QuickLaunch key aliases',async()=>{
 const f=fixture(),input={service:'quick-launcher',workspaceId:wid,scopes:['files:read','files:write'],name:'QuickLaunch'};
 const grant=(await handle(f,'/provider/v1/connect/grants','POST',input)).body.grant;
 assert(!JSON.stringify([...f.metadata.grants.entries()]).includes(grant));
 const exchange=()=>f.api.handlePublic(req('POST',{grant,client_instance:{label:'Fixture',platform:'darwin'}}),new URL('https://fixture/provider/v1/connect/redeem'));
 const results=await Promise.allSettled([exchange(),exchange()]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);const out=results.find(x=>x.status==='fulfilled').value.body;
 assert.match(out.key,/^gdpk_/);assert.equal(out.key,out.apiKey);assert.equal(out.keyId,out.binding.id);assert.equal(out.binding.workspaceId,wid);assert.equal(out.capabilities.legacyBlobAPI,false);
 const healthIdentity=await f.api.authenticateAPIKey(req('GET',null,out.key),'/provider/v1/health');assert.equal((await f.api.handle(req('GET'),new URL('https://fixture/provider/v1/health'),healthIdentity)).body.ok,true);
 const verifier=crypto.randomBytes(48).toString('base64url'),code=(await handle(f,'/provider/v1/connect/authorize','POST',{...input,codeChallengeMethod:'S256',codeChallenge:crypto.createHash('sha256').update(verifier).digest('base64url')})).body.code;
 await assert.rejects(f.api.handlePublic(req('POST',{code,codeVerifier:'x'.repeat(64)}),new URL('https://fixture/provider/v1/connect/token')));
 const good=await f.api.handlePublic(req('POST',{code,codeVerifier:verifier}),new URL('https://fixture/provider/v1/connect/token'));assert.match(good.body.key,/^gdpk_/);
});
test('filtered state and parsed-body guard do not reveal or grant another workspace',()=>{
 const value=filterState({workspaces:[{id:wid,quotaBytes:9,usedBytes:3},{id:other,name:'hidden'}],objects:[{workspace:other}],ownerBenefits:true,projectLimit:10},{apiKey:true,workspaceId:wid});
 assert.equal(value.workspaces.length,1);assert.equal(value.quotaBytes,9);assert.equal(value.ownerBenefits,false);assert.equal(value.objects.length,0);
 assert.throws(()=>routeAccess('/v1/receivers/me/admin','GET',wid),e=>e.status===403);
 const f=fixture();assert.throws(()=>f.api.assertWorkspace({apiKey:true,workspaceId:wid},other),e=>e.status===403);
});
test('RottenApple state binding holds across aliases and self-revocation needs no billing proof',async()=>{
 const f=fixture(),verifier=crypto.randomBytes(48).toString('base64url'),state=crypto.randomBytes(32).toString('base64url');
 const issued=await handle(f,'/provider/v1/connect/authorize','POST',{service:'rottenapple-store',workspaceId:wid,scopes:['files:read'],name:'RottenApple',codeChallengeMethod:'S256',codeChallenge:crypto.createHash('sha256').update(verifier).digest('base64url'),state});
 const code=issued.body.code,exchange=(path,value)=>f.api.handlePublic(req('POST',value),new URL('https://fixture'+path));
 assert(!JSON.stringify([...f.metadata.grants.values()]).includes(state));
 await assert.rejects(exchange('/v1/connect/exchange',{code,pkce_verifier:verifier,state:'wrong'}));
 await assert.rejects(exchange('/provider/v1/connect/token',{code,codeVerifier:verifier}));
 const result=await exchange('/v1/connect/exchange',{code,pkce_verifier:verifier,state});assert.equal(result.body.workspace.db,wid);assert.equal(result.body.scope,'read');assert.equal(result.body.endpoints.revoke,'/v1/connect/revoke');
 f.setAvailable(false);const revoked=await f.api.handlePublic(req('POST',undefined,result.body.key),new URL('https://fixture/v1/connect/revoke'));assert.equal(revoked.body.revoked,true);
 await assert.rejects(f.api.authenticateAPIKey(req('GET',null,result.body.key),'/provider/v1/health'),e=>e.status===401);
});
module.exports={Metadata};
