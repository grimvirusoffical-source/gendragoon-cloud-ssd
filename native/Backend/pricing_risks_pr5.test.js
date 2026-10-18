"use strict";
// QA risk tests for PR #5 pricing (one free hosted workspace at a time).
// Local only: in-memory Firestore and a recording Stripe double. No network, no credentials.
// Riley's pinned rules (lower id wins ties, grandfathered never free, 0 cents iff isFree||grandfathered,
// grandfathered-plus-new fixture) FAIL on 568f223 and PASS on 4c3dd13. They are plain tests here because
// this branch is based on 4c3dd13; their names start with "[568f223 xfail]".
// BUG(pr5): defects still present on 4c3dd13, marked node:test todo so CI stays green until fixed.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {createProjectService,freeWorkspaceId}=require("./projects");
const {WORKSPACE_FEE_CENTS,GRANDFATHER_CUTOFF_MS,LAPSE_GRACE_MS,summarizeProjects}=require("./workspace_policy");
const {registerBillingV2}=require("./billing_v2");
const {registerPaidStorage}=require("./paid_storage");

const BUG="BUG(pr5) expected-fail on 568f223 and 4c3dd13";
const owner=crypto.createHash("sha256").update("pricing-risk-owner").digest("hex");
const idFor=n=>"22222222-2222-4222-8222-"+String(n).padStart(12,"0");
const AFTER=Date.parse("2026-10-18T00:00:00Z");
const BEFORE=Date.parse("2026-09-01T00:00:00Z");
const byoBody={provider:"s3",endpoint:"https://bucket.s3.us-east-1.amazonaws.com",bucketFingerprint:"cd".repeat(8)};
const monthlyPrice={id:"price_month",active:true,type:"recurring",recurring:{interval:"month"},currency:"usd",unit_amount:500,
 billing_scheme:"per_unit",livemode:false,product:{active:true}};

function stripeDouble(){
 const calls=[];
 return {calls,
  prices:{retrieve:async()=>({...monthlyPrice})},
  customers:{create:async()=>({id:"cus_own"})},
  checkout:{sessions:{create:async()=>({id:"cs_month",url:"https://checkout.stripe.com/c/pay/cs_month",status:"open"}),
   retrieve:async()=>({status:"open",url:"https://checkout.stripe.com/c/pay/cs_month",metadata:{}}),expire:async id=>{calls.push(["checkout.expire",id]);}}},
  subscriptions:{
   cancel:async(id,params,opts)=>{calls.push(["subscriptions.cancel",id,params,opts]);return {id,status:"canceled"};},
   update:async(id,params,opts)=>{calls.push(["subscriptions.update",id,params,opts]);return {id};},
   retrieve:async id=>({id,status:"active"})},
  subscriptionItems:{del:async(id,params)=>{calls.push(["subscriptionItems.del",id,params]);return {id,deleted:true};}}};
}
const env={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_WORKSPACE_MONTHLY_READY:"true",STRIPE_WORKSPACE_MONTHLY_PRICE_ID:"price_month",
 STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example"};

function fixture({clockStart=AFTER}={}){
 const db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_own"}]]);
 const stripe=stripeDouble();
 let clock=clockStart;
 const service=createProjectService({db,stamp:()=>clock,hash:()=>owner,stripe,env,ensureCustomer:async()=>"cus_own"});
 const req={user:{uid:"owner"}},ownerReq={user:{uid:"owner"},ownerBenefits:true};
 const path=id=>"gd_accounts/"+owner+"/workspaces/"+id;
 return {db,stripe,service,req,ownerReq,path,
  tick:(ms=1000)=>{clock+=ms;},setClock:v=>{clock=v;},
  create:(n,name,r=req)=>service.create(r,{name:name||"Project "+n,intentId:idFor(n)}),
  put:(n,data)=>db.rows.set(path(idFor(n)),{accountHash:owner,name:"Seed "+n,...data}),
  record:n=>db.rows.get(path(typeof n==="number"?idFor(n):n)),
  account:()=>db.rows.get("gd_accounts/"+owner)};
}
const paidActive=(extra={})=>({kind:"paid",projectBillingVersion:2,projectStatus:"active",projectFeeStatus:"pending",provisioned:true,
 storageActive:false,performanceActive:false,usedBytes:0,reservedBytes:0,workspaceFeeModel:"monthly",feeIsOneTime:false,
 workspaceFeeStatus:"active",workspaceFeePaid:true,workspaceFeeCents:500,createdAt:AFTER,...extra});
const grandfathered=(extra={})=>({kind:"paid",projectBillingVersion:2,projectStatus:"active",projectFeeStatus:"paid",feeIsOneTime:true,
 provisioned:true,storageActive:false,performanceActive:false,usedBytes:0,reservedBytes:0,createdAt:BEFORE,...extra});
function sub(n,status="active"){return {id:"sub_ws_"+n,status,customer:"cus_own",metadata:{kind:"workspace_fee",accountHash:owner,workspaceId:idFor(n)}};}
function invoice(endSec){return {lines:{data:[{period:{end:endSec}}]}};}
function priceView(f,inventory,n){
 const id=typeof n==="number"?idFor(n):n;
 const {workspacePrice}=require("./projects");
 const w=inventory.records.find(r=>r.id===id);
 return workspacePrice({...w.data,id},inventory.policy.freeWorkspaceId);
}

// ---- HTTP harness (same handlers the fixtures use) ----
async function http(f){
 const app=express();app.use(express.json({limit:"16kb"}));
 const auth=(req,res,next)=>{const t=(req.headers.authorization||"").replace(/^Bearer /,"");
  if(t==="owner"){req.user={uid:"owner"};return next();}
  if(t==="ownerbenefits"){req.user={uid:"owner"};req.ownerBenefits=true;return next();}
  res.status(401).json({error:"Sign in required"});};
 registerBillingV2({app,db:f.db,stripe:f.stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>Date.now()}}},
  auth,agreed:(_q,_s,n)=>n(),hash:()=>owner,prices:{},env,byoFetch:null});
 registerPaidStorage({app,db:f.db,bucket:{file:()=>({})},accountKey:()=>owner,
  FieldValue:{increment:n=>({increment:n}),serverTimestamp:()=>Date.now()},
  apiKeys:{verify:async()=>null},getAuth:()=>({}),firebaseAuth:auth});
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
 const base="http://127.0.0.1:"+server.address().port;
 const call=async(method,p,body,token="owner")=>{
  const r=await fetch(base+p,{method,headers:{authorization:"Bearer "+token,...(body?{"content-type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
  const text=await r.text();let json=null;try{json=JSON.parse(text);}catch(_){json=text;}
  return {status:r.status,body:json};};
 return {call,close:()=>new Promise(r=>server.close(r))};
}
function collectPriced(body,out=[]){
 if(Array.isArray(body)){for(const x of body)collectPriced(x,out);return out;}
 if(body&&typeof body==="object"){
  if("isFree" in body||"monthlyPriceCents" in body)out.push(body);
  for(const k of Object.keys(body))collectPriced(body[k],out);
 }
 return out;
}

// ===== 1. Tie-break on equal createdAt =====
test("tie-break: equal createdAt picks the lower workspace id, regardless of input order",()=>{
 const a={...paidActive({createdAt:AFTER}),id:idFor(1)},b={...paidActive({createdAt:AFTER}),id:idFor(2)};
 assert.equal(freeWorkspaceId({},[a,b]),idFor(1));
 assert.equal(freeWorkspaceId({},[b,a]),idFor(1));
 // Firestore Timestamp and seconds/millis forms of the same instant tie too.
 const ts={toMillis:()=>AFTER};
 const c={...paidActive({createdAt:ts}),id:idFor(9)},d={...paidActive({createdAt:AFTER/1000}),id:idFor(3)};
 assert.equal(freeWorkspaceId({},[c,d]),idFor(3));
 assert.equal(freeWorkspaceId({},[d,c]),idFor(3));
 // Uppercase vs lowercase ids are not normalised by the sort; ids are created lowercase, so just document it.
 for(let i=0;i<20;i++){
  const shuffled=[a,b,c,d].sort(()=>Math.random()-0.5);
  assert.equal(freeWorkspaceId({},shuffled),idFor(1));
 }
});

test("tie-break through the service: two creates stamped in the same millisecond, lower id is free when the slot reopens",async()=>{
 const f=fixture();
 await f.create(1,"Keeper");                         // free
 await f.create(3,"Same ms high");                  // paid, same createdAt as next
 await f.create(2,"Same ms low");                   // paid, same createdAt
 assert.equal(f.record(2).createdAt,f.record(3).createdAt);
 await f.service.remove(f.req,idFor(1));
 assert.equal(f.account().freeWorkspaceId,idFor(2));
 assert.equal(f.record(2).projectFeeStatus,"free");
 assert.equal(f.record(3).projectFeeStatus,"pending");
});

test("legacy row with no createdAt is treated as newest (sorts last), not oldest",()=>{
 // Documenting current behaviour: a pre-createdAt legacy row is really the oldest, but byCreated puts it last.
 const legacy={kind:"free",projectStatus:"active",provisioned:true,id:"free"};
 const newer={...paidActive({createdAt:AFTER}),id:idFor(5)};
 assert.equal(freeWorkspaceId({},[legacy,newer]),idFor(5));
});

// ===== 2. Grandfathered =====
test("[568f223 xfail] grandfathered never takes the free slot; the oldest non-grandfathered hosted workspace does",async()=>{
 const f=fixture();
 f.put(1,grandfathered());
 const fresh=await f.create(2,"New after cutoff");
 assert.equal(fresh.isFree,true,"new hosted workspace should be free");
 assert.equal(fresh.monthlyPriceCents,0);
 const inv=await f.service.inventory(f.req);
 assert.equal(inv.policy.freeWorkspaceId,idFor(2));
 assert.deepEqual(priceView(f,inv,1),{isFree:false,monthlyPriceCents:0});
});

test("grandfathered workspace is never billed: list shows monthlyPriceCents 0 and grandfathered:true",async()=>{
 const f=fixture();
 f.put(1,grandfathered());
 f.put(2,grandfathered({feeIsOneTime:false,projectFeeStatus:"free",createdAt:BEFORE+1}));
 f.put(3,{kind:"free",projectStatus:"active",provisioned:true}); // legacy-shaped row with no createdAt
 const h=await http(f);
 try{
  const list=await h.call("GET","/v2/workspaces");
  assert.equal(list.status,200);
  for(const w of list.body.workspaces){
   assert.equal(w.grandfathered,true,w.id);
   assert.equal(w.monthlyPriceCents,0,w.id);
   assert.equal(w.lapsed,false,w.id);
  }
  assert.equal(f.stripe.calls.length,0);
 }finally{await h.close();}
});

test("[568f223 xfail] grandfathered-plus-new fixture exists",()=>{
 const fs=require("node:fs"),p=require("node:path");
 assert.ok(fs.existsSync(p.join(__dirname,"../../fixtures/workspaces/grandfathered-plus-new.json")));
});

test("registering BYO on a grandfathered workspace strips grandfathering and locks the account at once (documents current behaviour)",async()=>{
 const f=fixture();
 f.put(1,grandfathered());
 f.put(2,grandfathered({createdAt:BEFORE+5}));
 const r=await f.service.registerByo(f.req,idFor(1),byoBody);
 assert.equal(r.monthlyPriceCents,500);
 assert.equal(r.lapsed,true);
 assert.equal(f.record(1).workspaceFeeModel,"monthly");
 const inv=await f.service.inventory(f.req);
 assert.equal(inv.policy.locked,true);
 assert.equal(inv.policy.reason,"lapsed");
});

// ===== 3. hosted -> BYO -> hosted =====
test("hosted -> BYO -> hosted through the service keeps createdAt and regains the slot (568f223 has no makeHosted: gap)",async t=>{
 const f=fixture();
 if(typeof f.service.makeHosted!=="function"){t.diagnostic("568f223: no service/API path leaves BYO");return;}
 await f.create(1,"Oldest");f.tick();
 await f.create(2,"Second");
 const created=f.record(1).createdAt;
 await f.service.registerByo(f.req,idFor(1),byoBody);
 assert.equal(f.account().freeWorkspaceId,idFor(2));
 const r=await f.service.makeHosted(f.req,idFor(1));
 assert.equal(f.record(1).createdAt,created);
 assert.equal(r.freeWorkspaceId,idFor(1));
 assert.equal(f.record(1).projectFeeStatus,"free");
 const inv=await f.service.inventory(f.req);
 assert.equal(inv.policy.freeWorkspaceId,idFor(1));
 assert.deepEqual(priceView(f,inv,2),{isFree:false,monthlyPriceCents:500});
});
test("hosted -> BYO -> hosted regains eligibility by its original createdAt (data level; passes on 568f223)",async()=>{
 const f=fixture();
 await f.create(1,"Oldest");f.tick();
 await f.create(2,"Second");
 await f.service.registerByo(f.req,idFor(1),byoBody);
 assert.equal(f.account().freeWorkspaceId,idFor(2));
 const created=f.record(1).createdAt;
 // Simulate returning to hosted (no API exists; see gap test): clear the BYO markers.
 const back={...f.record(1)};delete back.providerType;delete back.endpoint;back.byoRegistered=false;
 f.db.rows.set(f.path(idFor(1)),back);
 assert.equal(f.record(1).createdAt,created,"createdAt must survive the round trip");
 // Eligible again by original createdAt: deleting the current free one must hand the slot back to #1 first.
 await f.service.remove(f.req,idFor(2));
 assert.equal(f.account().freeWorkspaceId,idFor(1));
 assert.equal(f.record(1).projectFeeStatus,"free");
 // And its leftover monthly BYO fee state must be cleared, or it is "free" but still on the monthly model.
 assert.notEqual(f.record(1).workspaceFeeModel,"monthly");
});

// ===== 4. isFree / monthlyPriceCents invariant on every response =====
async function invariantScenario(){
 const f=fixture();
 const h=await http(f);
 const seen=[];
 const keep=(label,res)=>{for(const item of collectPriced(res.body))seen.push({label,status:res.status,item});return res;};
 try{
  f.put(9,grandfathered({createdAt:BEFORE}));
  keep("create-1",await h.call("POST","/v2/projects",{name:"First",intentId:idFor(1)}));
  keep("create-2",await h.call("POST","/v2/projects",{name:"Second",intentId:idFor(2)}));
  keep("create-owner",await h.call("POST","/v2/projects",{name:"Owner perk",intentId:idFor(3)},"ownerbenefits"));
  keep("byo",await h.call("POST","/v2/workspaces/"+idFor(2)+"/byo/register",byoBody));
  keep("list-workspaces",await h.call("GET","/v2/workspaces"));
  keep("list-projects",await h.call("GET","/v2/projects?includeArchived=true"));
  for(const n of [1,2,3,9]){
   keep("get-project-"+n,await h.call("GET","/v2/projects/"+idFor(n)));
   keep("get-workspace-"+n,await h.call("GET","/v2/workspaces/"+idFor(n)));
  }
  keep("delete-1",await h.call("DELETE","/v2/projects/"+idFor(1)));
  keep("list-after-delete",await h.call("GET","/v2/workspaces"));
 }finally{await h.close();}
 return seen;
}
test("isFree:true always means monthlyPriceCents 0, on every list/create/get/BYO response",async()=>{
 const seen=await invariantScenario();
 assert.ok(seen.length>10);
 for(const {label,item} of seen){
  if(item.isFree===true)assert.equal(item.monthlyPriceCents,0,label);
  assert.ok(item.monthlyPriceCents===0||item.monthlyPriceCents===WORKSPACE_FEE_CENTS,label);
  assert.equal(typeof item.isFree,"boolean",label);
 }
});
test("[568f223 xfail] invariant: monthlyPriceCents is 0 exactly when isFree or grandfathered",async()=>{
 const seen=await invariantScenario();
 const bad=seen.filter(({item})=>"grandfathered" in item&&((item.monthlyPriceCents===0)!==(item.isFree===true||item.grandfathered===true)));
 assert.deepEqual(bad.map(b=>b.label+":"+(b.item.id||b.item.workspaceId)),[]);
});
test("at most one isFree:true per list, and it equals policy.freeWorkspaceId",async()=>{
 const f=fixture();await f.create(1);await f.create(2);await f.create(3);
 const h=await http(f);
 try{
  for(const p of ["/v2/workspaces","/v2/projects","/v2/projects?includeArchived=true"]){
   const r=await h.call("GET",p),items=r.body.workspaces||r.body.projects;
   const free=items.filter(w=>w.isFree);
   assert.equal(free.length,1,p);
   assert.equal(free[0].id,r.body.policy.freeWorkspaceId,p);
  }
 }finally{await h.close();}
});

// ===== 5. Slot moves after delete: billing side effects =====
test("deleting the free workspace promotes the next hosted one in Firestore (display side)",async()=>{
 const f=fixture();
 await f.create(1,"Free");f.tick();
 await f.create(2,"Paid");
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:invoice(Math.floor(AFTER/1000)+30*86400)});
 assert.equal(f.record(2).workspaceFeeSubscriptionId,"sub_ws_2");
 await f.service.remove(f.req,idFor(1));
 const inv=await f.service.inventory(f.req);
 assert.equal(inv.policy.freeWorkspaceId,idFor(2));
 assert.deepEqual(priceView(f,inv,2),{isFree:true,monthlyPriceCents:0});
 // Promotion clears the fee model but leaves the live Stripe subscription id behind.
 assert.equal(f.record(2).workspaceFeeModel,null);
 assert.equal(f.record(2).workspaceFeeSubscriptionId,"sub_ws_2");
});
test("promoted workspace: its $5 Stripe subscription is cancelled or prorated",{todo:BUG},async()=>{
 const f=fixture();
 await f.create(1,"Free");f.tick();
 await f.create(2,"Paid");
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:invoice(Math.floor(AFTER/1000)+30*86400)});
 await f.service.remove(f.req,idFor(1));
 const touched=f.stripe.calls.filter(c=>c[1]==="sub_ws_2"&&/subscriptions\.(cancel|update)/.test(c[0]));
 assert.equal(touched.length,1,"expected one cancel/update (with proration) for sub_ws_2, got "+JSON.stringify(f.stripe.calls));
});
test("promoted workspace: the next invoice.paid webhook flips it back to monthly while it still shows isFree:true",async()=>{
 const f=fixture();
 await f.create(1,"Free");f.tick();
 await f.create(2,"Paid");
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:invoice(Math.floor(AFTER/1000)+30*86400)});
 await f.service.remove(f.req,idFor(1));
 // Stripe keeps charging: next month's invoice.paid arrives.
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:invoice(Math.floor(AFTER/1000)+60*86400)});
 assert.equal(f.record(2).workspaceFeeModel,"monthly");
 assert.equal(f.record(2).workspaceFeeStatus,"active");
 const inv=await f.service.inventory(f.req);
 assert.deepEqual(priceView(f,inv,2),{isFree:true,monthlyPriceCents:0}); // UI says free, Stripe bills $5
});
test("promoted workspace: if the user then cancels the leftover subscription, the FREE workspace lapses and 423-locks the account",async()=>{
 const f=fixture();
 await f.create(1,"Free");f.tick();
 await f.create(2,"Paid");
 const end=Math.floor(AFTER/1000)+30*86400;
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:invoice(end)});
 await f.service.remove(f.req,idFor(1));
 await f.service.reconcileWorkspaceFee(sub(2,"canceled"),{eventType:"customer.subscription.deleted"});
 const realNow=Date.now;
 try{
  Date.now=()=>end*1000+LAPSE_GRACE_MS+1;
  const inv=await f.service.inventory(f.req);
  assert.equal(inv.policy.freeWorkspaceId,idFor(2));
  assert.equal(inv.policy.locked,true);
  assert.deepEqual(inv.policy.unpaidWorkspaceIds,[idFor(2)]);
 }finally{Date.now=realNow;}
});
test("deleting a paid workspace cancels its Stripe subscriptions",{todo:BUG},async()=>{
 const f=fixture();
 await f.create(1,"Free");f.tick();
 await f.create(2,"Paid");
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:invoice(Math.floor(AFTER/1000)+30*86400)});
 f.db.rows.set(f.path(idFor(2)),{...f.record(2),storageSubscriptionId:"sub_storage_2"});
 await f.service.remove(f.req,idFor(2));
 const cancelled=f.stripe.calls.filter(c=>c[0]==="subscriptions.cancel").map(c=>c[1]).sort();
 assert.deepEqual(cancelled,["sub_storage_2","sub_ws_2"]);
});
test("deleted workspace: later Stripe webhooks for it are silently dropped (subscription keeps billing, no record)",async()=>{
 const f=fixture();
 await f.create(1,"Free");f.tick();await f.create(2,"Paid");
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:invoice(Math.floor(AFTER/1000)+30*86400)});
 await f.service.remove(f.req,idFor(2));
 const handled=await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:invoice(Math.floor(AFTER/1000)+60*86400)});
 assert.equal(handled,false);
 assert.equal(f.stripe.calls.filter(c=>c[0]==="subscriptions.cancel").length,0);
});
test("DELETE /v2/projects/:id leaves the files subcollection behind and ignores pending uploads / merge locks",async()=>{
 const f=fixture();
 await f.create(1,"Free");f.tick();await f.create(2,"Busy");
 f.db.rows.set(f.path(idFor(2))+"/files/f1",{name:"a.txt",sizeBytes:4,objectKey:"customer/"+owner+"/managed/"+idFor(2)+"/files/f1"});
 f.db.rows.set(f.path(idFor(2)),{...f.record(2),reservedBytes:10,mergeLock:{token:"t",sourceId:idFor(2),targetId:idFor(1),expiresAtMs:Date.now()+60000,phase:"copying"}});
 const r=await f.service.remove(f.req,idFor(2));
 assert.equal(r.deleted,true);                         // no 409 for reservedBytes or an active merge lock
 assert.ok(f.db.rows.get(f.path(idFor(2))+"/files/f1")); // orphaned file record (and its object)
});
test("promoting a pending-payment workspace does not expire its open Checkout session",async()=>{
 const f=fixture();
 await f.create(1,"Free");f.tick();await f.create(2,"Pending");
 await f.service.checkout(f.req,idFor(2));
 assert.equal(f.record(2).workspaceFeeCheckoutSessionId,"cs_month");
 await f.service.remove(f.req,idFor(1));
 assert.equal(f.record(2).projectFeeStatus,"free");
 assert.equal(f.record(2).workspaceFeeCheckoutSessionId,"cs_month"); // still payable
 assert.equal(f.stripe.calls.filter(c=>c[0]==="checkout.expire").length,0);
});

// ===== 6. Merge =====
test("merge free source into paid target with no other workspace: list shows target free but it keeps its $5 subscription",async()=>{
 const f=fixture();
 await f.create(1,"Free source");f.tick();await f.create(2,"Paid target");
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:invoice(Math.floor(AFTER/1000)+30*86400)});
 await f.service.merge(f.req,idFor(1),{targetId:idFor(2),confirmName:"Free source"});
 assert.equal(f.account().freeWorkspaceId,null);            // stored: nobody free
 const inv=await f.service.inventory(f.req);
 assert.equal(inv.policy.freeWorkspaceId,idFor(2));          // computed fallback: target free
 assert.deepEqual(priceView(f,inv,2),{isFree:true,monthlyPriceCents:0});
 assert.equal(f.record(2).workspaceFeeModel,"monthly");
 assert.equal(f.record(2).workspaceFeeStatus,"active");    // still billed by Stripe
 assert.equal(f.stripe.calls.filter(c=>c[1]==="sub_ws_2").length,0);
});
test("merge: stored freeWorkspaceId and the computed one always agree after a merge",{todo:BUG},async()=>{
 const f=fixture();
 await f.create(1,"Free source");f.tick();await f.create(2,"Paid target");
 await f.service.merge(f.req,idFor(1),{targetId:idFor(2),confirmName:"Free source"});
 const inv=await f.service.inventory(f.req);
 assert.equal(f.account().freeWorkspaceId,inv.policy.freeWorkspaceId);
 const p=priceView(f,inv,2);
 assert.equal(p.isFree,f.record(2).projectFeeStatus==="free");
});
test("merge paid source into free target cancels the source's subscriptions and keeps the target free",async()=>{
 const f=fixture();
 await f.create(1,"Free target");f.tick();await f.create(2,"Paid source");
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:invoice(Math.floor(AFTER/1000)+30*86400)});
 await f.service.merge(f.req,idFor(2),{targetId:idFor(1),confirmName:"Paid source"});
 assert.deepEqual(f.stripe.calls.filter(c=>c[0]==="subscriptions.cancel").map(c=>c[1]),["sub_ws_2"]);
 assert.equal(f.account().freeWorkspaceId,idFor(1));
 assert.equal(f.record(1).projectFeeStatus,"free");
});
test("merge free source with a third hosted workspace: slot goes to the oldest non-target; its subscription is not cancelled",async()=>{
 const f=fixture();
 await f.create(1,"Free source");f.tick();await f.create(2,"Target");f.tick();await f.create(3,"Third");
 await f.service.reconcileWorkspaceFee(sub(3),{eventType:"invoice.paid",invoice:invoice(Math.floor(AFTER/1000)+30*86400)});
 await f.service.merge(f.req,idFor(1),{targetId:idFor(2),confirmName:"Free source"});
 assert.equal(f.account().freeWorkspaceId,idFor(3));         // not the oldest remaining (#2): avoidId skips the target
 assert.equal(f.record(3).workspaceFeeSubscriptionId,"sub_ws_3");
 assert.equal(f.stripe.calls.filter(c=>c[1]==="sub_ws_3").length,0);
});

// ===== 7. 423 lapsed =====
async function upload(f,n){
 const h=await http(f);
 try{return await h.call("POST","/v2/workspaces/"+idFor(n)+"/cloud/uploads",{name:"x.txt",sizeBytes:4});}finally{await h.close();}
}
test("423: unpaid BYO blocks uploads on that workspace with reason lapsed",async()=>{
 const f=fixture();await f.create(1,"Only");await f.service.registerByo(f.req,idFor(1),byoBody);
 const r=await upload(f,1);
 assert.equal(r.status,423);assert.equal(r.body.reason,"lapsed");assert.deepEqual(r.body.unpaidWorkspaceIds,[idFor(1)]);
});
test("423: an unpaid BYO workspace also blocks uploads to the account's FREE hosted workspace (account-wide lock)",async()=>{
 const f=fixture();await f.create(1,"Free hosted");f.tick();await f.create(2,"BYO");
 await f.service.registerByo(f.req,idFor(2),byoBody);
 const r=await upload(f,1);
 assert.equal(r.status,423);
 assert.equal(r.body.reason,"lapsed");
 assert.deepEqual(r.body.unpaidWorkspaceIds,[idFor(2)]);
});
test("423: BYO lapses immediately at registration with no grace window (hosted monthly gets LAPSE_GRACE_MS)",async()=>{
 const f=fixture();await f.create(1,"Only");
 const r=await f.service.registerByo(f.req,idFor(1),byoBody);
 assert.equal(r.lapsed,true);
 const s=summarizeProjects([{...f.record(1),id:idFor(1)}]);
 assert.equal(s.reason,"lapsed");
});
test("423 clears once the BYO subscription is active",async()=>{
 const f=fixture();await f.create(1,"Only");await f.service.registerByo(f.req,idFor(1),byoBody);
 await f.service.reconcileWorkspaceFee(sub(1),{eventType:"invoice.paid",invoice:invoice(Math.floor(Date.now()/1000)+30*86400)});
 const inv=await f.service.inventory(f.req);
 assert.equal(inv.policy.locked,false);
 const r=await upload(f,1);
 assert.notEqual(r.status,423);
});
test("423: past_due BYO subscription re-locks immediately (no grace, unlike hosted)",async()=>{
 const f=fixture();await f.create(1,"Only");await f.service.registerByo(f.req,idFor(1),byoBody);
 await f.service.reconcileWorkspaceFee(sub(1),{eventType:"invoice.paid",invoice:invoice(Math.floor(Date.now()/1000)+30*86400)});
 await f.service.reconcileWorkspaceFee(sub(1,"past_due"),{eventType:"invoice.payment_failed"});
 const inv=await f.service.inventory(f.req);
 assert.equal(inv.policy.locked,true);
});
test("423: reads stay allowed while lapsed",async()=>{
 const f=fixture();await f.create(1,"Only");await f.service.registerByo(f.req,idFor(1),byoBody);
 const h=await http(f);
 try{const r=await h.call("GET","/v2/workspaces/"+idFor(1)+"/cloud/files");assert.notEqual(r.status,423);}finally{await h.close();}
});

// ===== 8. makeHosted (added in 4c3dd13) =====
test("makeHosted demotes the previous free workspace to $5 but it never lapses and is never sent to Checkout (unbilled)",async t=>{
 const f=fixture();
 if(typeof f.service.makeHosted!=="function"){t.skip("568f223 has no makeHosted");return;}
 await f.create(1,"Oldest");f.tick();await f.create(2,"Second");
 await f.service.registerByo(f.req,idFor(1),byoBody);
 assert.equal(f.record(2).projectFeeStatus,"free");
 await f.service.makeHosted(f.req,idFor(1));
 const inv=await f.service.inventory(f.req);
 assert.deepEqual(priceView(f,inv,2),{isFree:false,monthlyPriceCents:500});
 assert.equal(f.record(2).workspaceFeeStatus,"unpaid");
 const realNow=Date.now;
 try{Date.now=()=>realNow()+90*86400000;const later=await f.service.inventory(f.req);
  assert.equal(later.policy.locked,false);                 // no paidThroughMs -> evaluateLapse never lapses it
  assert.deepEqual(later.policy.unpaidWorkspaceIds,[]);}finally{Date.now=realNow;}
 assert.equal(f.record(2).workspaceFeeCheckoutSessionId,undefined);
});
test("makeHosted on a workspace with a paid BYO subscription cancels that subscription when it becomes free",{todo:BUG},async t=>{
 const f=fixture();
 if(typeof f.service.makeHosted!=="function"){t.skip("568f223 has no makeHosted");return;}
 await f.create(1,"Oldest");f.tick();await f.create(2,"Second");
 await f.service.registerByo(f.req,idFor(1),byoBody);
 await f.service.reconcileWorkspaceFee(sub(1),{eventType:"invoice.paid",invoice:invoice(Math.floor(Date.now()/1000)+30*86400)});
 await f.service.makeHosted(f.req,idFor(1));
 assert.equal(f.record(1).projectFeeStatus,"free");
 assert.equal(f.stripe.calls.filter(c=>c[1]==="sub_ws_1").length,1,"sub_ws_1 should be cancelled/prorated: "+JSON.stringify(f.stripe.calls));
});
test("owner-benefit workspace reports monthlyPriceCents 500 although the owner is never charged (4c3dd13)",async()=>{
 const f=fixture();
 await f.create(1,"Free");
 const o=await f.create(2,"Owner perk",f.ownerReq);
 assert.equal(o.project.data.projectFeeStatus,"owner");
 const inv=await f.service.inventory(f.req);
 const p=priceView(f,inv,2);
 if(p.monthlyPriceCents===0){/* 568f223 behaviour */return;}
 assert.equal(p.monthlyPriceCents,500);
 assert.equal(f.record(2).workspaceFeeModel,undefined);    // no monthly model, no Checkout: shown $5, never billed
});
