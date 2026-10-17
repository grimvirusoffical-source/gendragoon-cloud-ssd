"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {memoryFirestore}=require("./test_firestore");
const {createProjectService,effectiveStorageQuota,qualifiesForHigherLimit,policyFor}=require("./projects");
const {effectiveWorkers,storageQuote,priceKeysStorage}=require("./billing_v2");
const owner=crypto.createHash("sha256").update("project-test-owner").digest("hex"),other="b".repeat(64);
const idFor=n=>"12345678-1234-4000-8000-"+String(n).padStart(12,"0");
const base={kind:"paid",accountHash:owner,name:"Existing project",projectBillingVersion:2,projectStatus:"active",projectFeeStatus:"paid",
 provisioned:true,storageActive:false,performanceActive:false,usedBytes:0,reservedBytes:0};
function fixture({configured=true,ownerBenefits=false}={}){
 const db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_own"}]]),sessions=new Map(),calls=[],expired=[],intents=new Map();
 const price={id:"price_project",active:true,type:"one_time",recurring:null,currency:"usd",unit_amount:500,billing_scheme:"per_unit",livemode:false,product:{active:true}};
 const stripe={prices:{retrieve:async()=>({...price})},checkout:{sessions:{
   retrieve:async id=>{if(!sessions.has(id))throw Error("missing session");return structuredClone(sessions.get(id));},
   create:async(args,options)=>{const repeated=calls.find(c=>c.options.idempotencyKey===options.idempotencyKey);if(repeated)return structuredClone(sessions.get(repeated.id));
     const id="cs_project"+(calls.length+1);calls.push({id,args,options});
     const data={...args,id,status:"open",payment_status:"unpaid",currency:"usd",amount_total:500,url:"https://checkout.stripe.com/c/pay/"+id};sessions.set(id,data);return structuredClone(data);},
   expire:async id=>{expired.push(id);sessions.get(id).status="expired";return sessions.get(id);},
   listLineItems:async id=>({has_more:false,data:sessions.get(id).line_items.map(line=>({price:{id:line.price},quantity:line.quantity}))})
 }},paymentIntents:{retrieve:async id=>structuredClone(intents.get(id))},charges:{retrieve:async()=>{throw Error("unexpected charge lookup");}}};
 const env={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_PROJECT_CHECKOUT_READY:"true",STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example",...(configured?{STRIPE_PROJECT_CREATION_PRICE_ID:"price_project"}:{})};
 const service=createProjectService({db,stamp:()=>123,hash:uid=>uid==="other"?other:owner,stripe,env,ensureCustomer:async()=>"cus_own"});
 const req={user:{uid:"owner"},ownerBenefits};
 const path=id=>id==="free"?"tenants/"+owner+"/workspaces/free":"gd_accounts/"+owner+"/workspaces/"+id;
 const create=(n,name="Project "+n)=>service.create(req,{name,intentId:idFor(n)});
 const put=(id,value={})=>db.rows.set(path(id),{...base,...value});
 function paidSession(id,intentId="pi_project1"){
   const record=db.rows.get(path(id)),s=sessions.get(record.projectCheckoutSessionId);s.status="complete";s.payment_status="paid";s.payment_intent=intentId;
   intents.set(intentId,{id:intentId,status:"succeeded",customer:"cus_own",currency:"usd",amount_received:500,
     latest_charge:{id:"ch_project1",refunded:false,disputed:false,amount_refunded:0,amount_captured:500}});return structuredClone(s);
 }
 return {db,service,req,create,put,path,price,stripe,sessions,calls,expired,intents,paidSession,record:id=>db.rows.get(path(id))};
}
test("parallel creation reserves at most10 slots and grants exactly one lifetime free project",async()=>{
 const f=fixture(),results=await Promise.allSettled(Array.from({length:32},(_,i)=>f.create(i+1)));
 assert.equal(results.filter(x=>x.status==="fulfilled").length,10);
 assert.equal(results.filter(x=>x.status==="rejected"&&x.reason.code==="PROJECT_LIMIT_REACHED").length,22);
 const list=await f.service.inventory(f.req);assert.equal(list.policy.usedProjectSlots,10);
 assert.equal(list.records.filter(w=>w.data.projectFeeStatus==="free").length,1);
 assert.equal(list.records.filter(w=>w.data.projectFeeStatus==="pending").length,9);
 assert.equal(f.calls.length,0);assert.equal(list.policy.freeProjectAvailable,false);
});
test("the upper cap requires both active qualifying entitlements on the same project",()=>{
 const storage={...base,storageTier:"2TB",storageActive:true,storageMode:"standard"};
 assert.equal(qualifiesForHigherLimit(storage),false);
 assert.equal(qualifiesForHigherLimit({...storage,performanceActive:true,performanceTier:"boost"}),false);
 assert.equal(qualifiesForHigherLimit({...storage,performanceActive:true,performanceTier:"turbo"}),true);
 assert.equal(qualifiesForHigherLimit({...storage,storageMode:"bundle"}),true);
 for(const patch of [{projectStatus:"archived"},{provisioned:false},{storageActive:false},{storageTier:"1TB"},{projectFeeStatus:"pending"}])
   assert.equal(qualifiesForHigherLimit({...storage,storageMode:"bundle",...patch}),false);
 assert.equal(policyFor({},[storage,{...base,storageTier:"1TB",storageActive:true,performanceActive:true,performanceTier:"max"}]).projectLimit,10);
});
test("qualified accounts atomically reserve at most20 projects and owner waiver does not bypass the cap",async()=>{
 const f=fixture({ownerBenefits:true});f.put(idFor(1),{storageActive:true,storageTier:"2TB",storageMode:"bundle"});
 const results=await Promise.allSettled(Array.from({length:30},(_,i)=>f.create(i+2)));
 assert.equal(results.filter(x=>x.status==="fulfilled").length,19);
 const list=await f.service.inventory(f.req);assert.equal(list.policy.projectLimit,20);
 assert.equal(list.policy.usedProjectSlots,20);assert.equal(list.policy.ownerFeeWaived,true);
 assert.equal(list.records.filter(w=>w.data.projectFeeStatus==="owner").length,19);assert.equal(f.calls.length,0);
});
test("archiving cannot reset the free allowance, including the legacy/v1 creation path",async()=>{
 const f=fixture();await f.create(1);f.db.rows.set(f.path(idFor(1))+"/files/file1",{name:"kept.bin",sizeBytes:7});
 await f.service.archive(f.req,idFor(1),{confirmName:"Project 1"});
 assert.equal(f.record(idFor(1)).dataRetained,true);assert.equal(f.db.rows.get(f.path(idFor(1))+"/files/file1").sizeBytes,7);
 const next=await f.create(2);assert.equal(next.project.data.projectFeeStatus,"pending");
 await assert.rejects(f.service.create(f.req,{name:"A second free project",legacyFree:true}),{code:"FREE_PROJECT_ALREADY_CLAIMED"});
 const restored=await f.service.restore(f.req,idFor(1));assert.equal(restored.newProjectFeeCharged,false);
 assert.equal(f.record(idFor(1)).projectFeeStatus,"free");assert.equal(effectiveStorageQuota(f.record(idFor(1))),2e9);
});
test("a migrated legacy free project consumes the lifetime allowance and can qualify when upgraded",async()=>{
 const f=fixture();f.put("free",{kind:"free",accountKey:owner,projectBillingVersion:undefined,projectStatus:undefined,
   storageActive:true,storageTier:"2TB",performanceActive:true,performanceTier:"turbo"});
 const list=await f.service.inventory(f.req);assert.equal(list.policy.freeProjectAvailable,false);assert.equal(list.policy.projectLimit,20);
 assert.equal(effectiveStorageQuota(f.record("free")),2e12);assert.equal(effectiveWorkers(f.record("free")),8);
 assert.equal((await f.create(2)).project.data.projectFeeStatus,"pending");
});
test("new storage subscriptions omit recurring workspace fees while legacy quotes remain exact",()=>{
 for(const interval of ["month","year"]){
   const old=storageQuote("2TB",interval,"standard"),next=storageQuote("2TB",interval,"standard",2);
   assert.equal(old.workspaceFeeCents,500*(interval==="year"?10:1));assert.equal(next.workspaceFeeCents,0);
   assert.equal(next.totalCents,7200*(interval==="year"?10:1));
   assert.equal(priceKeysStorage(old).length,2);assert.deepEqual(priceKeysStorage(next),["storage|standard|2TB|"+interval]);
 }
});
test("basic activated projects keep2GB after optional storage cancellation; pending and archived states grant no access",()=>{
 assert.equal(effectiveStorageQuota(base),2e9);assert.equal(effectiveWorkers(base),1);
 assert.equal(effectiveWorkers({...base,performanceActive:true,performanceTier:"turbo"}),8);
 assert.equal(effectiveStorageQuota({...base,storageActive:true,storageTier:"2TB"}),2e12);
 for(const status of ["archived","pending_payment","payment_revoked","payment_confirmed_pending_capacity"]){
   assert.equal(effectiveStorageQuota({...base,projectStatus:status,storageActive:true,storageTier:"6TB"}),0);
   assert.equal(effectiveWorkers({...base,projectStatus:status,performanceActive:true,performanceTier:"max"}),0);
 }
 assert.equal(effectiveStorageQuota({...base,projectFeeStatus:"pending"}),0);
});
test("the first free project works without payment configuration; additional projects fail closed before reservation",async()=>{
 const f=fixture({configured:false});await f.create(1);
 await assert.rejects(f.create(2),{code:"PROJECT_PAYMENT_UNAVAILABLE"});
 assert.equal((await f.service.inventory(f.req)).policy.usedProjectSlots,1);assert.equal(f.calls.length,0);
});
test("project Checkout uses exactly one configured one-time500-cent price and repeated requests reuse the session",async()=>{
 const f=fixture();await f.create(1);await f.create(2);
 const first=await f.service.checkout(f.req,idFor(2)),retry=await f.service.checkout(f.req,idFor(2));
 assert.equal(first.oneTimeCents,500);assert.equal(retry.resumed,true);assert.equal(f.calls.length,1);
 const args=f.calls[0].args;assert.equal(args.mode,"payment");assert.deepEqual(args.line_items,[{price:"price_project",quantity:1}]);
 assert.equal(args.payment_method_types,undefined);assert.equal(args.subscription_data,undefined);
 assert.equal(f.record(idFor(2)).provisioned,false);assert.equal(f.record(idFor(2)).checkoutLease,null);
});
test("a recurring, wrong-amount, inactive or wrong-mode Price cannot activate or charge a project",async()=>{
 for(const patch of [{type:"recurring",recurring:{interval:"month"}},{unit_amount:499},{active:false},{livemode:true},{currency:"eur"},{product:{active:false}}]){
   const f=fixture();await f.create(1);await f.create(2);Object.assign(f.price,patch);
   await assert.rejects(f.service.checkout(f.req,idFor(2)),{code:"PROJECT_PRICE_MISMATCH"});
   assert.equal(f.calls.length,0);assert.equal(f.record(idFor(2)).provisioned,false);
 }
});
test("unpaid or failed Checkout cannot fulfill; verified asynchronous success activates once and replays are idempotent",async()=>{
 const f=fixture();await f.create(1);await f.create(2);await f.service.checkout(f.req,idFor(2));
 const open=f.sessions.get(f.record(idFor(2)).projectCheckoutSessionId);
 assert.equal(await f.service.reconcilePayment({...open,status:"complete"}),false);
 assert.equal(await f.service.reconcilePayment({...open,status:"complete"},{failed:true}),true);
 assert.equal(f.record(idFor(2)).projectFeeStatus,"pending");
 const paid=f.paidSession(idFor(2));assert.equal(await f.service.reconcilePayment(paid),true);
 const revision=f.db.rows.get("gd_accounts/"+owner).projectRevision;
 assert.equal(await f.service.reconcilePayment(paid),true);
 assert.equal(f.db.rows.get("gd_accounts/"+owner).projectRevision,revision);
 assert.equal(f.record(idFor(2)).projectStatus,"active");assert.equal(f.record(idFor(2)).projectFeeStatus,"paid");assert.equal(f.calls.length,1);
});
test("payment fulfillment checks customer, exact line, quantity, amount and current charge state",async()=>{
 for(const variation of ["foreignCustomer","wrongPrice","extraQuantity","wrongAmount","refunded","disputed","wrongIntentCustomer"]){
   const f=fixture();await f.create(1);await f.create(2);await f.service.checkout(f.req,idFor(2));const paid=f.paidSession(idFor(2));
   if(variation==="foreignCustomer")paid.customer="cus_foreign";
   if(variation==="wrongPrice")f.sessions.get(paid.id).line_items[0].price="price_injected";
   if(variation==="extraQuantity")f.sessions.get(paid.id).line_items[0].quantity=2;
   if(variation==="wrongAmount")paid.amount_total=1;
   if(variation==="refunded")f.intents.get(paid.payment_intent).latest_charge.refunded=true;
   if(variation==="disputed")f.intents.get(paid.payment_intent).latest_charge.disputed=true;
   if(variation==="wrongIntentCustomer")f.intents.get(paid.payment_intent).customer="cus_foreign";
   assert.equal(await f.service.reconcilePayment(paid),false,variation);assert.equal(f.record(idFor(2)).provisioned,false,variation);
 }
});
test("refund/dispute revocation is durable even when a paid-completion event is replayed later",async()=>{
 const f=fixture();await f.create(1);await f.create(2);await f.service.checkout(f.req,idFor(2));const paid=f.paidSession(idFor(2));
 await f.service.reconcilePayment(paid);await f.service.revokePayment(paid.payment_intent,"charge.dispute.created");
 assert.equal(f.record(idFor(2)).projectStatus,"payment_revoked");assert.equal(effectiveStorageQuota(f.record(idFor(2))),0);
 assert.equal(await f.service.reconcilePayment(paid),false);assert.equal(f.record(idFor(2)).projectFeeStatus,"revoked");
});
test("capacity is rechecked transactionally on payment; confirmed money is retained without fabricated access",async()=>{
 const f=fixture();f.put(idFor(1),{storageActive:true,storageTier:"2TB",storageMode:"bundle"});
 for(let n=2;n<=11;n++)await f.create(n);
 await f.service.checkout(f.req,idFor(11));const paid=f.paidSession(idFor(11));
 f.put(idFor(1),{storageActive:false});
 assert.equal(await f.service.reconcilePayment(paid),true);
 assert.equal(f.record(idFor(11)).projectStatus,"payment_confirmed_pending_capacity");assert.equal(f.record(idFor(11)).projectFeeStatus,"paid");
 await assert.rejects(f.service.restore(f.req,idFor(11)),{code:"PROJECT_LIMIT_REACHED"});
 await f.service.archive(f.req,idFor(2),{confirmName:"Project 2"});
 assert.equal((await f.service.restore(f.req,idFor(11))).newProjectFeeCharged,false);assert.equal(f.record(idFor(11)).projectStatus,"active");
});
test("archiving requires exact name and billing acknowledgement and preserves the subscription and all file data",async()=>{
 const f=fixture();f.put(idFor(1),{storageSubscriptionId:"sub_keep",storageStatus:"active",usedBytes:7});
 const filePath=f.path(idFor(1))+"/files/kept";f.db.rows.set(filePath,{name:"kept.bin",sizeBytes:7});
 await assert.rejects(f.service.archive(f.req,idFor(1),{confirmName:"wrong"}),{code:"CONFIRM_NAME_REQUIRED"});
 await assert.rejects(f.service.archive(f.req,idFor(1),{confirmName:"Existing project"}),{code:"BILLING_ACKNOWLEDGEMENT_REQUIRED"});
 const result=await f.service.archive(f.req,idFor(1),{confirmName:"Existing project",acknowledgeBillingContinues:true});
 assert.equal(result.dataRetained,true);assert.equal(result.subscriptionsCanceled,false);assert.equal(f.record(idFor(1)).storageSubscriptionId,"sub_keep");
 assert.equal(f.db.rows.get(filePath).sizeBytes,7);assert.equal(f.record(idFor(1)).usedBytes,7);
});
test("reserved bytes or any active upload prevent archiving; no cleanup is attempted",async()=>{
 const f=fixture();f.put(idFor(1),{reservedBytes:1});
 await assert.rejects(f.service.archive(f.req,idFor(1),{confirmName:"Existing project"}),{code:"PROJECT_HAS_PENDING_UPLOADS"});
 f.put(idFor(1));for(const status of ["active","assembling","committing","composing","verifying"]){
   f.db.rows.set(f.path(idFor(1))+"/uploads/pending",{status,sizeBytes:7});
   await assert.rejects(f.service.archive(f.req,idFor(1),{confirmName:"Existing project"}),{code:"PROJECT_HAS_PENDING_UPLOADS"});
 }
 assert.equal(f.record(idFor(1)).projectStatus,"active");assert.equal(f.db.rows.get(f.path(idFor(1))+"/uploads/pending").sizeBytes,7);
});
test("a Checkout creation lease prevents archive and concurrent Checkout from racing",async()=>{
 const f=fixture();await f.create(1);let release,started;
 const ready=new Promise(resolve=>{started=resolve;});
 const task=f.service.withLease(f.req,idFor(1),async()=>{started();await new Promise(resolve=>{release=resolve;});});
 await ready;
 await assert.rejects(f.service.archive(f.req,idFor(1),{confirmName:"Project 1"}),{code:"CHECKOUT_BUSY"});
 await assert.rejects(f.service.withLease(f.req,idFor(1),async()=>{}),{code:"CHECKOUT_BUSY"});
 release();await task;assert.equal(f.record(idFor(1)).checkoutLease,null);
});
test("archiving detects a newly persisted Checkout even after its creation lease has been released",async()=>{
 const f=fixture();f.put(idFor(1));const original=f.db.runTransaction;
 f.db.runTransaction=fn=>{f.put(idFor(1),{storageCheckoutSessionId:"cs_newDuringArchive"});return original(fn);};
 await assert.rejects(f.service.archive(f.req,idFor(1),{confirmName:"Existing project"}),{code:"CHECKOUT_BUSY"});
 assert.equal(f.record(idFor(1)).projectStatus,"active");
});
test("archive expires only the owned unpaid session and refuses an unsettled completed payment",async()=>{
 const f=fixture();await f.create(1);await f.create(2);await f.service.checkout(f.req,idFor(2));
 const sessionId=f.record(idFor(2)).projectCheckoutSessionId;f.sessions.get(sessionId).status="complete";
 await assert.rejects(f.service.archive(f.req,idFor(2),{confirmName:"Project 2"}),{code:"PAYMENT_PENDING"});
 f.sessions.get(sessionId).status="open";
 await f.service.archive(f.req,idFor(2),{confirmName:"Project 2"});assert.deepEqual(f.expired,[sessionId]);
 assert.equal(f.record(idFor(2)).projectStatus,"archived");assert.equal(f.record(idFor(2)).projectFeeStatus,"pending");
});
test("restore cannot exceed the cap or manufacture a paid activation for an unpaid archived project",async()=>{
 const f=fixture();await f.create(1);await f.create(2);await f.service.archive(f.req,idFor(2),{confirmName:"Project 2"});
 for(let n=3;n<=11;n++)await f.create(n);
 await assert.rejects(f.service.restore(f.req,idFor(2)),{code:"PROJECT_LIMIT_REACHED"});
 await f.service.archive(f.req,idFor(3),{confirmName:"Project 3"});
 const result=await f.service.restore(f.req,idFor(2));assert.equal(result.projectStatus,"pending_payment");assert.equal(f.record(idFor(2)).provisioned,false);
});
test("restoring a still-qualified project restores the20-slot cap atomically; canceled benefits or a21st slot remain denied",async()=>{
 for(const mode of ["standard","bundle"]){
   const f=fixture();f.put(idFor(1),{projectStatus:"archived",statusBeforeArchive:"active",storageActive:true,storageTier:"2TB",storageMode:mode,
     performanceActive:mode==="standard",performanceTier:mode==="standard"?"turbo":null});
   for(let n=2;n<=20;n++)f.put(idFor(n));
   assert.equal((await f.service.inventory(f.req)).policy.projectLimit,10);
   const restored=await f.service.restore(f.req,idFor(1));assert.equal(restored.projectStatus,"active");assert.equal(restored.newProjectFeeCharged,false);
   const policy=(await f.service.inventory(f.req)).policy;assert.equal(policy.projectLimit,20);assert.equal(policy.usedProjectSlots,20);assert.equal(f.calls.length,0);
   await f.service.archive(f.req,idFor(1),{confirmName:"Existing project"});
   f.record(idFor(1)).storageActive=false;
   await assert.rejects(f.service.restore(f.req,idFor(1)),{code:"PROJECT_LIMIT_REACHED"});
   assert.equal(f.record(idFor(1)).projectStatus,"archived");
   f.record(idFor(1)).storageActive=true;f.put(idFor(21));
   await assert.rejects(f.service.restore(f.req,idFor(1)),{code:"PROJECT_LIMIT_REACHED"});
   assert.equal(f.record(idFor(1)).projectStatus,"archived");
 }
});
test("retained selections are per account and project and do not modify verified entitlements",async()=>{
 const f=fixture();await f.create(1);await f.create(2);
 await f.service.setSelection(f.req,idFor(1),{storageTier:"6TB",storageMode:"bundle",storageInterval:"year"});
 await f.service.setSelection(f.req,idFor(1),{performanceTier:"turbo",performanceInterval:"month"});
 assert.deepEqual(f.record(idFor(1)).intendedSelection,{storageTier:"6TB",storageMode:"bundle",storageInterval:"year",performanceTier:"turbo",performanceInterval:"month"});
 assert.deepEqual(f.record(idFor(2)).intendedSelection,{});assert.equal(f.record(idFor(1)).storageActive,false);assert.equal(f.record(idFor(1)).performanceActive,false);
 await assert.rejects(f.service.setSelection({user:{uid:"other"}},idFor(1),{storageTier:"6TB"}),{code:"PROJECT_NOT_FOUND"});
 await assert.rejects(f.service.setSelection(f.req,idFor(1),{storageTier:"__proto__"}),{code:"INVALID_SELECTION"});
 await assert.rejects(f.service.setSelection(f.req,idFor(1),{ownerBenefits:true,storageActive:true}),{code:"INVALID_SELECTION"});
});
module.exports={fixture};
