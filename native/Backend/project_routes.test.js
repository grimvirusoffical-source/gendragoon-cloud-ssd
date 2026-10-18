"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),express=require("express"),Stripe=require("stripe");
const {memoryFirestore}=require("./test_firestore");
const {installedBilling,STRIPE_API_VERSION}=require("./billing_gateway");
const {effectiveStorageQuota}=require("./billing_v2");
const hash=uid=>crypto.createHash("sha256").update(uid).digest("hex"),owner=hash("test-a");
const idFor=n=>"abcdef12-1234-4000-8000-"+String(n).padStart(12,"0");
const hookSecret="whsec_disposableFixtureOnly123";
async function fixture(t){
 const db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_own"}]]),sessions=new Map(),intents=new Map(),subs=new Map(),calls=[],markers=[];
 const configured={"one_time|project_creation":"price_project","storage|standard|2TB|month":"price_2tb","performance|turbo|month":"price_turbo"};
 const amounts={price_project:500,price_2tb:7200,price_turbo:900};
 const verifier=new Stripe("sk_test_dummyABC123",{apiVersion:STRIPE_API_VERSION});
 const stripe={webhooks:verifier.webhooks,prices:{retrieve:async id=>({id,active:true,type:"one_time",recurring:null,unit_amount:500,currency:"usd",livemode:false,billing_scheme:"per_unit",product:{active:true}})},
   customers:{create:async()=>({id:"cus_own"})},checkout:{sessions:{
     create:async(args,options)=>{const id="cs_local"+(calls.length+1);calls.push({args,options});
       const session={...args,id,status:"open",payment_status:"unpaid",currency:"usd",amount_total:args.line_items.reduce((n,x)=>n+amounts[x.price]*x.quantity,0),url:"https://checkout.stripe.com/c/pay/"+id};sessions.set(id,session);return structuredClone(session);},
     retrieve:async id=>structuredClone(sessions.get(id)),expire:async id=>{sessions.get(id).status="expired";return sessions.get(id);},
     listLineItems:async id=>({has_more:false,data:sessions.get(id).line_items.map(x=>({quantity:x.quantity,price:{id:x.price}}))})
   }},paymentIntents:{retrieve:async id=>structuredClone(intents.get(id))},subscriptions:{retrieve:async id=>structuredClone(subs.get(id))},
   charges:{retrieve:async id=>[...intents.values()].map(x=>x.latest_charge).find(x=>x.id===id)}};
 const app=express();app.use("/v2",express.json());
 const firebaseAuth=(req,res,next)=>{const uid=req.headers.authorization?.replace("Bearer ","");if(!["test-a","test-b"].includes(uid))return res.status(401).json({error:"Sign in"});req.user={uid};next();};
 const runtime=installedBilling({app,db,bucket:{file:name=>({save:async()=>markers.push(name)})},stripeOverride:stripe,
   admin:{firestore:{FieldValue:{serverTimestamp:()=>Date.parse("2026-10-18T00:00:00Z")}}},firebaseAuth,accountKey:hash,
   env:{STRIPE_SECRET_KEY:"sk_test_dummyABC123",STRIPE_WEBHOOK_SECRET:hookSecret,STRIPE_CHECKOUT_ENABLED:"true",
     STRIPE_PROJECT_CHECKOUT_READY:"true",STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example",STRIPE_PRICE_CATALOG_JSON:JSON.stringify(configured)}});
 const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin="http://127.0.0.1:"+server.address().port;
 async function request(path,body,token="test-a",method=body===undefined?"GET":"POST"){
   const response=await fetch(origin+path,{method,headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer "+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:response.status,body:await response.json()};
 }
 async function webhook(type,object,eventId="evt_"+crypto.randomBytes(8).toString("hex"),tamper=false){
   const payload=JSON.stringify({id:eventId,type,api_version:"2025-06-30.basil",data:{object}});
   const signature=verifier.webhooks.generateTestHeaderString({payload,secret:hookSecret});
   const response=await fetch(origin+"/billing/stripe-webhook",{method:"POST",headers:{"Content-Type":"application/json","Stripe-Signature":signature},body:tamper?payload+" ":payload});
   return {status:response.status,body:await response.json()};
 }
 const path=id=>id==="free"?"tenants/"+owner+"/workspaces/free":"gd_accounts/"+owner+"/workspaces/"+id;
 async function two(){await request("/v2/projects",{name:"First project",intentId:idFor(1)});return request("/v2/projects",{name:"Second project",intentId:idFor(2),amount:1,ownerBenefits:true});}
 function pay(id=idFor(2),intentId="pi_local1"){
   const record=db.rows.get(path(id)),session=sessions.get(record.projectCheckoutSessionId);
   session.status="complete";session.payment_status="paid";session.payment_intent=intentId;
   intents.set(intentId,{id:intentId,status:"succeeded",customer:"cus_own",metadata:session.metadata,currency:"usd",amount_received:500,
     latest_charge:{id:"ch_local1",payment_intent:intentId,refunded:false,disputed:false,amount_captured:500,amount_refunded:0}});
   return session;
 }
 return {db,runtime,request,webhook,two,pay,sessions,intents,subs,calls,path,markers,record:id=>db.rows.get(path(id))};
}
test("project APIs require a signed-in account; a scoped file API key cannot administer projects",async t=>{
 const f=await fixture(t);
 for(const token of [null,"gdsk_disposable_file_scope"]){
   assert.equal((await f.request("/v2/projects",undefined,token)).status,401);
   assert.equal((await f.request("/v2/projects",{name:"Injected",intentId:idFor(1)},token)).status,401);
 }
 const first=await f.request("/v2/projects",{name:"First project",intentId:idFor(1)});
 assert.equal(first.status,201);assert.equal(first.body.oneTimeCents,0);assert.equal(first.body.project.quotaGB,2);assert.equal(first.body.project.transferEligible,true);
 assert.equal((await f.request("/v2/projects/"+idFor(1),undefined,"test-b")).status,404);
 assert.equal((await f.request("/v2/projects/"+idFor(1)+"/archive",{confirmName:"First project"},"test-b")).status,404);
});
test("new-project API ignores forged owner/amount fields and creates only the configured500-cent Checkout",async t=>{
 const f=await fixture(t),second=await f.two();assert.equal(second.status,201);assert.equal(second.body.oneTimeCents,500);
 assert.equal(second.body.project.projectStatus,"pending_payment");assert.equal(second.body.policy.usedProjectSlots,2);
 assert.deepEqual(f.calls[0].args.line_items,[{price:"price_project",quantity:1}]);assert.equal(f.calls[0].args.mode,"payment");
 assert.equal(f.record(idFor(2)).provisioned,false);assert.equal(f.record(idFor(2)).storageActive,false);
});
test("the bundled mobile draft request cannot create projects or collect an activation fee, even when live-shaped pricing is ready",async t=>{
 const f=await fixture(t);await f.request("/v2/projects",{name:"First project",intentId:idFor(1)});
 const before=structuredClone(f.db.rows),body={name:"Requested storage",tier:"2TB",mode:"standard",interval:"month"};
 for(const payload of [body,body,{...body,intentId:idFor(1)},{...body,intentId:idFor(2)}]){
   const result=await f.request("/v2/workspaces/draft",payload);assert.equal(result.status,426);
   assert.equal(result.body.error,"CLIENT_UPDATE_REQUIRED");assert.equal(result.body.url,undefined);assert.equal(result.body.workspaceId,undefined);
 }
 assert.deepEqual(f.db.rows,before);assert.equal(f.calls.length,0);assert.equal(f.sessions.size,0);
});
test("a legacy storage or BYO request cannot switch an inactive project's checkout into a500-cent activation payment",async t=>{
 const f=await fixture(t);await f.two();
 const record=f.record(idFor(2));record.manualProviderConfigured=true;
 const before=structuredClone(f.db.rows),sessionCount=f.sessions.size;
 for(const kind of ["storage","byo"]){
   const result=await f.request("/v2/workspaces/"+idFor(2)+"/checkout/"+kind,{});
   assert.equal(result.status,409);assert.equal(result.body.error,"PROJECT_ACTIVATION_REQUIRED");assert.equal(result.body.url,undefined);
 }
 assert.deepEqual(f.db.rows,before);assert.equal(f.sessions.size,sessionCount);assert.equal(f.calls.length,1);
 const explicit=await f.request("/v2/projects/"+idFor(2)+"/checkout",{});assert.equal(explicit.status,200);assert.equal(explicit.body.resumed,true);
 assert.equal(f.calls.length,1);assert.match(explicit.body.url,/checkout\.stripe\.com/);
});
test("signed asynchronous payment success activates once; older raw webhook snapshots are re-fetched and replay-safe",async t=>{
 const f=await fixture(t);await f.two();const id=f.record(idFor(2)).projectCheckoutSessionId;
 f.sessions.get(id).status="complete";
 const unpaid={id,metadata:{kind:"project_creation",accountHash:owner,workspaceId:idFor(2)}};
 assert.equal((await f.webhook("checkout.session.completed",unpaid)).status,200);assert.equal(f.record(idFor(2)).provisioned,false);
 const paid=f.pay();const eventId="evt_replayed123";
 assert.equal((await f.webhook("checkout.session.async_payment_succeeded",unpaid,eventId)).status,200);
 assert.equal(f.record(idFor(2)).projectFeeStatus,"paid");assert.equal(effectiveStorageQuota(f.record(idFor(2))),2e9);
 const replay=await f.webhook("checkout.session.async_payment_succeeded",unpaid,eventId);assert.equal(replay.body.replayed,true);
 await f.webhook("checkout.session.async_payment_failed",paid);assert.equal(f.record(idFor(2)).projectFeeStatus,"paid");
});
test("altered webhook bodies are rejected before any project entitlement changes",async t=>{
 const f=await fixture(t);await f.two();const paid=f.pay();
 assert.equal((await f.webhook("checkout.session.completed",paid,"evt_tampered123",true)).status,400);
 assert.equal(f.record(idFor(2)).projectFeeStatus,"pending");assert.equal(f.db.rows.has("project_payments/"+paid.payment_intent),false);
});
test("a refund before the successful Checkout webhook prevents fulfillment and permits data-preserving archive",async t=>{
 const f=await fixture(t);await f.two();const paid=f.pay(),charge=f.intents.get(paid.payment_intent).latest_charge;
 charge.refunded=true;charge.amount_refunded=500;
 assert.equal((await f.webhook("charge.refunded",charge)).status,200);
 assert.equal(f.record(idFor(2)).projectFeeStatus,"revoked");assert.equal(f.record(idFor(2)).provisioned,false);
 charge.refunded=false;charge.amount_refunded=0; // Simulates a later stale paid snapshot; revocation ledger still wins.
 assert.equal((await f.webhook("checkout.session.completed",paid)).status,200);assert.equal(f.record(idFor(2)).projectFeeStatus,"revoked");
 assert.equal((await f.request("/v2/projects/"+idFor(2)+"/archive",{confirmName:"Second project"})).status,200);
});
test("legacy free project storage activation uses the chosen tier and no recurring project fee, then falls back to basic quota on cancellation",async t=>{
 const f=await fixture(t);
 assert.equal((await f.request("/v2/workspaces/free",{name:"Original free project"})).status,201);
 const result=await f.request("/v2/workspaces/free/checkout/storage",{tier:"2TB",mode:"standard",interval:"month"});
 assert.equal(result.status,200);assert.deepEqual(f.calls[0].args.line_items,[{price:"price_2tb",quantity:1}]);assert.equal(result.body.quote.totalCents,7200);
 assert.equal(f.record("free").storageActive,false);assert.equal(effectiveStorageQuota(f.record("free")),2e9);
 const sub={id:"sub_local1",customer:"cus_own",status:"active",metadata:{kind:"storage",accountHash:owner,workspaceId:"free"},items:{data:[{price:{id:"price_2tb"},quantity:1}]}};
 f.subs.set(sub.id,sub);assert.equal((await f.webhook("customer.subscription.created",{id:sub.id})).status,200);
 assert.equal(f.record("free").storageTier,"2TB");assert.equal(effectiveStorageQuota(f.record("free")),2e12);assert.equal(f.markers[0],"customer/"+owner+"/free/internal-provisioning-marker");
 sub.status="canceled";assert.equal((await f.webhook("customer.subscription.deleted",{id:sub.id})).status,200);
 assert.equal(effectiveStorageQuota(f.record("free")),2e9);assert.equal(f.record("free").provisioned,true);
});
