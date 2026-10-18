"use strict";
// Contract tests for DELETE /v2/account (Avery's spec; Riley implements).
// Contract: 202 + job id, job polled until done; recent sign-in window 5 min;
// stale auth refused immediately (no job); second call 410 once the user is gone.
//   const {createAccountDeletion}=require("./account_delete");
//   const svc=createAccountDeletion({db,stripe,bucket,auth,byoProviders,hash,now});
//   await svc.deleteAccount({user:{uid,auth_time}})  -> {status:202,jobId}
//   await svc.jobStatus(jobId) -> {status:"queued"|"running"|"done"|"failed"}
//   registerAccountDeletion({app,...same deps,firebaseAuth}) mounts DELETE /v2/account
// No credentials or network: in-memory Firestore, recording stubs for Stripe,
// bucket, Firebase Auth and BYO providers.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {memoryFirestore}=require("./test_firestore");
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
  const at=min=>({user:{uid,auth_time:Math.floor(NOW/1000)-min*60}});const fresh=at(1);
  return {db,svc,fresh,at,canceled,subs,objects,auth,byoCalls};
}
async function runToDone(f,req){
  const res=await f.svc.deleteAccount(req);
  assert.equal(res.status,202);assert.equal(typeof res.jobId,"string");assert.ok(res.jobId.length>0);
  const deadline=Date.now()+5000;let job;
  do{job=await f.svc.jobStatus(res.jobId);if(job.status==="done")return res;if(job.status==="failed")assert.fail("deletion job failed");await new Promise(r=>setTimeout(r,10));}
  while(Date.now()<deadline);
  assert.fail("deletion job did not finish within 5s (last status "+job?.status+")");
}
function untouched(f){
  assert.equal(f.canceled.length,0);assert.equal(f.auth.deletedUsers.length,0);
  assert.ok(f.db.rows.has("gd_accounts/"+owner+"/workspaces/w1"));assert.ok(f.objects.has("customer/"+owner+"/managed/w1/a.bin"));
}
test("account delete: stale authentication (6 min) is refused immediately with no job and nothing deleted",async()=>{
  const f=fixture();
  await assert.rejects(f.svc.deleteAccount(f.at(6)),e=>(e.status===401||e.status===403)&&!e.jobId);
  untouched(f);
});
test("account delete: 5-minute window boundary: 4 min accepted (202), 6 min refused",async()=>{
  const f=fixture();await assert.rejects(f.svc.deleteAccount(f.at(6)),e=>e.status===401||e.status===403);untouched(f);
  await runToDone(f,f.at(4));assert.deepEqual(f.auth.deletedUsers,[uid]);
});
test("account delete: after the job completes every Stripe subscription is cancelled and no charges are created",async()=>{
  const f=fixture();await runToDone(f,f.fresh);
  assert.deepEqual([...f.canceled].sort(),["sub_b1","sub_p1","sub_s1"]);
  assert.ok(f.subs.every(s=>s.status==="canceled"));
});
test("account delete: after the job completes no hosted workspace records and zero objects remain under the account prefix",async()=>{
  const f=fixture();await runToDone(f,f.fresh);
  const left=[...f.db.rows.keys()].filter(k=>k.includes(owner)&&k.includes("/workspaces/")&&!k.endsWith("/b1"));
  assert.deepEqual(left,[]);
  assert.deepEqual([...f.objects].filter(k=>k.includes(owner)),[]);
  assert.ok(f.objects.has("customer/"+other+"/managed/x1/keep.bin"),"other accounts untouched");
  assert.ok(f.db.rows.has("gd_accounts/"+other+"/workspaces/x1"));
});
test("account delete: after the job completes the Firebase user is deleted and the old token is rejected",async()=>{
  const f=fixture();await runToDone(f,f.fresh);
  assert.deepEqual(f.auth.deletedUsers,[uid]);
  await assert.rejects(f.auth.verifyIdToken(uid));
});
test("account delete: bring-your-own storage is never touched",async()=>{
  const f=fixture();await runToDone(f,f.fresh);
  assert.deepEqual(f.byoCalls,[],"no calls to BYO provider stubs");
});
test("account delete: second call returns 410 after the user is gone and repeats no side effects",async()=>{
  const f=fixture();const started=await runToDone(f,f.fresh);const before=f.canceled.length;
  await assert.rejects(f.svc.deleteAccount(f.fresh),error=>{
    assert.equal(error.status,410);
    assert.equal(error.code,"account_deleted");
    assert.equal(error.jobId,started.jobId);
    assert.match(error.statusToken,/^[A-Za-z0-9_-]{43}$/);
    return true;
  });
  assert.equal(f.canceled.length,before);assert.deepEqual(f.auth.deletedUsers,[uid]);
});
test("account deletion removes every workspace and does not move the free slot onto one of them",async()=>{
  const {createProjectService}=require("./projects");
  const slotUid="slot-owner",slotOwner=crypto.createHash("sha256").update(slotUid).digest("hex");
  const idFor=n=>"12345678-1234-4000-8000-"+String(n).padStart(12,"0");
  const db=memoryFirestore([["gd_accounts/"+slotOwner,{stripeCustomerId:"cus_slot"}]]);
  const price={id:"price_month",active:true,type:"recurring",recurring:{interval:"month"},currency:"usd",unit_amount:500,billing_scheme:"per_unit",livemode:false,product:{active:true}};
  const projectStripe={prices:{retrieve:async()=>({...price})},checkout:{sessions:{create:async()=>({id:"cs_month",url:"https://checkout.stripe.com/c/pay/cs_month",status:"open"}),retrieve:async()=>{throw Error("missing");}}}};
  const env={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_WORKSPACE_MONTHLY_READY:"true",STRIPE_WORKSPACE_MONTHLY_PRICE_ID:"price_month",STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example"};
  const projects=createProjectService({db,stamp:()=>1_700_000_000_000,hash:()=>slotOwner,stripe:projectStripe,env,ensureCustomer:async()=>"cus_slot"});
  const req={user:{uid:slotUid}};
  await projects.create(req,{name:"Free",intentId:idFor(1)});
  await projects.create(req,{name:"Paid",intentId:idFor(2)});
  const paidKey="gd_accounts/"+slotOwner+"/workspaces/"+idFor(2);
  assert.equal(db.rows.get("gd_accounts/"+slotOwner).freeWorkspaceId,idFor(1));
  assert.equal(db.rows.get(paidKey).projectFeeStatus,"pending");
  const writes=[];
  const rawSet=db.rows.set.bind(db.rows);
  db.rows.set=(key,value)=>{writes.push([key,structuredClone(value)]);return rawSet(key,value);};
  const svc=load()({db,stripe:{subscriptions:{list:async()=>({has_more:false,data:[]}),cancel:async()=>({})}},
    bucket:{deleteFiles:async()=>{},getFiles:async()=>[[]]},auth:{deleteUser:async()=>{}},byoProviders:{},
    hash:u=>crypto.createHash("sha256").update(u).digest("hex"),now:()=>NOW});
  const started=await svc.deleteAccount({user:{uid:slotUid,auth_time:Math.floor(NOW/1000)-30}});
  const deadline=Date.now()+5000;let job;
  do{job=await svc.jobStatus(started.jobId);if(job.status==="done"||job.status==="failed")break;await new Promise(r=>setTimeout(r,10));}
  while(Date.now()<deadline);
  assert.equal(job.status,"done");
  assert.equal(writes.some(([key,value])=>key===paidKey&&value.projectFeeStatus==="free"),false);
  assert.equal(writes.some(([,value])=>value&&value.freeWorkspaceId===idFor(2)),false);
  assert.equal(db.rows.has(paidKey),false);
  assert.equal(db.rows.has("gd_accounts/"+slotOwner+"/workspaces/"+idFor(1)),false);
  assert.equal(db.rows.has("tenants/"+slotOwner+"/workspaces/free"),false);
  assert.equal(db.rows.has("gd_accounts/"+slotOwner),false);
});
test("route: DELETE /v2/account answers 202 with a job id",async()=>{
  let register;try{({registerAccountDeletion:register}=require("./account_delete"));}catch(e){if(e.code==="MODULE_NOT_FOUND")assert.fail("account_delete.js not implemented");throw e;}
  assert.equal(typeof register,"function","registerAccountDeletion export (name TBD by Riley)");
  const express=require("express"),app=express();
  register({app,firebaseAuth:(req,_res,next)=>{req.user={uid,auth_time:Math.floor(Date.now()/1000)-30};next();},db:memoryFirestore(),
    stripe:{subscriptions:{list:async()=>({has_more:false,data:[]}),cancel:async()=>({})}},bucket:{deleteFiles:async()=>{},getFiles:async()=>[[]]},
    auth:{deleteUser:async()=>{}},byoProviders:{},hash:u=>crypto.createHash("sha256").update(u).digest("hex"),now:()=>Date.now()});
  const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
  try{const res=await fetch("http://127.0.0.1:"+server.address().port+"/v2/account",{method:"DELETE"});
    assert.equal(res.status,202);const body=await res.json();assert.equal(typeof body.jobId,"string");}
  finally{server.close();}
});
