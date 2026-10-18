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
function fixture(options={}){
  const db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_test"}]]);
  const stripe={prices:{retrieve:async()=>{throw Error("no Stripe in policy tests");}},checkout:{sessions:{}}};
  const env={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_PROJECT_CHECKOUT_READY:"true",STRIPE_PROJECT_CREATION_PRICE_ID:"price_test",STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example"};
  const service=createProjectService({db,stamp:()=>1,hash:uid=>uid==="other"?other:owner,stripe,env,ensureCustomer:async()=>"cus_test",...options});
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
test("ownership: a record with a foreign accountHash returns 404, not 403 (must not reveal existence)",async()=>{
  const f=fixture();f.put(idFor(1),{accountHash:other});
  await assert.rejects(f.service.get(f.req,idFor(1)),{status:404,code:"PROJECT_NOT_FOUND"});
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
test("cap: downgrade over cap puts the account in the login lock (Casey bug: projects 11-20 stay usable)",async()=>{
  const f=fixture();downgraded(f);
  const p=(await f.service.inventory(f.req)).policy;
  assert.equal(p.locked,true,"policy must expose a lock when usedProjectSlots > projectLimit");
  assert.equal(p.reason,"over_cap");assert.equal(p.overBy,10);assert.deepEqual(p.unpaidWorkspaceIds,[]);
});
test("cap: while locked, data stays readable but uploads are blocked",async()=>{
  const f=fixture();downgraded(f);
  assert.ok(effectiveStorageQuota(f.record(idFor(15)))>0,"data must remain readable/downloadable");
  assert.equal((await f.service.inventory(f.req)).policy.uploadsBlocked,true);
});

test("cap: paid storage route denies access to workspaces over the cap after downgrade (Casey: paid_storage.js:20-28)",async()=>{
  const express=require("express");
  const {scopeFromWorkspace,registerPaidStorage}=require("./paid_storage");
  const f=fixture();for(let n=1;n<=15;n++)f.put(idFor(n),n===1?qualifier:{});
  f.db.rows.set(f.path(idFor(1)),{...f.record(idFor(1)),storageActive:false,performanceActive:false});
  // Over the 10 cap after downgrade: uploads must be blocked (reads may stay allowed by the lock rule).
  // Pass the account list explicitly. A missing list is fail-closed (scope_unavailable), not this over-cap case.
  const listed=[];for(let n=1;n<=15;n++)listed.push({...f.record(idFor(n)),id:idFor(n)});
  const scope=scopeFromWorkspace(f.record(idFor(15)),owner,idFor(15),listed);
  assert.ok(scope===null||scope.uploadsBlocked===true,"workspace 15 still gets a writable storage scope");
  assert.equal(scope.uploadsBlocked,true);
  assert.deepEqual(scope.lock,{error:"workspace_lock",reason:"over_cap",overBy:5,unpaidWorkspaceIds:[]});
  const app=express();
  registerPaidStorage({app,db:f.db,bucket:{file:()=>({delete:async()=>{}})},accountKey:()=>owner,
    apiKeys:{verify:async()=>null},getAuth:()=>({}),FieldValue:{increment:n=>({increment:n}),serverTimestamp:()=>1},
    firebaseAuth:(req,res,next)=>{if(req.headers.authorization!=="Bearer owner")return res.status(401).end();req.user={uid:"owner"};next();}});
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  const root="http://127.0.0.1:"+server.address().port+"/v2/workspaces/"+idFor(15)+"/cloud";
  const call=(path,options={})=>fetch(root+path,{...options,headers:{Authorization:"Bearer owner",...options.headers}});
  try{
    assert.equal((await call("/files")).status,200);
    const upload=await call("/uploads",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"blocked.txt",sizeBytes:4})});
    assert.equal(upload.status,423);assert.deepEqual(await upload.json(),scope.lock);
    assert.equal((await call("/files/"+idFor(15),{method:"DELETE"})).status,404);
    assert.equal((await call("/files/"+idFor(15)+"/download")).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

// ---- 2. Billing ($5/month, FREE_WORKSPACES) ----
test("billing: workspace fee is $5 per month, not one-time",async()=>{
  const p=policyFor({},[]);assert.equal(p.feeIsOneTime,false);assert.equal(p.workspaceMonthlyCents,500);
  const {createProjectService}=require("./projects");
  const calls=[];
  const price={id:"price_month",active:true,type:"recurring",recurring:{interval:"month"},currency:"usd",unit_amount:500,billing_scheme:"per_unit",livemode:false,product:{active:true}};
  const stripe={prices:{retrieve:async()=>({...price})},checkout:{sessions:{create:async args=>{calls.push(args);return {id:"cs_month",url:"https://checkout.stripe.com/c/pay/cs_month",status:"open"};},retrieve:async()=>{throw Error("missing session");}}}};
  const env={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_WORKSPACE_MONTHLY_READY:"true",STRIPE_WORKSPACE_MONTHLY_PRICE_ID:"price_month",STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example"};
  const service=createProjectService({db:memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_test"}]]),stamp:()=>1,hash:()=>owner,stripe,env,ensureCustomer:async()=>"cus_test"});
  const req={user:{uid:"owner"}};
  assert.equal((await service.create(req,{name:"First Project",intentId:idFor(1)})).project.data.projectFeeStatus,"free");
  const second=await service.create(req,{name:"Second Project",intentId:idFor(2)});
  assert.equal(second.project.data.workspaceFeeModel,"monthly");assert.equal(second.project.data.feeIsOneTime,false);
  const session=await service.checkout(req,idFor(2));
  assert.equal(session.workspaceMonthlyCents,500);assert.equal(calls[0].mode,"subscription");
  assert.deepEqual(calls[0].line_items,[{price:"price_month",quantity:1}]);assert.equal(calls[0].metadata.kind,"workspace_fee");
  const blocked=createProjectService({db:memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_test"}]]),stamp:()=>1,hash:()=>owner,stripe,
    env:{STRIPE_CHECKOUT_ENABLED:"true",STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example",STRIPE_WORKSPACE_MONTHLY_PRICE_ID:"price_month"},ensureCustomer:async()=>"cus_test"});
  await blocked.create(req,{name:"Only Free",intentId:idFor(3)});
  await assert.rejects(blocked.create(req,{name:"Needs Price",intentId:idFor(4)}),{code:"PROJECT_PAYMENT_UNAVAILABLE"});
  assert.equal(calls.length,1);
});
test("billing: FREE_WORKSPACES defaults to 1",()=>{
  assert.equal(require("./projects").FREE_WORKSPACES,1);
  assert.equal(require("./workspace_policy").FREE_WORKSPACES,1);
  assert.equal(require("./workspace_policy").WORKSPACE_FEE_USD_MONTHLY,5);
  assert.equal(require("./workspace_policy").BASE_CAP,10);
  assert.equal(require("./workspace_policy").RAISED_CAP,20);
});

// ---- BYO storage ----
const byo=n=>({kind:"byo",byoActive:true,manualProviderConfigured:true,provisioned:true,name:"BYO"+n});
test("byo: BYO workspaces count toward the same 10 cap",async()=>{
  const f=fixture();for(let n=1;n<=10;n++)f.put(idFor(n),byo(n));
  assert.equal((await f.service.inventory(f.req)).policy.usedProjectSlots,10);
  await assert.rejects(f.service.create(f.req,{name:"Eleventh",intentId:idFor(11)}),{code:"PROJECT_LIMIT_REACHED"});
});
test("byo: storage type does not change billing ($5/month like managed)",()=>{
  const managed=policyFor({},[base]),own=policyFor({},[{...base,...byo(1)}]);
  assert.equal(own.workspaceMonthlyCents,500);assert.equal(own.workspaceMonthlyCents,managed.workspaceMonthlyCents);
  assert.equal(own.feeIsOneTime,false);assert.equal(managed.feeIsOneTime,false);
});
test("byo secrets: plan-selection payload drops provider secrets",()=>{
  const out=validateSelection({storageTier:"2TB",secretAccessKey:"FAKE-NOT-A-KEY",password:"x",privateKey:"x"});
  assert.deepEqual(Object.keys(out),["storageTier"]);
});
test("byo secrets: server rejects any payload with provider secrets and never persists or logs them",async()=>{
  const f=fixture();const secret="AKIAIOSFODNN7EXAMPLE";
  const methods=["log","info","warn","error","debug"],saved=methods.map(name=>[name,console[name]]);
  const logs=[];for(const name of methods)console[name]=(...args)=>{logs.push(args.map(String).join(" "));return saved.find(([key])=>key===name)[1].apply(console,args);};
  const express=require("express"),{registerBillingV2}=require("./billing_v2");
  const app=express();app.use(express.json());
  registerBillingV2({app,db:f.db,stripe:{prices:{retrieve:async()=>{throw Error("no Stripe");}},checkout:{sessions:{}}},
    admin:{firestore:{FieldValue:{serverTimestamp:()=>1}}},auth:(req,_res,next)=>{req.user={uid:"owner"};next();},agreed:(_q,_s,n)=>n(),
    hash:()=>owner,env:{PUBLIC_URL:"https://billing.example",STRIPE_CHECKOUT_ENABLED:"false"},prices:{}});
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  try{
    await assert.rejects(f.service.registerByo(f.req,idFor(1),{provider:"s3",endpoint:"https://s3.example.com",bucketFingerprint:"a".repeat(16),
      accessKey:secret,secretAccessKey:secret,password:secret,privateKey:secret}),{status:400,code:"BYO_SECRET_REJECTED"});
    const response=await fetch("http://127.0.0.1:"+server.address().port+"/v2/workspaces/"+idFor(1)+"/byo/register",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({provider:"sftp",endpoint:"sftp://files.example",hostFingerprint:"b".repeat(16),password:secret,privateKey:secret})});
    const body=await response.json();assert.equal(response.status,400);assert.equal(body.error,"BYO_SECRET_REJECTED");
    f.put(idFor(1),{kind:"byo",projectStatus:"pending_activation",name:"BYO workspace"});
    const savedByo=await f.service.registerByo(f.req,idFor(1),{provider:"r2",endpoint:"https://acct.r2.cloudflarestorage.com",bucketFingerprint:"cd".repeat(8)});
    assert.deepEqual(savedByo,{providerType:"s3",endpoint:"https://acct.r2.cloudflarestorage.com",bucketFingerprint:"cd".repeat(8),byoRegistered:true,updatedAt:1});
    assert.equal(f.record(idFor(1)).byoActive,undefined);assert.equal(f.record(idFor(1)).byoChallengeVerified,undefined);
    const blob=JSON.stringify([...f.db.rows])+logs.join("\n")+JSON.stringify(body);
    assert.equal(blob.includes(secret),false);
  }finally{for(const [name,fn] of saved)console[name]=fn;await new Promise(resolve=>server.close(resolve));}
});
test("byo challenge: workspace stays inactive without a verified server-side fetch",async()=>{
  assert.equal(projectStatus({...byo(1),projectStatus:undefined}),"pending_activation");
  assert.equal(projectStatus({...byo(1),byoActive:true,manualProviderConfigured:true,projectStatus:undefined}),"pending_activation");
  const endpoint="https://s3.example.com";
  const byoFetch=async url=>{
    const nonce=new URL(url).pathname.split("/").pop();
    return {status:200,body:Buffer.from(nonce),headers:{etag:'"'+"ab".repeat(16)+'"'}};
  };
  const f=fixture({byoFetch});
  f.db.rows.set(f.path(idFor(1)),{kind:"byo",accountHash:owner,name:"BYO challenge",provisioned:true,byoActive:true,manualProviderConfigured:true,providerType:"s3",endpoint,bucketFingerprint:"a".repeat(16)});
  assert.equal(projectStatus(f.record(idFor(1))),"pending_activation");
  const issued=await f.service.issueByoChallenge(f.req,idFor(1));
  await assert.rejects(f.service.verifyByo(f.req,idFor(1),{readBack:"not-the-nonce"}),{status:400,code:"BYO_CHALLENGE_PROOF_REQUIRED"});
  await assert.rejects(f.service.verifyByo(f.req,idFor(1),{presignedUrl:endpoint+"/.gendragoon-challenge/not-the-nonce"}),{status:400,code:"BYO_CHALLENGE_MISMATCH"});
  assert.notEqual(f.record(idFor(1)).byoChallengeVerified,true);
  await f.service.verifyByo(f.req,idFor(1),{presignedUrl:endpoint+"/.gendragoon-challenge/"+issued.nonce});
  assert.equal(f.record(idFor(1)).byoChallengeVerified,true);assert.equal(projectStatus(f.record(idFor(1))),"active");
  await assert.rejects(f.service.verifyByo(f.req,idFor(1),{presignedUrl:endpoint+"/.gendragoon-challenge/"+issued.nonce}),{code:"BYO_CHALLENGE_USED"});
  f.db.rows.set(f.path(idFor(2)),{kind:"byo",accountHash:owner,name:"BYO expired",provisioned:true,providerType:"s3",endpoint,bucketFingerprint:"b".repeat(16),byoChallenge:{nonce:"expired-nonce",expiresAtMs:Date.now()-1,used:false}});
  await assert.rejects(f.service.verifyByo(f.req,idFor(2),{presignedUrl:endpoint+"/.gendragoon-challenge/expired-nonce"}),{code:"BYO_CHALLENGE_EXPIRED"});
});

// ---- 3. Lapse ----
test("lapse: unpaid workspace lapses at Stripe current_period_end + 3 days grace",async()=>{
  const {evaluateLapse,LAPSE_GRACE_MS}=require("./workspace_policy");
  const express=require("express"),Stripe=require("stripe"),{installedBilling,STRIPE_API_VERSION}=require("./billing_gateway");
  assert.equal(LAPSE_GRACE_MS,3*24*60*60*1000);
  const f=fixture();const periodEnd=1_700_000_000,endMs=periodEnd*1000;
  // Grace is anchored to the last paid period, which payment_failed must not move.
  f.put(idFor(3),{workspaceFeeModel:"monthly",workspaceFeeStatus:"pending",projectFeeStatus:"pending",projectStatus:"active",provisioned:true,paidThroughMs:endMs,workspaceFeePeriodEndMs:endMs});
  f.put(idFor(4));const grandfathered=structuredClone(f.record(idFor(4)));
  const sub={id:"sub_ws",customer:"cus_test",status:"past_due",current_period_end:periodEnd,metadata:{kind:"workspace_fee",accountHash:owner,workspaceId:idFor(3)}};
  let retrieves=0;
  const verifier=new Stripe("sk_test_dummyABC123",{apiVersion:STRIPE_API_VERSION});
  const stripe={webhooks:verifier.webhooks,subscriptions:{retrieve:async id=>{retrieves+=1;if(id!==sub.id)throw Error("missing subscription");return structuredClone(sub);}},
    customers:{create:async()=>({id:"cus_test"})},checkout:{sessions:{create:async()=>{throw Error("no checkout");},retrieve:async()=>{throw Error("no session");},listLineItems:async()=>({data:[]})}},
    paymentIntents:{retrieve:async()=>{throw Error("no intent");}},charges:{retrieve:async()=>{throw Error("no charge");}}};
  const app=express();
  installedBilling({app,db:f.db,bucket:{file:()=>({save:async()=>{}})},stripeOverride:stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>1}}},
    firebaseAuth:(_req,_res,next)=>next(),accountKey:()=>owner,env:{STRIPE_SECRET_KEY:"sk_test_dummyABC123",STRIPE_WEBHOOK_SECRET:"whsec_disposableFixtureOnly123",
      STRIPE_CHECKOUT_ENABLED:"true",STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example",STRIPE_PRICE_CATALOG_JSON:"{}"}});
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  async function webhook(type,object,eventId){
    const payload=JSON.stringify({id:eventId,type,data:{object}});
    const signature=verifier.webhooks.generateTestHeaderString({payload,secret:"whsec_disposableFixtureOnly123"});
    const response=await fetch("http://127.0.0.1:"+server.address().port+"/billing/stripe-webhook",{method:"POST",headers:{"Content-Type":"application/json","Stripe-Signature":signature},body:payload});
    return {status:response.status,body:await response.json()};
  }
  try{
    const failed=await webhook("invoice.payment_failed",{id:"in_failed",subscription:"sub_ws"},"evt_failed123");
    assert.equal(failed.status,200);assert.equal(f.record(idFor(3)).workspaceFeeStatus,"past_due");
    assert.equal(f.record(idFor(3)).workspaceFeePeriodEndMs,endMs);assert.equal(f.record(idFor(3)).workspaceFeePaid,false);
    assert.equal(evaluateLapse(f.record(idFor(3)),endMs+LAPSE_GRACE_MS-1000).lapsed,false);
    assert.equal(evaluateLapse(f.record(idFor(3)),endMs+LAPSE_GRACE_MS-1).lapsed,false);
    assert.equal(evaluateLapse(f.record(idFor(3)),endMs+LAPSE_GRACE_MS).lapsed,true);
    const calls=retrieves;const replay=await webhook("invoice.payment_failed",{id:"in_failed",subscription:"sub_ws"},"evt_failed123");
    assert.equal(replay.body.replayed,true);assert.equal(retrieves,calls);
    sub.metadata={...sub.metadata,workspaceId:idFor(4)};
    assert.equal((await webhook("invoice.payment_failed",{id:"in_grand",subscription:"sub_ws"},"evt_grand123")).status,200);
    assert.deepEqual(f.record(idFor(4)),grandfathered);
    assert.equal(evaluateLapse(f.record(idFor(4)),endMs+LAPSE_GRACE_MS+10_000).lapsed,false);
    sub.metadata={kind:"workspace_fee",accountHash:owner,workspaceId:idFor(3)};sub.status="active";
    assert.equal((await webhook("invoice.paid",{id:"in_paid",subscription:"sub_ws"},"evt_paid123")).status,200);
    assert.equal(f.record(idFor(3)).workspaceFeeStatus,"active");assert.equal(f.record(idFor(3)).workspaceFeePaid,true);
    assert.equal(evaluateLapse(f.record(idFor(3)),endMs+LAPSE_GRACE_MS).lapsed,false);
    sub.status="canceled";
    assert.equal((await webhook("customer.subscription.deleted",{id:"sub_ws"},"evt_deleted123")).status,200);
    assert.equal(f.record(idFor(3)).workspaceFeeStatus,"canceled");
    assert.equal(evaluateLapse(f.record(idFor(3)),endMs+LAPSE_GRACE_MS-1).lapsed,false);
    assert.equal(evaluateLapse(f.record(idFor(3)),endMs+LAPSE_GRACE_MS).lapsed,true);
    sub.status="past_due";
    assert.equal((await webhook("customer.subscription.updated",{id:"sub_ws"},"evt_updated123")).status,200);
    assert.equal(f.record(idFor(3)).workspaceFeeStatus,"past_due");
    assert.equal((await webhook("customer.subscription.updated",{id:"sub_ws"},"evt_updated123")).body.replayed,true);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

// ---- 5. Merge ----
test("merge: never overwrites; incoming copy named 'name (from <source>)', numbered on collision; source deleted only after all copies verify",async()=>{
  const {createProjectService}=require("./projects");
  const f=fixture();const source=idFor(1),target=idFor(2);
  f.put(source,{name:"Alpha"});f.put(target,{name:"Beta"});
  const sha=buf=>crypto.createHash("sha256").update(buf).digest("hex");
  const sourceNotes=Buffer.from("source-notes"),sourceUnique=Buffer.from("source-unique"),targetNotes=Buffer.from("target-notes-original"),renamed=Buffer.from("preexisting-rename");
  const blobs=new Map();
  const save=(key,buf)=>blobs.set(key,{buf:Buffer.from(buf),size:buf.length,sha256:sha(buf)});
  save("s/notes",sourceNotes);save("s/unique",sourceUnique);save("t/notes",targetNotes);save("t/renamed",renamed);
  const file=(id,rowId,data)=>f.db.rows.set(f.path(id)+"/files/"+rowId,data);
  file(source,"f1",{name:"notes.txt",sizeBytes:sourceNotes.length,sha256:sha(sourceNotes),objectKey:"s/notes"});
  file(source,"f2",{name:"unique.bin",sizeBytes:sourceUnique.length,sha256:sha(sourceUnique),objectKey:"s/unique"});
  file(target,"t1",{name:"notes.txt",sizeBytes:targetNotes.length,sha256:sha(targetNotes),objectKey:"t/notes"});
  file(target,"t2",{name:"notes.txt (from Alpha)",sizeBytes:renamed.length,sha256:sha(renamed),objectKey:"t/renamed"});
  let failUnique=true;
  const objectStore={
    async copy(from,to){if(failUnique&&from==="s/unique"){failUnique=false;throw Error("injected copy failure");}const src=blobs.get(from);if(!src)throw Error("missing");blobs.set(to,{buf:Buffer.from(src.buf),size:src.size,sha256:src.sha256});return {size:src.size,sha256:src.sha256};},
    async stat(key){const value=blobs.get(key);return value?{size:value.size,sha256:value.sha256}:null;},
    async delete(key){blobs.delete(key);}
  };
  const service=createProjectService({db:f.db,stamp:()=>1,hash:uid=>uid==="other"?other:owner,stripe:f.db&&{prices:{retrieve:async()=>{throw Error("no");}},checkout:{sessions:{}}},env:{},ensureCustomer:async()=>"cus_test",objectStore});
  await assert.rejects(service.merge(f.req,source,{targetId:target,confirmName:"Nope"}),{code:"CONFIRM_NAME_REQUIRED"});
  await assert.rejects(service.merge(f.req,source,{targetId:target,confirmName:"Alpha"}));
  assert.equal(f.record(source).projectStatus,"active");assert.ok(blobs.has("s/notes")&&blobs.has("s/unique"));
  assert.equal(blobs.get("t/notes").sha256,sha(targetNotes));
  const done=await service.merge(f.req,source,{targetId:target,confirmName:"Alpha"});
  assert.equal(done.sourceDeleted,true);assert.equal(done.copied,2);assert.equal(f.record(source),undefined);
  assert.equal(blobs.has("s/notes"),false);assert.equal(blobs.has("s/unique"),false);assert.ok(blobs.has("t/notes")&&blobs.has("t/renamed"));
  const names=[...f.db.rows.entries()].filter(([key])=>key.startsWith(f.path(target)+"/files/")).map(([,value])=>value);
  assert.equal(names.filter(file=>file.name==="notes.txt").length,1);
  assert.equal(names.find(file=>file.name==="notes.txt").sha256,sha(targetNotes));
  assert.equal(names.filter(file=>file.name==="notes.txt (from Alpha)").length,1);
  assert.equal(names.find(file=>file.name==="notes.txt (from Alpha)").sha256,sha(renamed));
  assert.equal(names.filter(file=>file.name==="notes.txt (from Alpha) 2").length,1);
  assert.equal(names.find(file=>file.name==="notes.txt (from Alpha) 2").sha256,sha(sourceNotes));
  assert.equal(names.filter(file=>file.name==="unique.bin").length,1);
  const again=await service.merge(f.req,source,{targetId:target,confirmName:"Alpha"});
  assert.equal(again.idempotent,true);assert.equal([...f.db.rows.keys()].filter(key=>key.startsWith(f.path(target)+"/files/")).length,4);
  const left=idFor(30),right=idFor(31);f.put(left,{name:"Left"});f.put(right,{name:"Right"});
  file(left,"only",{name:"solo.txt",sizeBytes:sourceUnique.length,sha256:sha(sourceUnique),objectKey:"s/unique2"});
  save("s/unique2",sourceUnique);
  const pair=await Promise.allSettled([service.merge(f.req,left,{targetId:right,confirmName:"Left"}),service.merge(f.req,left,{targetId:right,confirmName:"Left"})]);
  assert.equal(pair.filter(item=>item.status==="fulfilled").length,1);
  assert.equal(pair.filter(item=>item.status==="rejected"&&item.reason.code==="MERGE_IN_PROGRESS").length,1);
  assert.equal((await service.merge(f.req,left,{targetId:right,confirmName:"Left"})).idempotent,true);
  await assert.rejects(service.merge({user:{uid:"other"}},target,{targetId:source,confirmName:"Beta"}),{status:404,code:"PROJECT_NOT_FOUND"});
});

// ---- 6. Grandfathering ----
test("grandfathering: a one-time-$5 project and the legacy free project stay active with quota",()=>{
  for(const w of [base,{...base,kind:"free",accountKey:owner,projectFeeStatus:"free"}]){
    assert.equal(projectStatus(w),"active");assert.equal(effectiveStorageQuota(w),2e9);
  }
});
test("grandfathering: grandfathered projects are never lapsed or charged by the monthly policy",()=>{
  const {evaluateLapse,LAPSE_GRACE_MS}=require("./workspace_policy");
  assert.equal(policyFor({},[base]).grandfatheredProjects,1);
  const free={...base,kind:"free",accountKey:owner,projectFeeStatus:"free"};
  assert.equal(policyFor({},[base,free]).grandfatheredProjects,2);
  assert.equal(evaluateLapse(base,Date.now()+LAPSE_GRACE_MS).lapsed,false);
  assert.equal(evaluateLapse(free,Date.now()+LAPSE_GRACE_MS).lapsed,false);
  const end=1_700_000_000_000;
  assert.equal(evaluateLapse({...base,workspaceFeeModel:"monthly",workspaceFeeStatus:"past_due",workspaceFeePeriodEndMs:end},end+LAPSE_GRACE_MS).lapsed,true);
});
