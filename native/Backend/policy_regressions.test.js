"use strict";
// QA regression suite for the policy rules locked for docs/API.md (Oct 17 2026).
// The {todo} tests below are the workspace-policy contract. They stay todo on
// this branch because the behavior belongs to PR #5 (fix/backend-workspace-policy),
// not to account deletion. A failure is reported as TODO rather than failing CI.
// When that PR lands, drop the todo flag. No credentials, network, Stripe, or Firebase.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {memoryFirestore}=require("./test_firestore");
const {createProjectService,policyFor,projectStatus,effectiveStorageQuota,validateSelection}=require("./projects");
const owner=crypto.createHash("sha256").update("policy-regression-owner").digest("hex"),other="c".repeat(64);
const idFor=n=>"12345678-1234-4000-8000-"+String(n).padStart(12,"0");
const base={kind:"paid",accountHash:owner,name:"Existing",projectBillingVersion:2,projectStatus:"active",projectFeeStatus:"paid",
  provisioned:true,storageActive:false,performanceActive:false,usedBytes:0,reservedBytes:0};
const qualifier={storageActive:true,storageTier:"2TB",performanceActive:true,performanceTier:"turbo"};
function fixture(){
  const db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_test"}]]);
  const stripe={prices:{retrieve:async()=>{throw Error("no Stripe in policy tests");}},checkout:{sessions:{}}};
  const env={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_PROJECT_CHECKOUT_READY:"true",STRIPE_PROJECT_CREATION_PRICE_ID:"price_test",STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example"};
  const service=createProjectService({db,stamp:()=>1,hash:uid=>uid==="other"?other:owner,stripe,env,ensureCustomer:async()=>"cus_test"});
  const path=id=>"gd_accounts/"+owner+"/workspaces/"+id;
  const put=(id,v={})=>db.rows.set(path(id),{...base,name:"P"+id.slice(-2),...v});
  return {db,service,req:{user:{uid:"owner"}},put,path,record:id=>db.rows.get(path(id))};
}
// 20 projects where #1 qualified for the 20 cap, then the plan is downgraded.
function downgraded(f){for(let n=1;n<=20;n++)f.put(idFor(n),n===1?qualifier:{});f.db.rows.set(f.path(idFor(1)),{...f.record(idFor(1)),storageActive:false,performanceActive:false});}

// ---- 1. Ownership ----
// Ownership = accountHash (accountKey for legacy free project). No shared workspaces at launch.
test("ownership: a different account gets 404 on someone else's workspace",async()=>{
  const f=fixture();f.put(idFor(1));
  await assert.rejects(f.service.get({user:{uid:"other"}},idFor(1)),{status:404,code:"PROJECT_NOT_FOUND"});
});
test("ownership: a foreign accountHash returns 404 — todo, depends on PR #5 (get() still returns 403 PROJECT_FORBIDDEN)",{todo:"depends on PR #5 fix/backend-workspace-policy; get() returns 403 PROJECT_FORBIDDEN"},async()=>{
  const f=fixture();f.put(idFor(1),{accountHash:other});
  await assert.rejects(f.service.get(f.req,idFor(1)),{status:404});
});

// ---- 4. Cap re-check / downgrade lock ----
test("cap: after downgrade (20 projects, 10 cap) creating another project is refused",async()=>{
  const f=fixture();downgraded(f);
  const p=(await f.service.inventory(f.req)).policy;assert.equal(p.projectLimit,10);assert.equal(p.usedProjectSlots,20);
  await assert.rejects(f.service.create(f.req,{name:"New",intentId:idFor(99)}),{code:"PROJECT_LIMIT_REACHED"});
});
test("cap: after downgrade, restoring an archived project is refused",async()=>{
  const f=fixture();downgraded(f);f.put(idFor(21),{projectStatus:"archived",statusBeforeArchive:"active"});
  await assert.rejects(f.service.restore(f.req,idFor(21)),{code:"PROJECT_LIMIT_REACHED"});
});
test("cap: downgrade over cap sets policy.locked — todo, depends on PR #5 (cap is only checked on create, checkout, restore, and confirm)",{todo:"depends on PR #5 fix/backend-workspace-policy; login lock is not built"},async()=>{
  const f=fixture();downgraded(f);
  const p=(await f.service.inventory(f.req)).policy;
  assert.equal(p.locked,true,"policy must expose a lock when usedProjectSlots > projectLimit");
});
test("cap: a locked account stays readable and blocks uploads — todo, depends on PR #5 (no uploadsBlocked flag yet)",{todo:"depends on PR #5 fix/backend-workspace-policy; lock flag is not built"},async()=>{
  const f=fixture();downgraded(f);
  assert.ok(effectiveStorageQuota(f.record(idFor(15)))>0,"data must remain readable/downloadable");
  assert.equal((await f.service.inventory(f.req)).policy.uploadsBlocked,true);
});

test("cap: paid storage denies workspaces over the cap — todo, depends on PR #5 (scopeFromWorkspace ignores the account cap)",{todo:"depends on PR #5 fix/backend-workspace-policy; paid_storage scope ignores the cap"},()=>{
  const {scopeFromWorkspace}=require("./paid_storage");
  const f=fixture();for(let n=1;n<=15;n++)f.put(idFor(n),n===1?qualifier:{});
  f.db.rows.set(f.path(idFor(1)),{...f.record(idFor(1)),storageActive:false,performanceActive:false});
  // Over the 10 cap after downgrade: uploads must be blocked (reads may stay allowed by the lock rule).
  const scope=scopeFromWorkspace(f.record(idFor(15)),owner,idFor(15));
  assert.ok(scope===null||scope.uploadsBlocked===true,"workspace 15 still gets a writable storage scope");
});

// ---- 2. Billing ($5/month, FREE_WORKSPACES) ----
test("billing: workspace fee is $5 per month — todo, depends on PR #5 (policyFor still reports a one-time fee)",{todo:"depends on PR #5 fix/backend-workspace-policy; monthly fee is not built"},()=>{
  const p=policyFor({},[]);assert.equal(p.feeIsOneTime,false);assert.equal(p.workspaceMonthlyCents,500);
});
test("billing: FREE_WORKSPACES defaults to 1 — todo, depends on PR #5 (projects.js does not export it)",{todo:"depends on PR #5 fix/backend-workspace-policy; FREE_WORKSPACES is not exported"},()=>{
  assert.equal(require("./projects").FREE_WORKSPACES,1);
});

// ---- BYO storage ----
const byo=n=>({kind:"byo",byoActive:true,manualProviderConfigured:true,provisioned:true,name:"BYO"+n});
test("byo: BYO workspaces count toward the same 10 cap",async()=>{
  const f=fixture();for(let n=1;n<=10;n++)f.put(idFor(n),byo(n));
  assert.equal((await f.service.inventory(f.req)).policy.usedProjectSlots,10);
  await assert.rejects(f.service.create(f.req,{name:"Eleventh",intentId:idFor(11)}),{code:"PROJECT_LIMIT_REACHED"});
});
test("byo: storage type uses the same $5 monthly fee — todo, depends on PR #5 (monthly fee is not built)",{todo:"depends on PR #5 fix/backend-workspace-policy; monthly workspace fee is not built"},()=>{
  const managed=policyFor({},[base]),own=policyFor({},[{...base,...byo(1)}]);
  assert.equal(own.workspaceMonthlyCents,500);assert.equal(own.workspaceMonthlyCents,managed.workspaceMonthlyCents);
});
test("byo secrets: plan-selection payload drops provider secrets",()=>{
  const out=validateSelection({storageTier:"2TB",secretAccessKey:"FAKE-NOT-A-KEY",password:"x",privateKey:"x"});
  assert.deepEqual(Object.keys(out),["storageTier"]);
});
test("byo secrets: registration rejects provider secrets — todo, depends on PR #5 (no fingerprint-only registration route)",{todo:"depends on PR #5 fix/backend-workspace-policy; BYO registration route is not built"},()=>{
  assert.fail("needs BYO registration handler: expect 400 on accessKey/secret/password/privateKey, no Firestore field or console output containing the value");
});
test("byo challenge: workspace stays inactive until read-back — todo, depends on PR #5 (projectStatus activates without a challenge)",{todo:"depends on PR #5 fix/backend-workspace-policy; challenge read-back is not required"},()=>{
  assert.equal(projectStatus({...byo(1),projectStatus:undefined}),"pending_activation");
});

// ---- 3. Lapse ----
test("lapse: unpaid workspace lapses after period end plus 3 days — todo, depends on PR #5 (no lapse evaluator)",{todo:"depends on PR #5 fix/backend-workspace-policy; monthly lapse is not built"},()=>{
  assert.fail("needs lapse evaluator: active at period_end+3d-1s, lapsed/locked at period_end+3d");
});

// ---- 5. Merge ----
test("merge: copies are renamed and the source waits for verification — todo, depends on PR #5 (no merge service)",{todo:"depends on PR #5 fix/backend-workspace-policy; merge is not implemented"},()=>{
  assert.fail("needs merge service");
});

// ---- 6. Grandfathering ----
test("grandfathering: a one-time-$5 project and the legacy free project stay active with quota",()=>{
  for(const w of [base,{...base,kind:"free",accountKey:owner,projectFeeStatus:"free"}]){
    assert.equal(projectStatus(w),"active");assert.equal(effectiveStorageQuota(w),2e9);
  }
});
test("grandfathering: one-time projects are exempt from the monthly policy — todo, depends on PR #5 (no monthly policy)",{todo:"depends on PR #5 fix/backend-workspace-policy; monthly policy is not built"},()=>{
  assert.equal(policyFor({},[base]).grandfatheredProjects,1);
});
