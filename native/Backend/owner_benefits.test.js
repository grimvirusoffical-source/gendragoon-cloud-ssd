'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {eligible,grantOwnerBenefits,OWNER_EMAIL,LEGACY_OWNER_EMAIL}=require('./owner_benefits');
const user={uid:'owner-redxai-uid',email:OWNER_EMAIL,email_verified:true,firebase:{sign_in_provider:'redxai'},__identity:{provider:'redxai'}};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function fixture(){
 const records=new Map();const ref=path=>({path,collection:n=>ref(path+'/'+n),doc:n=>ref(path+'/'+n)});
 let queue=Promise.resolve();
 const db={collection:ref,runTransaction:fn=>{const pending=queue.then(()=>fn({
   get:async r=>({exists:records.has(r.path),data:()=>records.get(r.path)}),
   create:(r,v)=>{assert.equal(records.has(r.path),false);records.set(r.path,v)},
   set:(r,v,{merge}={})=>records.set(r.path,merge?{...(records.get(r.path)||{}),...v}:v),
   update:(r,v)=>records.set(r.path,{...(records.get(r.path)||{}),...v})
 }));queue=pending.catch(()=>{});return pending;}};
 return {records,grant:u=>grantOwnerBenefits({user:u,db,hash,stamp:()=>123})};
}
test('owner identity requires exact verified support email and Red-XAI or Google provider',async()=>{
 assert.equal(eligible(user),true);
 assert.equal(eligible({...user,firebase:{sign_in_provider:'google.com'},__identity:undefined}),true);
 for(const bad of [{...user,email:'other@infected-nation.com'},{...user,email_verified:false},{...user,firebase:{sign_in_provider:'password'},__identity:undefined},
   {...user,uid:''},{...user,email:LEGACY_OWNER_EMAIL},{}]){
  assert.equal(eligible(bad),false);const f=fixture();assert.equal(await f.grant(bad),false);assert.equal(f.records.size,0);
 }
});
test('verified support owner receives 6TB + Max lifetime entitlement once under concurrent requests',async()=>{
 const f=fixture();assert.deepEqual(await Promise.all(Array.from({length:20},()=>f.grant(user))),Array(20).fill(true));
 assert.equal(f.records.size,2);const ws=[...f.records.values()].find(x=>x.kind==='paid');
 assert.equal(ws.storageTier,'6TB');assert.equal(ws.performanceTier,'max');assert.equal(ws.quotaBytes,6_000_000_000_000);
 assert.equal(ws.provisioned,true);assert.equal(ws.storageActive,true);assert.equal(ws.performanceActive,true);
 assert.equal(ws.ownerLifetime,true);assert.equal(ws.projectFeeStatus,'owner');
 ws.usedBytes=542;ws.reservedBytes=123;await f.grant(user);assert.equal(ws.usedBytes,542);assert.equal(ws.reservedBytes,123);
});
test('owner binding cannot be claimed by another UID with the same support email',async()=>{
 const f=fixture();await f.grant(user);assert.equal(await f.grant({...user,uid:'another-uid'}),false);assert.equal(f.records.size,2);
});
test('legacy Gmail owner binding migrates exactly once to support Red-XAI account',async()=>{
 const f=fixture();f.records.set('system/owner-benefits-v1',{uid:'old-google-uid',email:LEGACY_OWNER_EMAIL,grantVersion:1});
 assert.equal(await f.grant(user),true);
 const policy=f.records.get('system/owner-benefits-v1');assert.equal(policy.uid,user.uid);assert.equal(policy.email,OWNER_EMAIL);assert.equal(policy.previousUid,'old-google-uid');
 assert.equal(await f.grant({...user,uid:'different-redx-uid'}),false);
});
test('disabled policy prevents a new grant',async()=>{const f=fixture();f.records.set('system/owner-benefits-v1',{disabled:true});assert.equal(await f.grant(user),false);assert.equal(f.records.size,1);});
