"use strict";
// QA regression suite for the policy rules locked for docs/API.md (Oct 17 2026).
// Tests marked {todo:...} assert the AGREED rule that current code does not yet
// implement: they run, and a failure is reported as TODO rather than failing CI.
// When a fix lands, its todo test should start passing; then drop the todo flag.
// No credentials, network, Stripe or Firebase: in-memory Firestore + stub Stripe.
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
test("ownership: a project whose accountHash is another account is 403 even under the caller's path",async()=>{
  const f=fixture();f.put(idFor(1),{accountHash:other});
  await assert.rejects(f.service.get(f.req,idFor(1)),{status:403,code:"PROJECT_FORBIDDEN"});
});
test("ownership: a read-only member (shared, not owner) gets 403",{todo:"no membership/role model in projects.js yet; ownerUid check must reject non-owner members"},async()=>{
  const f=fixture();f.put(idFor(1),{accountHash:other,members:{[owner]:"reader"}});
  await assert.rejects(f.service.get(f.req,idFor(1)),{status:403});
  assert.fail("needs explicit member-role fixture once the membership model exists");
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
test("cap: downgrade over cap puts the account in the login lock (Casey bug: projects 11-20 stay usable)",{todo:"EXPECTED FAIL until fix: cap only checked on create/checkout/restore/confirm"},async()=>{
  const f=fixture();downgraded(f);
  const p=(await f.service.inventory(f.req)).policy;
  assert.equal(p.locked,true,"policy must expose a lock when usedProjectSlots > projectLimit");
});
test("cap: while locked, data stays readable but uploads are blocked",{todo:"lock not built: expect quota>0 for reads and an upload-blocked flag"},async()=>{
  const f=fixture();downgraded(f);
  assert.ok(effectiveStorageQuota(f.record(idFor(15)))>0,"data must remain readable/downloadable");
  assert.equal((await f.service.inventory(f.req)).policy.uploadsBlocked,true);
});

// ---- 2. Billing ($5/month, FREE_WORKSPACES) ----
test("billing: workspace fee is $5 per month, not one-time",{todo:"EXPECTED FAIL: policyFor reports feeIsOneTime:true ($5 once)"},()=>{
  const p=policyFor({},[]);assert.equal(p.feeIsOneTime,false);assert.equal(p.workspaceMonthlyCents,500);
});
test("billing: FREE_WORKSPACES defaults to 1",{todo:"constant not exported yet"},()=>{
  assert.equal(require("./projects").FREE_WORKSPACES,1);
});

// ---- BYO storage ----
const byo=n=>({kind:"byo",byoActive:true,manualProviderConfigured:true,provisioned:true,name:"BYO"+n});
test("byo: BYO workspaces count toward the same 10 cap",async()=>{
  const f=fixture();for(let n=1;n<=10;n++)f.put(idFor(n),byo(n));
  assert.equal((await f.service.inventory(f.req)).policy.usedProjectSlots,10);
  await assert.rejects(f.service.create(f.req,{name:"Eleventh",intentId:idFor(11)}),{code:"PROJECT_LIMIT_REACHED"});
});
test("byo: storage type does not change billing ($5/month like managed)",{todo:"monthly workspace fee not built; byo has its own byoSubscription path"},()=>{
  const managed=policyFor({},[base]),own=policyFor({},[{...base,...byo(1)}]);
  assert.equal(own.workspaceMonthlyCents,500);assert.equal(own.workspaceMonthlyCents,managed.workspaceMonthlyCents);
});
test("byo secrets: plan-selection payload drops provider secrets",()=>{
  const out=validateSelection({storageTier:"2TB",secretAccessKey:"FAKE-NOT-A-KEY",password:"x",privateKey:"x"});
  assert.deepEqual(Object.keys(out),["storageTier"]);
});
test("byo secrets: server rejects any payload with provider secrets and never persists or logs them",{todo:"BYO registration endpoint (type/endpoint/bucket fingerprint only) not built"},()=>{
  assert.fail("needs BYO registration handler: expect 400 on accessKey/secret/password/privateKey, no Firestore field or console output containing the value");
});
test("byo challenge: workspace stays inactive without a verified challenge read-back",{todo:"EXPECTED FAIL: projectStatus activates byo on byoActive+manualProviderConfigured alone"},()=>{
  assert.equal(projectStatus({...byo(1),projectStatus:undefined}),"pending_activation");
});

// ---- 3. Lapse ----
test("lapse: unpaid workspace lapses at Stripe current_period_end + 3 days grace",{todo:"monthly lapse not built"},()=>{
  assert.fail("needs lapse evaluator: active at period_end+3d-1s, lapsed/locked at period_end+3d");
});

// ---- 5. Merge ----
test("merge: never overwrites; incoming copy named 'name (from <source>)', numbered on collision; source deleted only after all copies verify",{todo:"merge not implemented in backend"},()=>{
  assert.fail("needs merge service");
});

// ---- 6. Grandfathering ----
test("grandfathering: a one-time-$5 project and the legacy free project stay active with quota",()=>{
  for(const w of [base,{...base,kind:"free",accountKey:owner,projectFeeStatus:"free"}]){
    assert.equal(projectStatus(w),"active");assert.equal(effectiveStorageQuota(w),2e9);
  }
});
test("grandfathering: grandfathered projects are never lapsed or charged by the monthly policy",{todo:"monthly policy not built; must exempt projectFeeStatus paid/free with projectBillingVersion 2"},()=>{
  assert.equal(policyFor({},[base]).grandfatheredProjects,1);
});
