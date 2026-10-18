"use strict";
// Contract tests for DELETE /v1/account (Avery's spec; Riley implements).
// The endpoint does not exist yet on codex/native-integration-20261017, so every
// test is {todo}: it runs and fails honestly until ./account_delete.js lands.
// Assumed module shape (adjust to Riley's implementation when it lands):
//   const {createAccountDeletion}=require("./account_delete");
//   const svc=createAccountDeletion({db,stripe,bucket,auth,byoProviders,hash,now});
//   await svc.deleteAccount({user:{uid,auth_time}})  -> {deleted:true,...}
// No credentials or network: in-memory Firestore, recording stubs for Stripe,
// bucket, Firebase Auth and BYO providers.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {memoryFirestore}=require("./test_firestore");
const TODO="DELETE /v1/account not built yet (Riley): expected fail until account_delete.js exists";
const uid="delete-me",owner=crypto.createHash("sha256").update(uid).digest("hex"),other="d".repeat(64);
const NOW=1_800_000_000_000;
function load(){
  try{return require("./account_delete").createAccountDeletion;}
  catch(e){if(e.code==="MODULE_NOT_FOUND")assert.fail("account_delete.js not implemented");throw e;}
}
function fixture(){
  const db=memoryFirestore([
    ["gd_accounts/"+owner,{stripeCustomerId:"cus_del"}],
    ["gd_accounts/"+owner+"/workspaces/w1",{kind:"paid",accountHash:owner,storageSubscriptionId:"sub_s1",storageStatus:"active"}],
    ["gd_accounts/"+owner+"/workspaces/w2",{kind:"paid",accountHash:owner,performanceSubscriptionId:"sub_p1",performanceStatus:"active"}],
    ["gd_accounts/"+owner+"/workspaces/b1",{kind:"byo",accountHash:owner,byoProvider:"s3",byoEndpoint:"https://s3.example",byoSubscriptionId:"sub_b1",byoStatus:"active"}],
    ["tenants/"+owner+"/workspaces/free",{kind:"free",accountKey:owner}],
    ["gd_accounts/"+other+"/workspaces/x1",{kind:"paid",accountHash:other}],
  ]);
  const objects=new Set(["customer/"+owner+"/managed/w1/a.bin","customer/"+owner+"/managed/w2/b.bin","tenants/"+owner+"/free/c.bin","customer/"+other+"/managed/x1/keep.bin"]);
  const canceled=[];const subs=["sub_s1","sub_p1","sub_b1"].map(id=>({id,status:"active",customer:"cus_del"}));
  const stripe={subscriptions:{
    list:async()=>({has_more:false,data:subs.filter(s=>s.status!=="canceled")}),
    cancel:async id=>{canceled.push(id);const s=subs.find(x=>x.id===id);if(s)s.status="canceled";return s;}},
    invoices:{create:async()=>assert.fail("no new charges during deletion")},
    paymentIntents:{create:async()=>assert.fail("no new charges during deletion")}};
  const bucket={objects,deleteFiles:async({prefix})=>{for(const k of [...objects])if(k.startsWith(prefix))objects.delete(k);},
    getFiles:async({prefix})=>[[...objects].filter(k=>k.startsWith(prefix)).map(name=>({name}))],
    file:name=>({delete:async()=>objects.delete(name)})};
  const users=new Set([uid]);
  const auth={deletedUsers:[],deleteUser:async u=>{if(!users.has(u))throw Object.assign(Error("no user"),{code:"auth/user-not-found"});users.delete(u);auth.deletedUsers.push(u);},
    verifyIdToken:async t=>{if(!users.has(t))throw Object.assign(Error("revoked"),{code:"auth/user-not-found"});return {uid:t};}};
  const byoCalls=[];const byoProviders=new Proxy({},{get:(_,name)=>(...a)=>{byoCalls.push([name,a]);}});
  const createAccountDeletion=load();
  const svc=createAccountDeletion({db,stripe,bucket,auth,byoProviders,hash:u=>crypto.createHash("sha256").update(u).digest("hex"),now:()=>NOW});
  const fresh={user:{uid,auth_time:Math.floor(NOW/1000)-60}};
  return {db,svc,fresh,canceled,subs,objects,auth,byoCalls};
}
test("account delete: stale authentication is refused and nothing is deleted",{todo:TODO},async()=>{
  const f=fixture();
  await assert.rejects(f.svc.deleteAccount({user:{uid,auth_time:Math.floor(NOW/1000)-3600}}),e=>e.status===401||e.status===403);
  assert.equal(f.canceled.length,0);assert.equal(f.auth.deletedUsers.length,0);
  assert.ok(f.db.rows.has("gd_accounts/"+owner+"/workspaces/w1"));
});
test("account delete: cancels every Stripe subscription for the account and creates no charges",{todo:TODO},async()=>{
  const f=fixture();await f.svc.deleteAccount(f.fresh);
  assert.deepEqual([...f.canceled].sort(),["sub_b1","sub_p1","sub_s1"]);
  assert.ok(f.subs.every(s=>s.status==="canceled"));
});
test("account delete: removes every hosted workspace record and zero objects remain under the account prefix",{todo:TODO},async()=>{
  const f=fixture();await f.svc.deleteAccount(f.fresh);
  const left=[...f.db.rows.keys()].filter(k=>k.includes(owner)&&k.includes("/workspaces/")&&!k.endsWith("/b1"));
  assert.deepEqual(left,[]);
  assert.deepEqual([...f.objects].filter(k=>k.includes(owner)),[]);
  assert.ok(f.objects.has("customer/"+other+"/managed/x1/keep.bin"),"other accounts untouched");
  assert.ok(f.db.rows.has("gd_accounts/"+other+"/workspaces/x1"));
});
test("account delete: deletes the Firebase user so the old token is rejected",{todo:TODO},async()=>{
  const f=fixture();await f.svc.deleteAccount(f.fresh);
  assert.deepEqual(f.auth.deletedUsers,[uid]);
  await assert.rejects(f.auth.verifyIdToken(uid));
});
test("account delete: bring-your-own storage is never touched",{todo:TODO},async()=>{
  const f=fixture();await f.svc.deleteAccount(f.fresh);
  assert.deepEqual(f.byoCalls,[],"no calls to BYO provider stubs");
});
test("account delete: second call is idempotent and safe",{todo:TODO},async()=>{
  const f=fixture();await f.svc.deleteAccount(f.fresh);const before=f.canceled.length;
  await f.svc.deleteAccount(f.fresh).catch(e=>assert.ok([401,404,410].includes(e.status),"second call must not 500"));
  assert.equal(f.canceled.length,before);assert.deepEqual(f.auth.deletedUsers,[uid]);
});
