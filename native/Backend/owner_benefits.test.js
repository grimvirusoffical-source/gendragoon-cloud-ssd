'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {eligible,grantOwnerBenefits}=require('./owner_benefits');
const user={uid:'owner-google-uid',email:'grimvirusoffical@gmail.com',email_verified:true,firebase:{sign_in_provider:'google.com'}};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function fixture(){
 const records=new Map();const ref=path=>({path,collection:n=>ref(path+'/'+n),doc:n=>ref(path+'/'+n)});
 let queue=Promise.resolve();
 const db={collection:ref,runTransaction:fn=>{const pending=queue.then(()=>fn({get:async r=>({exists:records.has(r.path),data:()=>records.get(r.path)}),create:(r,v)=>{assert.equal(records.has(r.path),false);records.set(r.path,v)}}));queue=pending.catch(()=>{});return pending;}};
 return {records,grant:u=>grantOwnerBenefits({user:u,db,hash,stamp:()=>123})};
}
test('owner identity requires exact verified email and Google provider',async()=>{
 for(const bad of [{...user,email:'other@gmail.com'},{...user,email_verified:false},{...user,firebase:{sign_in_provider:'password'}},{...user,uid:''},{...user,email:'grimvirusofficial@gmail.com'},{}]){assert.equal(eligible(bad),false);const f=fixture();assert.equal(await f.grant(bad),false);assert.equal(f.records.size,0);}
});
test('verified owner receives maximum workspace once under concurrent requests',async()=>{
 const f=fixture();assert.deepEqual(await Promise.all(Array.from({length:20},()=>f.grant(user))),Array(20).fill(true));
 assert.equal(f.records.size,2);const ws=[...f.records.values()].find(x=>x.kind==='paid');assert.equal(ws.storageTier,'6TB');assert.equal(ws.performanceTier,'max');assert.equal(ws.provisioned,true);assert.equal(ws.storageActive,true);
 ws.usedBytes=542;ws.reservedBytes=123;await f.grant(user);assert.equal(ws.usedBytes,542);assert.equal(ws.reservedBytes,123);
});
test('owner binding cannot be claimed by another UID with the same email',async()=>{const f=fixture();await f.grant(user);assert.equal(await f.grant({...user,uid:'another-uid'}),false);assert.equal(f.records.size,2);});
test('disabled policy prevents a new grant',async()=>{const f=fixture();f.records.set('system/owner-benefits-v1',{disabled:true});assert.equal(await f.grant(user),false);assert.equal(f.records.size,1);});
