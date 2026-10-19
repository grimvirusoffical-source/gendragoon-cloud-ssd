"use strict";
// G7: account deletion removes /provider/v1 records and objects of that account only.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {memoryFirestore}=require("./test_firestore");
const {createAccountDeletion}=require("./account_delete");
const {deleteAccountProviderData,providerObjectRoot,COLL}=require("./provider_v1");
const uid="provider-owner",owner=crypto.createHash("sha256").update(uid).digest("hex"),other="e".repeat(64);
const NOW=1_800_000_000_000;
function providerRows(hash,binding){
 return [[COLL.bindings+"/"+binding,{id:binding,ownerHash:hash,revokedAtMs:null}],
  [COLL.keys+"/"+binding.slice(0,16).replace(/-/g,"0"),{bindingId:binding,digest:"0".repeat(64)}],
  [COLL.envelopes+"/"+binding,{bindingId:binding,ownerHash:hash,envelope:{version:1}}],
  [COLL.grants+"/"+"a".repeat(63)+binding.at(-1),{ownerHash:hash,kind:"grant"}],
  [COLL.audit+"/"+binding,{ownerHash:hash,event:"connect.exchange"}]];
}
const mine="11111111-1111-4111-8111-111111111111",theirs="22222222-2222-4222-8222-222222222222";
test("deleteAccountProviderData removes only that account's bindings, keys, envelopes, grants and audit rows",async()=>{
 const db=memoryFirestore([...providerRows(owner,mine),...providerRows(other,theirs)]);
 const out=await deleteAccountProviderData(db,owner);
 assert.equal(out.bindings,1);
 const left=[...db.rows.keys()];
 assert.ok(left.every(k=>!k.endsWith(mine)&&!k.includes(mine.slice(0,16).replace(/-/g,"0"))),left.join("\n"));
 assert.equal(left.filter(k=>k.startsWith("gd_provider_")).length,5,"other account untouched");
 assert.deepEqual(await deleteAccountProviderData(db,"not-a-hash"),{bindings:0});
});
test("provider objects sit inside the customer/<accountHash>/ prefix that account deletion already removes",()=>{
 assert.ok(providerObjectRoot(owner).startsWith("customer/"+owner+"/"));
});
test("full account deletion job also clears provider data",async()=>{
 const db=memoryFirestore([["gd_accounts/"+owner,{}],["tenants/"+owner+"/workspaces/free",{kind:"free",accountKey:owner}],
  ...providerRows(owner,mine),...providerRows(other,theirs)]);
 const objects=new Set([providerObjectRoot(owner)+mine+"/b/"+"c".repeat(64),providerObjectRoot(other)+theirs+"/b/"+"c".repeat(64)]);
 const bucket={objects,deleteFiles:async({prefix})=>{for(const k of [...objects])if(k.startsWith(prefix))objects.delete(k);},
  getFiles:async({prefix})=>[[...objects].filter(k=>k.startsWith(prefix)).map(name=>({name}))],file:name=>({delete:async()=>objects.delete(name)})};
 const stripe={subscriptions:{list:async()=>({has_more:false,data:[]}),cancel:async()=>({})}};
 const users=new Set([uid]);
 const auth={deleteUser:async u=>{users.delete(u);},verifyIdToken:async t=>({uid:t})};
 const svc=createAccountDeletion({db,stripe,bucket,auth,byoProviders:{},hash:u=>crypto.createHash("sha256").update(u).digest("hex"),now:()=>NOW});
 const res=await svc.deleteAccount({user:{uid,auth_time:Math.floor(NOW/1000)-30}});
 assert.equal(res.status,202);
 let job;for(let i=0;i<500;i++){job=await svc.jobStatus(res.jobId);if(job.status==="done"||job.status==="failed")break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(job.status,"done");
 assert.equal([...db.rows.keys()].filter(k=>k.startsWith("gd_provider_")&&(db.rows.get(k).ownerHash===owner||k.endsWith(mine))).length,0);
 assert.equal([...db.rows.keys()].filter(k=>k.startsWith("gd_provider_")).length,5);
 assert.deepEqual([...objects],[providerObjectRoot(other)+theirs+"/b/"+"c".repeat(64)]);
});
