"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),express=require("express"),Stripe=require("stripe");
const {memoryFirestore}=require("./test_firestore");
const {installedBilling,STRIPE_API_VERSION}=require("./billing_gateway");
const {effectiveStorageQuota,effectiveWorkers}=require("./billing_v2");
const hash=uid=>crypto.createHash("sha256").update(uid).digest("hex"),owner=hash("test-a");
const idFor=n=>"abcdef12-1234-4000-8000-"+String(n).padStart(12,"0");
const hookSecret="whsec_disposableFixtureOnly123";
async function fixture(t){
 const db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_own"}]]),sessions=new Map(),intents=new Map(),subs=new Map(),calls=[],markers=[];
 const configured={"one_time|project_creation":"price_project","workspace|month":"price_wsfee","byo|month":"price_byofee","storage|standard|2TB|month":"price_2tb","performance|turbo|month":"price_turbo","performance|lite|month":"price_lite","storage|standard|100GB|year":"price_100y","performance|boost|year":"price_boosty"};
 const amounts={price_project:500,price_wsfee:500,price_byofee:500,price_2tb:7200,price_turbo:900,price_lite:300,price_100y:6400,price_boosty:9400};
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
   admin:{firestore:{FieldValue:{serverTimestamp:()=>123}}},firebaseAuth,accountKey:hash,
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
 async function two(){await request("/v2/projects",{name:"First project",intentId:idFor(1)});return request("/v2/projects",{name:"Second project",intentId:idFor(2),amount:1,ownerBenefits:true,plans:{storageTier:"2TB",performanceTier:"turbo",interval:"month"}});}
 function plansSub(status="active",items=["price_2tb","price_turbo"]){
   const sub={id:"sub_plans1",customer:"cus_own",status,metadata:{kind:"workspace_plans",accountHash:owner,workspaceId:idFor(2)},
     items:{data:items.map(id=>({price:{id},quantity:1}))}};
   subs.set(sub.id,sub);return sub;
 }
 function pay(id=idFor(2),intentId="pi_local1"){
   const record=db.rows.get(path(id)),session=sessions.get(record.projectCheckoutSessionId);
   session.status="complete";session.payment_status="paid";session.payment_intent=intentId;
   intents.set(intentId,{id:intentId,status:"succeeded",customer:"cus_own",metadata:session.metadata,currency:"usd",amount_received:500,
     latest_charge:{id:"ch_local1",payment_intent:intentId,refunded:false,disputed:false,amount_captured:500,amount_refunded:0}});
   return session;
 }
 return {db,runtime,request,webhook,two,pay,plansSub,amounts,sessions,intents,subs,calls,path,markers,record:id=>db.rows.get(path(id))};
}

const RETIRED_RECURRING_FEE_PRICES=new Set(["price_wsfee","price_byofee"]);
const noRetiredFee=f=>{for(const c of f.calls)for(const item of c.args.line_items)assert.ok(!RETIRED_RECURRING_FEE_PRICES.has(item.price),"retired recurring workspace/BYO fee charged: "+item.price);};
test("rule 1: the first workspace is free with 2 GB storage and the free performance plan, and needs no checkout",async t=>{
 const f=await fixture(t),first=await f.request("/v2/projects",{name:"First",intentId:idFor(1),plans:{storageTier:"2TB",performanceTier:"turbo"}});
 assert.equal(first.status,201);assert.equal(first.body.isFree,true);assert.equal(first.body.oneTimeCents,0);assert.equal(first.body.url,undefined);
 assert.equal(first.body.project.quotaGB,2);assert.equal(effectiveStorageQuota(f.record(idFor(1))),2e9);assert.equal(effectiveWorkers(f.record(idFor(1))),1);
 assert.equal(f.calls.length,0);
 const pricing=await f.request("/v2/pricing");
 assert.equal(pricing.body.workspaceFeeIncluded,true);assert.deepEqual(pricing.body.projects.firstFreeIncludes,{storageGB:2,performanceTier:"free",workers:1});
});
test("rule 2: every additional workspace requires BOTH a storage plan and a performance plan, enforced server-side",async t=>{
 const f=await fixture(t);await f.request("/v2/projects",{name:"First",intentId:idFor(1)});
 for(const plans of [undefined,{},{storageTier:"2TB"},{performanceTier:"turbo"},{storageTier:"nope",performanceTier:"turbo"},{storageTier:"2TB",performanceTier:"free"}]){
   const r=await f.request("/v2/projects",{name:"Second",intentId:idFor(2),plans});
   assert.equal(r.status,400,JSON.stringify(plans));assert.ok(["PLANS_REQUIRED","INVALID_SELECTION"].includes(r.body.error),r.body.error);
 }
 assert.equal(f.calls.length,0);assert.equal(f.db.rows.has(f.path(idFor(2))),false);
 const ok=await f.request("/v2/projects",{name:"Second",intentId:idFor(2),plans:{storageTier:"100GB",performanceTier:"boost",interval:"year"}});
 assert.equal(ok.status,201);assert.deepEqual(f.calls[0].args.line_items,[{price:"price_100y",quantity:1},{price:"price_boosty",quantity:1},{price:"price_project",quantity:1}]);
 assert.equal(f.calls[0].args.metadata.kind,"workspace_plans");assert.equal(f.calls[0].args.mode,"subscription");assert.ok(ok.body.totalCents>0);
 assert.equal(effectiveStorageQuota(f.record(idFor(2))),0);assert.equal(effectiveWorkers(f.record(idFor(2))),0);
});
test("rule 3: custom storage skips the storage plan but still requires a paid performance plan before setup",async t=>{
 const f=await fixture(t);
 for(const plans of [undefined,{},{performanceTier:"free"},{storageTier:"2TB"},{performanceTier:"warp"}]){
   const r=await f.request("/v2/projects",{name:"Own S3",intentId:idFor(3),storage:"custom",plans});
   assert.equal(r.status,400,JSON.stringify(plans));assert.ok(["PERFORMANCE_PLAN_REQUIRED","INVALID_SELECTION"].includes(r.body.error),r.body.error);
 }
 const withStorage=await f.request("/v2/projects",{name:"Own S3",intentId:idFor(3),storage:"custom",plans:{storageTier:"2TB",performanceTier:"lite",interval:"month"}});
 assert.equal(withStorage.status,400);assert.equal(withStorage.body.error,"INVALID_SELECTION","a storage plan cannot be bought for custom storage");
 const created=await f.request("/v2/projects",{name:"Own S3",intentId:idFor(3),storage:"custom",plans:{performanceTier:"lite",interval:"month"}});
 assert.equal(created.status,201);assert.equal(created.body.isFree,false,"custom storage never takes the free slot");
 assert.deepEqual(f.calls[0].args.line_items,[{price:"price_lite",quantity:1},{price:"price_project",quantity:1}]);
 const register=()=>f.request("/v2/workspaces/"+idFor(3)+"/byo/register",{provider:"s3",endpoint:"https://bucket.s3.us-east-1.amazonaws.com",bucketFingerprint:"ab".repeat(8)});
 const blocked=await register();assert.equal(blocked.status,402);assert.equal(blocked.body.error,"PERFORMANCE_PLAN_REQUIRED");
 const manual=()=>f.request("/v2/workspaces/"+idFor(3)+"/manual-provider",{provider:"s3",label:"my-remote",connectionTested:true});
 const manualBlocked=await manual();assert.equal(manualBlocked.status,402);assert.equal(manualBlocked.body.error,"PERFORMANCE_PLAN_REQUIRED");
 const sub={id:"sub_custom",customer:"cus_own",status:"active",metadata:{kind:"workspace_plans",accountHash:owner,workspaceId:idFor(3)},items:{data:[{price:{id:"price_lite"},quantity:1}]}};
 f.subs.set(sub.id,sub);
 const paidSession=f.sessions.get(f.record(idFor(3)).plansCheckoutSessionId);paidSession.status="complete";paidSession.payment_status="paid";paidSession.subscription=sub.id;
 assert.equal((await f.webhook("checkout.session.completed",structuredClone(paidSession))).status,200);
 assert.equal((await f.webhook("customer.subscription.created",{id:sub.id})).status,200);
 assert.equal(f.record(idFor(3)).projectStatus,"active");
 assert.equal((await manual()).status,200,"desktop wizard finish step (local rclone remote, credentials stay on device)");
 const ok=await register();assert.equal(ok.status,200,JSON.stringify(ok.body));assert.equal(ok.body.byoRegistered,true);assert.equal(ok.body.monthlyPriceCents,0);assert.equal(ok.body.lapsed,false);
 assert.ok(!f.record(idFor(3)).workspaceFeeModel);assert.ok(!f.record(idFor(3)).workspaceFeeCents);
 const free=await f.request("/v2/projects",{name:"Hosted",intentId:idFor(4)});assert.equal(free.body.isFree,true,"free slot still available after a custom workspace");
 noRetiredFee(f);
});
test("rule 4: no recurring workspace fee is charged; exactly one project activation is included until paid",async t=>{
 const f=await fixture(t);await f.request("/v2/projects",{name:"First",intentId:idFor(1)});
 await f.two();
 await f.request("/v2/projects/"+idFor(2)+"/checkout",{plans:{storageTier:"2TB",performanceTier:"lite",interval:"month"}});
 for(const kind of ["storage","performance","byo"])await f.request("/v2/workspaces/"+idFor(2)+"/checkout/"+kind,{tier:"2TB",mode:"standard",interval:"month"});
 await f.request("/v2/workspaces/"+idFor(1)+"/checkout/storage",{tier:"2TB",mode:"standard",interval:"month"});
 assert.ok(f.calls.length>=2);noRetiredFee(f);
 for(const c of f.calls){
   assert.equal(c.args.line_items.some(x=>RETIRED_RECURRING_FEE_PRICES.has(x.price)),false);
   assert.ok(c.args.line_items.filter(x=>x.price==="price_project").length<=1);
 }
 const pricing=await f.request("/v2/pricing");
 assert.equal(pricing.body.projects.additionalOneTimeCents,500);assert.equal(pricing.body.projects.workspaceMonthlyCents,0);
 assert.equal(pricing.body.customStorage.extraFeeCents,0);assert.equal(pricing.body.customStorage.performancePlanRequired,true);
 const quote=await f.request("/v2/projects",undefined);assert.equal(quote.body.policy.newProjectOneTimeCents,500);assert.equal(quote.body.policy.workspaceMonthlyCents,0);
});
test("changing plans before payment replaces the open checkout instead of stacking a second charge",async t=>{
 const f=await fixture(t);await f.two();const firstSession=f.record(idFor(2)).plansCheckoutSessionId;
 const changed=await f.request("/v2/projects/"+idFor(2)+"/checkout",{plans:{storageTier:"2TB",performanceTier:"lite",interval:"month"}});
 assert.equal(changed.status,200);assert.equal(f.sessions.get(firstSession).status,"expired");
 assert.deepEqual(f.record(idFor(2)).requiredPlans,{storage:"managed",storageTier:"2TB",performanceTier:"lite",interval:"month"});
 const resumed=await f.request("/v2/projects/"+idFor(2)+"/checkout",{});assert.equal(resumed.body.resumed,true);
 assert.equal([...f.sessions.values()].filter(s=>s.status==="open").length,1);
});
test("a managed plans workspace cannot be switched to custom storage after creation",async t=>{
 const f=await fixture(t);await f.two();
 const r=await f.request("/v2/workspaces/"+idFor(2)+"/manual-provider",{provider:"s3",label:"my-remote",connectionTested:true});
 assert.equal(r.status,409);assert.equal(r.body.error,"CUSTOM_STORAGE_NEW_WORKSPACE");
 const b=await f.request("/v2/workspaces/"+idFor(2)+"/byo/register",{provider:"s3",endpoint:"https://bucket.s3.us-east-1.amazonaws.com",bucketFingerprint:"ab".repeat(8)});
 assert.equal(b.status,409);assert.equal(b.body.error,"CUSTOM_STORAGE_NEW_WORKSPACE");
});
