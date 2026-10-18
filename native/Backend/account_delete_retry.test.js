"use strict";
// Extra deletion cases beyond Morgan's contract file: JSON confirm, Stripe
// cancel failure leaves the job retryable, and a repeat run does not touch
// another account. No network, credentials, or live Stripe.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {createAccountDeletion,registerAccountDeletion}=require("./account_delete");
const uid="delete-me",owner=crypto.createHash("sha256").update(uid).digest("hex"),other="e".repeat(64);
const NOW=1_800_000_000_000;
function hash(value){return crypto.createHash("sha256").update(value).digest("hex");}
function seed(){
 return memoryFirestore([
  ["gd_accounts/"+owner,{stripeCustomerId:"cus_del",uid}],
  ["gd_accounts/"+owner+"/workspaces/w1",{kind:"paid",accountHash:owner,storageSubscriptionId:"sub_s1"}],
  ["gd_accounts/"+owner+"/workspaces/b1",{kind:"byo",accountHash:owner,byoProvider:"s3",byoEndpoint:"https://s3.example",byoSubscriptionId:"sub_b1"}],
  ["tenants/"+owner+"/workspaces/free",{kind:"free",accountKey:owner}],
  ["gd_accounts/"+other+"/workspaces/x1",{kind:"paid",accountHash:other,storageSubscriptionId:"sub_other"}],
  ["project_payments/pi_keep",{accountHash:owner,workspaceId:"w1",amount:500}],
 ]);
}
function world(overrides={}){
 const db=seed();
 const objects=new Set(["customer/"+owner+"/managed/w1/a.bin","tenants/"+owner+"/free/c.bin","customer/"+other+"/managed/x1/keep.bin"]);
 const canceled=[];
 const subs=[{id:"sub_s1",status:"active",customer:"cus_del"},{id:"sub_b1",status:"active",customer:"cus_del"},{id:"sub_other",status:"active",customer:"cus_other"}];
 let failures=overrides.stripeFailures||0;
 const stripe={subscriptions:{
  list:async query=>{
   assert.equal(query.customer,"cus_del");
   return {has_more:false,data:subs.filter(s=>s.customer===query.customer&&s.status!=="canceled")};
  },
  cancel:async id=>{
   if(failures>0){failures-=1;throw Object.assign(Error("stripe unavailable"),{code:"api_connection_error"});}
   canceled.push(id);
   const sub=subs.find(s=>s.id===id);
   if(sub)sub.status="canceled";
   return sub;
  }},
  invoices:{create:async()=>assert.fail("no charges")},
  paymentIntents:{create:async()=>assert.fail("no charges")}};
 const bucket={objects,deleteFiles:async({prefix})=>{for(const key of [...objects])if(key.startsWith(prefix))objects.delete(key);}};
 const users=new Set([uid]);
 const auth={deletedUsers:[],revokeRefreshTokens:async u=>{if(!users.has(u))throw Object.assign(Error("gone"),{code:"auth/user-not-found"});},
  deleteUser:async u=>{if(!users.has(u))throw Object.assign(Error("gone"),{code:"auth/user-not-found"});users.delete(u);auth.deletedUsers.push(u);},
  verifyIdToken:async t=>{if(!users.has(t))throw Object.assign(Error("revoked"),{code:"auth/id-token-revoked"});return {uid:t};}};
 const byoCalls=[];
 const byoProviders=new Proxy({},{get:(_,name)=>(...args)=>{byoCalls.push([name,args]);}});
 const svc=createAccountDeletion({db,stripe,bucket,auth,byoProviders,hash,now:()=>NOW,...overrides.deps});
 const fresh={user:{uid,auth_time:Math.floor(NOW/1000)-60}};
 return {db,svc,fresh,canceled,subs,objects,auth,byoCalls,users};
}
async function untilDone(svc,jobId){
 const deadline=Date.now()+5000;
 let job;
 do{
  job=await svc.jobStatus(jobId);
  if(job?.status==="done"||job?.status==="failed")return job;
  await new Promise(r=>setTimeout(r,10));
 }while(Date.now()<deadline);
 assert.fail("job did not settle");
}
test("account delete: a JSON body without confirm:'DELETE' is refused before any deletion",async()=>{
 const f=world();
 await assert.rejects(f.svc.deleteAccount({...f.fresh,body:{}}),{status:400,code:"confirm_required"});
 await assert.rejects(f.svc.deleteAccount({...f.fresh,body:{confirm:"delete"}}),{status:400,code:"confirm_required"});
 assert.equal(f.canceled.length,0);
 assert.equal(f.auth.deletedUsers.length,0);
 assert.ok(f.objects.has("customer/"+owner+"/managed/w1/a.bin"));
 const ok=await f.svc.deleteAccount({...f.fresh,body:{confirm:"DELETE"}});
 assert.equal(ok.status,202);
 assert.equal((await untilDone(f.svc,ok.jobId)).status,"done");
});
test("account delete: Stripe cancel failure leaves the job retryable and a later call finishes",async()=>{
 const f=world({stripeFailures:1});
 const first=await f.svc.deleteAccount(f.fresh);
 assert.equal(first.status,202);
 const failed=await untilDone(f.svc,first.jobId);
 assert.equal(failed.status,"failed");
 assert.equal(failed.retryable,true);
 assert.equal(f.auth.deletedUsers.length,0,"user stays until cancellation succeeds");
 assert.ok(f.objects.has("customer/"+owner+"/managed/w1/a.bin"));
 const second=await f.svc.deleteAccount(f.fresh);
 assert.equal(second.status,202);
 assert.equal(second.jobId,first.jobId);
 const done=await untilDone(f.svc,second.jobId);
 assert.equal(done.status,"done");
 assert.deepEqual([...f.canceled].sort(),["sub_b1","sub_s1"]);
 assert.equal(f.subs.find(s=>s.id==="sub_other").status,"active");
 assert.deepEqual(f.auth.deletedUsers,[uid]);
 assert.deepEqual(f.byoCalls,[]);
 assert.deepEqual([...f.objects],[ "customer/"+other+"/managed/x1/keep.bin"]);
 assert.ok(f.db.rows.has("gd_accounts/"+other+"/workspaces/x1"));
 assert.equal([...f.db.rows.keys()].some(k=>k.startsWith("billing_receipts/")),true);
 assert.equal([...f.db.rows.keys()].some(k=>k.includes(owner)&&k.includes("/workspaces/")),false);
});
test("account delete: exactly five minutes of auth_time is still fresh",async()=>{
 const f=world();
 const res=await f.svc.deleteAccount({user:{uid,auth_time:Math.floor(NOW/1000)-5*60}});
 assert.equal(res.status,202);
 assert.equal((await untilDone(f.svc,res.jobId)).status,"done");
});
test("GET /v2/account/deletions/:jobId reports the polled job without the Firebase user",async()=>{
 const db=memoryFirestore();
 const stripe={subscriptions:{list:async()=>({has_more:false,data:[]}),cancel:async()=>({})}};
 const bucket={deleteFiles:async()=>{}};
 const auth={deleteUser:async()=>{},revokeRefreshTokens:async()=>{}};
 const app=express();
 app.use(express.json());
 const svc=registerAccountDeletion({app,firebaseAuth:(req,_res,next)=>{req.user={uid,auth_time:Math.floor(NOW/1000)-30};next();},
  db,stripe,bucket,auth,byoProviders:{},hash,now:()=>NOW});
 const server=app.listen(0,"127.0.0.1");
 await new Promise(r=>server.once("listening",r));
 try{
  const base="http://127.0.0.1:"+server.address().port;
  const created=await fetch(base+"/v2/account",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm:"DELETE"})});
  assert.equal(created.status,202);
  const body=await created.json();
  assert.equal(body.status,"deleting");
  const deadline=Date.now()+5000;
  let status;
  do{
   const polled=await fetch(base+"/v2/account/deletions/"+body.jobId);
   assert.equal(polled.status,200);
   status=await polled.json();
   if(status.status==="done")break;
   await new Promise(r=>setTimeout(r,10));
  }while(Date.now()<deadline);
  assert.equal(status.status,"done");
  assert.equal((await svc.jobStatus(body.jobId)).status,"done");
  const missing=await fetch(base+"/v2/account/deletions/00000000-0000-4000-8000-000000000000");
  assert.equal(missing.status,404);
 }finally{server.close();}
});
