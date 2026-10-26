'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createCloud}=require('../server.cjs');
const {digest}=require('../redx-state.cjs');
const issuer='https://red-xai.com',subject='integration-owner',owner=digest(JSON.stringify(['red-xai-receiver/v1',issuer,subject])),one='a'.repeat(32),two='b'.repeat(32);
class Ledger{
 constructor(){this.state={schema:2,id:owner,owner,revision:0,quota:200000,used:0,ownerBenefits:true,workspaces:{[one]:{id:one,name:'Key-bound note',billingManaged:true,active:true,readOnly:false,quotaBytes:100000,usedBytes:0,workers:8},[two]:{id:two,name:'PRIVATE-OTHER-NOTE',billingManaged:true,active:true,readOnly:false,quotaBytes:100000,usedBytes:0,workers:12}},objects:{},reservations:{},library:{['c'.repeat(18)]:{key:'c'.repeat(18),workspace:two,name:'PRIVATE-OTHER-FILE',kind:'file'}}};}
 async get(id){return id===owner?structuredClone(this.state):null;}
 async change(id,fn){assert.equal(id,owner);const s=structuredClone(this.state);fn(s);s.revision++;this.state=s;return structuredClone(s);}
}
class Metadata{
 constructor(){this.accounts=new Map();this.links=new Map();}
 async account(id){return structuredClone(this.accounts.get(id)||{keys:{},byo:{}});}
 async update(id,fn){const s=await this.account(id);fn(s);this.accounts.set(id,s);return structuredClone(s);}
 async linkKey(id,account){this.links.set(id,account);}
 async ownerForKey(id){return this.links.get(id)||null;}
}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'gd-key-receiver-')),store=new Ledger(),metadata=new Metadata(),proof={id:one,active:true,readOnly:false,quotaBytes:150000,workers:2,checkedAtMs:Date.now()},authorizations=[],trust={mode:'normal'};
 const session='rxca_'+'S'.repeat(43);
 const cloud=await createCloud({root,issuer,authProvider:'redx-site-session',store,integrationOptions:{metadata},authorizeWorkspace:async(identity,id)=>{authorizations.push({identity,id});if(trust.mode==='offline')throw Error('fixture offline');return id===one&&trust.mode!=='missing'?{...proof,checkedAtMs:Date.now()-(trust.mode==='stale'?61000:0)}:null;},fetchImpl:async(url,options)=>{assert.equal(options.headers.authorization,'Bearer '+session,'API keys must not be forwarded as user sessions');return Response.json({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:subject,email:'support@infected-nation.com',email_verified:true});}});
 const api=await cloud.listen();t.after(async()=>{await cloud.close();await fs.rm(root,{recursive:true,force:true});});
 async function call(token,route,method='GET',value){const r=await fetch(api+route,{method,headers:{authorization:'Bearer '+token,...(value!==undefined?{'content-type':'application/json'}:{})},body:value===undefined?undefined:JSON.stringify(value)});return {status:r.status,body:await r.json()};}
 async function key(scopes=['files:read','files:write']){const r=await call(session,'/v1/integrations/keys','POST',{name:'Fixture key',service:'redxai-db',workspaceId:one,scopes});assert.equal(r.status,201,JSON.stringify(r.body));return r.body;}
 return {root,store,metadata,proof,trust,authorizations,session,call,key};
}
test('delegated keys filter account views, preserve other notes and have no admin/team/key-management authority',async t=>{
 const f=await fixture(t),issued=await f.key(),other=structuredClone(f.store.state.workspaces[two]);
 const r=await f.call(issued.apiKey,'/v1/receivers/me');assert.equal(r.status,200);assert.deepEqual(r.body.workspaces.map(w=>w.id),[one]);assert.equal(r.body.ownerBenefits,false);assert.equal(r.body.workspaces[0].workers,2);assert.equal(r.body.workspaces[0].quotaBytes,150000);
 assert.ok(!JSON.stringify(r.body).includes('PRIVATE-OTHER'));assert.deepEqual(f.store.state.workspaces[two],other);assert.equal(f.store.state.ownerBenefits,true,'storage delegation must not rewrite account admin/owner flags');
 for(const route of ['/v1/receivers/admin/machine-notes','/v1/receivers/me/dev-profile','/v1/receivers/me/dev-teams','/v1/integrations/keys','/v1/integrations/byo','/v1/receivers/me/library'])assert.equal((await f.call(issued.apiKey,route)).status,403,route);
 assert.equal((await f.call(issued.apiKey,`/v1/receivers/me/workspaces/${two}/library`)).status,403);
 assert.equal((await f.call(issued.apiKey,`/v1/receivers/me/workspaces/${two}/blobs/${'d'.repeat(32)}`)).status,403);
 assert.ok(f.authorizations.every(x=>x.identity.owner===owner&&x.identity.issuer===issuer&&x.identity.subject===subject));
});
test('library body and existing-item checks prevent a key from modifying another MachineNote',async t=>{
 const f=await fixture(t),issued=await f.key(),token=issued.apiKey;
 let r=await f.call(token,'/v1/receivers/me/library/operations','POST',{workspace:two,operation:'mkdir',name:'forbidden',expectedRevision:0});assert.equal(r.status,403);assert.equal(r.body.error,'integration_workspace_forbidden');
 r=await f.call(token,'/v1/receivers/me/library/'+'c'.repeat(18),'DELETE');assert.equal(r.status,403);assert.ok(f.store.state.library['c'.repeat(18)]);
 r=await f.call(token,'/v1/receivers/me/library/'+'e'.repeat(18),'PUT',{workspace:two,name:'forbidden',kind:'file',manifestId:'f'.repeat(32),archiveBytes:10,archiveSha256:'0'.repeat(64)});assert.equal(r.status,403);
 r=await f.call(token,`/v1/receivers/me/workspaces/${one}/library`);assert.equal(r.status,200);assert.deepEqual(r.body.items,[]);
});
test('revocation is checked on the next request and read-only scopes cannot mutate',async t=>{
 const f=await fixture(t),issued=await f.key(['files:read']);
 assert.equal((await f.call(issued.apiKey,'/v1/receivers/me/library/'+'c'.repeat(18),'DELETE')).status,403);
 assert.equal((await f.call(f.session,'/v1/integrations/keys/'+issued.id,'DELETE')).status,200);
 assert.equal((await f.call(issued.apiKey,'/v1/receivers/me')).status,401);
});
test('missing or stale trusted billing proof fails closed without mutating other notes',async t=>{
 const f=await fixture(t),issued=await f.key(),before=structuredClone(f.store.state);
 f.proof.active=false;f.proof.readOnly=true;f.proof.quotaBytes=0;f.proof.workers=0;
 assert.equal((await f.call(issued.apiKey,'/v1/receivers/me/library/operations','POST',{workspace:one,operation:'mkdir',name:'no',expectedRevision:0})).status,403);
 assert.deepEqual(f.store.state,before);
 Object.assign(f.proof,{active:true,readOnly:false,quotaBytes:150000,workers:2});
 for(const mode of ['missing','stale','offline']){f.trust.mode=mode;assert.equal((await f.call(issued.apiKey,'/v1/receivers/me')).status,503);assert.deepEqual(f.store.state,before);}
});
