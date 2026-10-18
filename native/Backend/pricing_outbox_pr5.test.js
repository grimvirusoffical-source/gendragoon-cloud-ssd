"use strict";
// QA risk tests for PR #5 @ 0715b1a: subscription-cancel outbox, workspace purge, grace, invariants.
// Local only: in-memory Firestore, recording Stripe double, in-memory object store. No network, no credentials.
// Former BUG(pr5-0715b1a) todos: fixed on fix/backend-workspace-policy, all required now.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const fs=require("node:fs"),path=require("node:path");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {createProjectService}=require("./projects");
const {cancelParams}=require("./billing_jobs");
const {LAPSE_GRACE_MS}=require("./workspace_policy");
const {registerBillingV2}=require("./billing_v2");

const owner=crypto.createHash("sha256").update("outbox-risk-owner").digest("hex");
const idFor=n=>"33333333-3333-4333-8333-"+String(n).padStart(12,"0");
const AFTER=Date.parse("2026-10-18T00:00:00Z");
const byoBody={provider:"s3",endpoint:"https://bucket.s3.us-east-1.amazonaws.com",bucketFingerprint:"aa".repeat(8)};
const env={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_WORKSPACE_MONTHLY_READY:"true",STRIPE_WORKSPACE_MONTHLY_PRICE_ID:"price_month",
 STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example"};
const price={id:"price_month",active:true,type:"recurring",recurring:{interval:"month"},currency:"usd",unit_amount:500,
 billing_scheme:"per_unit",livemode:false,product:{active:true}};
const stripeErr=f=>Object.assign(new Error(f.message||f.code||"stripe"),f);

// Stripe double that behaves like Stripe idempotency: same key -> replayed result, no second effect.
function stripeDouble({cancelImpl}={}){
 const calls=[],effects=[],replay=new Map();let sessions=0;
 const s={calls,effects,
  prices:{retrieve:async()=>({...price})},customers:{create:async()=>({id:"cus_own"})},
  checkout:{sessions:{create:async()=>{sessions++;return {id:"cs_"+sessions,url:"https://checkout.stripe.com/c/pay/cs_"+sessions,status:"open"};},
   retrieve:async id=>({id,status:"open",url:"https://checkout.stripe.com/c/pay/"+id,metadata:{}}),
   expire:async id=>{calls.push(["checkout.expire",id]);return {id,status:"expired"};}}},
  subscriptions:{cancel:async(id,params,opts)=>{
   calls.push(["subscriptions.cancel",id,params,opts]);
   const key=opts?.idempotencyKey;
   if(key&&replay.has(key))return replay.get(key);
   const out=cancelImpl?await cancelImpl(id,params,opts):{id,status:"canceled"};
   effects.push(["cancel+credit",id]);
   if(key)replay.set(key,out);
   return out;}}};
 return s;
}
function memStore({failOnDeleteNumber=null,missingThrows=true}={}){
 const objects=new Set();let deletes=0;
 return {objects,put:k=>objects.add(k),get deletes(){return deletes;},
  async delete(k){deletes++;if(failOnDeleteNumber&&deletes===failOnDeleteNumber)throw Object.assign(new Error("gcs 503"),{code:503});
   if(!objects.has(k)){if(missingThrows)throw Object.assign(new Error("No such object"),{code:404});return;}objects.delete(k);}};
}
function fixture({stripe=stripeDouble(),objectStore=null}={}){
 const db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_own"}]]);
 let clock=AFTER;
 const make=(s=stripe,o=objectStore)=>createProjectService({db,stamp:()=>clock,hash:()=>owner,stripe:s,env,ensureCustomer:async()=>"cus_own",objectStore:o});
 const service=make();
 const req={user:{uid:"owner"}};
 const p=id=>"gd_accounts/"+owner+"/workspaces/"+id;
 return {db,stripe,service,make,req,p,tick:(ms=1000)=>{clock+=ms;},
  create:(n,name,svc=service)=>svc.create(req,{name:name||"Project "+n,intentId:idFor(n)}),
  record:n=>db.rows.get(p(idFor(n))),set:(n,patch)=>db.rows.set(p(idFor(n)),{...db.rows.get(p(idFor(n))),...patch}),
  account:()=>db.rows.get("gd_accounts/"+owner)};
}
const sub=(n,status="active",id)=>({id:id||"sub_ws_"+n,status,customer:"cus_own",metadata:{kind:"workspace_fee",accountHash:owner,workspaceId:idFor(n)}});
const inv=end=>({lines:{data:[{period:{end}}]}});
const in30=()=>Math.floor(Date.now()/1000)+30*86400;
async function paidSecond(f,svc=f.service){
 await f.create(1,"Free",svc);f.tick();await f.create(2,"Paid",svc);
 await svc.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:inv(in30())});
}

// ---------- Stripe parameters ----------
test("cancel params are valid for Stripe subscriptions.cancel (only cancellation_details, expand, invoice_now, prorate)",()=>{
 const allowed=new Set(["cancellation_details","expand","invoice_now","prorate"]);
 assert.deepEqual(Object.keys(cancelParams()).filter(k=>!allowed.has(k)),[]);
});
test("a 400 invalid_request_error on cancel alerts immediately instead of burning 5 retries",async()=>{
 const {sweepSubscriptionCancels}=require("./billing_jobs");
 const alerts=[];
 const stripe={subscriptions:{cancel:async()=>{throw stripeErr({type:"StripeInvalidRequestError",rawType:"invalid_request_error",code:"parameter_unknown",statusCode:400});}}};
 const next=await sweepSubscriptionCancels({stripe,pending:[{subscriptionId:"sub_x",workspaceId:"w",attempts:0,status:"pending",nextAttemptAt:0}],now:1,alert:(c,d)=>alerts.push(c)});
 assert.equal(next[0].status,"failed");assert.equal(alerts.length,1);
});

// ---------- Outbox durability ----------
test("outbox: a crash between commit and the Stripe call leaves the cancel durably queued in Firestore",async()=>{
 const f=fixture({stripe:{prices:{retrieve:async()=>({...price})},checkout:{sessions:{create:async()=>({id:"cs",url:"https://checkout.stripe.com/c/pay/cs",status:"open"}),retrieve:async()=>({status:"open"}),expire:async()=>({})}}}});
 // No subscriptions.cancel = the process died before reaching Stripe.
 await paidSecond(f);
 await f.service.remove(f.req,idFor(1));
 const q=f.account().pendingSubscriptionCancels;
 assert.equal(q.length,1);assert.equal(q[0].subscriptionId,"sub_ws_2");assert.equal(q[0].status,"pending");
 assert.equal(f.record(2).projectFeeStatus,"free");
});
test("outbox: after a restart something sweeps the queue without waiting for another user mutation",async()=>{
 const f=fixture({stripe:{prices:{retrieve:async()=>({...price})}}});
 await paidSecond(f);await f.service.remove(f.req,idFor(1));
 const restarted=f.make(stripeDouble());
 assert.equal(typeof (restarted.sweepPending||restarted.sweepAccount||restarted.sweepBillingJobs),"function","no sweep entry point for a scheduler");
});
test("outbox: the next mutation on the account does drain a queue left by a crash",async()=>{
 const f=fixture({stripe:{prices:{retrieve:async()=>({...price})}}});
 await paidSecond(f);await f.service.remove(f.req,idFor(1));
 const stripe=stripeDouble(),svc=f.make(stripe);
 await f.create(3,"Later",svc);                      // create does NOT sweep
 assert.equal(f.account().pendingSubscriptionCancels.length,1);
 await svc.registerByo(f.req,idFor(3),byoBody);      // registerByo does
 assert.deepEqual(stripe.effects,[["cancel+credit","sub_ws_2"]]);
 assert.deepEqual(f.account().pendingSubscriptionCancels,[]);
 assert.equal(f.record(2).workspaceFeeSubscriptionId,null);
});
test("outbox: duplicate runs reuse one idempotency key, so Stripe cancels and credits once",async()=>{
 const stripe=stripeDouble();
 const f=fixture({stripe});
 await paidSecond(f);
 // Freeze the queue as a crashed run would leave it, then run two sweeps concurrently.
 const cancelGate=[];
 const f2=fixture({stripe});
 await paidSecond(f2);
 await f2.make({prices:{retrieve:async()=>({...price})}}).remove(f2.req,idFor(1)); // queued, not swept
 const a=f2.make(stripe),b=f2.make(stripe);
 await Promise.all([a.registerByo(f2.req,idFor(2),byoBody).catch(()=>{}),b.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:inv(in30())})]);
 const cancels=stripe.calls.filter(c=>c[0]==="subscriptions.cancel"&&c[1]==="sub_ws_2");
 assert.ok(cancels.length>=1);
 assert.equal(new Set(cancels.map(c=>c[3]?.idempotencyKey)).size,1);
 assert.equal(stripe.effects.filter(e=>e[1]==="sub_ws_2").length,1);
 void cancelGate;void f;
});
test("outbox: a sweep never drops a cancel that another request queued or retried meanwhile (lost update)",async()=>{
 let release;const gate=new Promise(r=>{release=r;});let first=true;
 const stripe=stripeDouble({cancelImpl:async id=>{
  if(id==="sub_ws_2"&&first){first=false;await gate;}                       // sweep #1 is slow on sub_ws_2
  if(id==="sub_ws_3")throw stripeErr({statusCode:503,type:"StripeAPIError"}); // sweep #2 gets a transient error on sub_ws_3
  return {id,status:"canceled"};}});
 const f=fixture({stripe});
 await f.create(1,"Free");f.tick();await f.create(2,"Paid A");f.tick();await f.create(3,"Paid B");
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:inv(in30())});
 await f.service.reconcileWorkspaceFee(sub(3),{eventType:"invoice.paid",invoice:inv(in30())});
 const del2=f.service.remove(f.req,idFor(2));         // queues sub_ws_2, sweep #1 blocks on Stripe
 await new Promise(r=>setTimeout(r,20));
 await f.service.remove(f.req,idFor(3)).catch(()=>{}); // queues sub_ws_3, sweep #2: sub_ws_2 replay-ok, sub_ws_3 -> retry later
 assert.ok(f.account().pendingSubscriptionCancels.some(i=>i.subscriptionId==="sub_ws_3"),"sub_ws_3 queued for retry");
 release();await del2;
 assert.ok(f.account().pendingSubscriptionCancels.some(i=>i.subscriptionId==="sub_ws_3"),
  "sub_ws_3 vanished from the outbox without being cancelled or alerted: "+JSON.stringify(f.account().pendingSubscriptionCancels));
});

// ---------- Webhook races ----------
test("race: invoice.paid for the promoted workspace that lands before the cancel sweep cannot flip it back to monthly",async()=>{
 const f=fixture({stripe:{prices:{retrieve:async()=>({...price})}}}); // sweep cannot reach Stripe
 await paidSecond(f);await f.service.remove(f.req,idFor(1));
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:inv(in30()+30*86400)});
 assert.equal(f.record(2).projectFeeStatus,"free");assert.notEqual(f.record(2).workspaceFeeModel,"monthly");
});
test("race: a stale customer.subscription.deleted for the OLD subscription cannot cancel the NEW one after promote->demote",async()=>{
 const stripe=stripeDouble();const f=fixture({stripe});
 await paidSecond(f);                                        // 1 free, 2 paid sub_ws_2
 await f.service.registerByo(f.req,idFor(1),byoBody);        // promote 2 -> free, cancel sub_ws_2 queued+swept
 assert.equal(f.record(2).projectFeeStatus,"free");
 const back=await f.service.makeHosted(f.req,idFor(1));      // demote 2 immediately
 assert.equal(back.demoted.workspaceId,idFor(2));
 await f.service.reconcileWorkspaceFee(sub(2,"active","sub_ws_2_new"),{eventType:"invoice.paid",invoice:inv(in30())}); // user pays again
 assert.equal(f.record(2).workspaceFeeStatus,"active");
 await f.service.reconcileWorkspaceFee(sub(2,"canceled","sub_ws_2"),{eventType:"customer.subscription.deleted"});        // late event for the old sub
 assert.equal(f.record(2).workspaceFeeSubscriptionId,"sub_ws_2_new");
 assert.equal(f.record(2).workspaceFeeStatus,"active");
});
test("promote then immediately demote: old subscription cancelled once, demoted gets a new Checkout and a 3-day grace",async()=>{
 const stripe=stripeDouble();const f=fixture({stripe});
 await paidSecond(f);
 await f.service.registerByo(f.req,idFor(1),byoBody);
 const before=Date.now();
 const back=await f.service.makeHosted(f.req,idFor(1));
 assert.equal(stripe.effects.filter(e=>e[1]==="sub_ws_2").length,1);
 assert.equal(typeof back.demoted.checkoutUrl,"string");
 assert.equal(f.record(1).projectFeeStatus,"free");
 assert.equal(f.record(2).workspaceFeeModel,"monthly");
 // Effective grace from now until lock:
 const lockAt=back.demoted.graceEndsAt;
 assert.ok(lockAt-before<=LAPSE_GRACE_MS+5000,"demoted workspace locks after "+Math.round((lockAt-before)/86400000)+" days, rule says 3");
});

// ---------- Delete / purge ----------
test("delete during grace: a demoted workspace with an unpaid Checkout can still be deleted",async()=>{
 const f=fixture();
 await f.create(1,"Oldest");f.tick();await f.create(2,"Second");
 await f.service.registerByo(f.req,idFor(1),byoBody);
 const back=await f.service.makeHosted(f.req,idFor(1));
 assert.equal(back.demoted.workspaceId,idFor(2));
 let reason=null;const r=await f.service.remove(f.req,idFor(2)).catch(e=>{reason=e.reason;return null;});
 assert.equal(reason,null,"409 workspace_busy reason="+reason);
 assert.equal(r.deleted,true);
});
test("delete: an abandoned (expired) Checkout on an unpaid second workspace does not block delete forever",async()=>{
 const stripe=stripeDouble();
 stripe.checkout.sessions.retrieve=async id=>({id,status:"expired",metadata:{}});
 const f=fixture({stripe});
 const h=await http(f);
 try{
  await h.call("POST","/v2/projects",{name:"Free",intentId:idFor(1)});
  const second=await h.call("POST","/v2/projects",{name:"Unpaid",intentId:idFor(2)});
  assert.equal(typeof second.body.url,"string");
  const realNow=Date.now;
  try{Date.now=()=>realNow()+30*86400000;
   const del=await h.call("DELETE","/v2/projects/"+idFor(2));
   assert.equal(del.status,200,JSON.stringify(del.body));
  }finally{Date.now=realNow;}
 }finally{await h.close();}
});
test("delete during BYO grace (no Checkout started) succeeds and cancels nothing that does not exist",async()=>{
 const stripe=stripeDouble();const f=fixture({stripe});
 await f.create(1,"Free");f.tick();await f.create(2,"BYO");
 await f.service.registerByo(f.req,idFor(2),byoBody);
 const r=await f.service.remove(f.req,idFor(2));
 assert.equal(r.deleted,true);
 assert.equal(stripe.effects.length,0);
});
test("production wiring passes an object store to the project service, so delete purges objects",()=>{
 const src=fs.readFileSync(path.join(__dirname,"billing_v2.js"),"utf8");
 const call=src.match(/createProjectService\(\{([^}]*)\}\)/)[1];
 assert.match(call,/objectStore/);
});
test("purge half-done then retry: resumes and finishes",async()=>{
 const store=memStore({failOnDeleteNumber:2});
 const f=fixture({objectStore:store});
 await f.create(1,"Free");f.tick();await f.create(2,"Files");
 for(const n of [1,2,3]){const k="customer/"+owner+"/managed/"+idFor(2)+"/files/f"+n;store.put(k);
  f.db.rows.set(f.p(idFor(2))+"/files/f"+n,{name:"f"+n,sizeBytes:1,objectKey:k});}
 await assert.rejects(()=>f.service.remove(f.req,idFor(2)),e=>e.code==="WORKSPACE_PURGE_PENDING");
 assert.equal(f.record(2).projectStatus,"deleting");
 let err=null;const r=await f.service.remove(f.req,idFor(2)).catch(e=>{err=e;return null;});
 const marker=f.db.rows.get("gd_accounts/"+owner+"/workspace_purges/"+idFor(2));
 assert.equal(err,null,"retry failed, purge marker lastError="+marker?.lastError);
 assert.equal(r.deleted,true);
 assert.equal(store.objects.size,0);
});
test("purge half-done: the deleting workspace is out of the free-slot choice and its cancels already ran",async()=>{
 const store=memStore({failOnDeleteNumber:1});
 const stripe=stripeDouble();
 const f=fixture({stripe,objectStore:store});
 await paidSecond(f);f.tick();await f.create(3,"Third");
 const k="customer/"+owner+"/managed/"+idFor(1)+"/files/f1";store.put(k);
 f.db.rows.set(f.p(idFor(1))+"/files/f1",{name:"f1",sizeBytes:1,objectKey:k});
 await assert.rejects(()=>f.service.remove(f.req,idFor(1)),e=>e.status===503);
 assert.equal(f.record(1).projectStatus,"deleting");
 assert.equal(f.account().freeWorkspaceId,idFor(2));
 assert.deepEqual(stripe.effects,[["cancel+credit","sub_ws_2"]]);
 // Registering BYO on the new free workspace must not hand the slot back to the deleting one.
 await f.service.registerByo(f.req,idFor(2),byoBody);
 assert.equal(f.account().freeWorkspaceId,idFor(3));
});
test("purge failing on every attempt alerts workspace_purge_failed by attempt 5 and keeps the record in deleting",async()=>{
 const store={async delete(){throw Object.assign(new Error("gcs 503"),{code:503});}};
 const f=fixture({objectStore:store});
 await f.create(1,"Free");f.tick();await f.create(2,"Stuck");
 f.db.rows.set(f.p(idFor(2))+"/files/f1",{name:"f1",sizeBytes:1,objectKey:"k1"});
 const errs=[];const orig=console.error;console.error=m=>errs.push(String(m));
 try{for(let i=0;i<5;i++)await assert.rejects(()=>f.service.remove(f.req,idFor(2)),e=>e.status===503);}finally{console.error=orig;}
 assert.ok(errs.some(e=>e.includes("workspace_purge_failed")),"alert after 5 attempts");
 assert.equal(f.record(2).projectStatus,"deleting");
 assert.equal(f.db.rows.get("gd_accounts/"+owner+"/workspace_purges/"+idFor(2)).attempts,5);
});
test("a deleting workspace rejects uploads",async()=>{
 const store=memStore({failOnDeleteNumber:1});
 const f=fixture({objectStore:store});
 await f.create(1,"Free");f.tick();await f.create(2,"Going");
 f.set(2,{projectStatus:"active",provisioned:true,projectFeeStatus:"paid",workspaceFeeModel:null});
 store.put("k");f.db.rows.set(f.p(idFor(2))+"/files/f1",{name:"f1",sizeBytes:1,objectKey:"k"});
 await assert.rejects(()=>f.service.remove(f.req,idFor(2)));
 const h=await http(f);
 try{const r=await h.call("POST","/v2/workspaces/"+idFor(2)+"/cloud/uploads",{name:"x.txt",sizeBytes:4});
  assert.notEqual(r.status,201);assert.notEqual(r.status,200);}finally{await h.close();}
});
test("webhook for a deleted workspace queues a cancel with the same idempotency key (no second credit within 24h)",async()=>{
 const stripe=stripeDouble();const f=fixture({stripe});
 await paidSecond(f);
 await f.service.remove(f.req,idFor(2));
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:inv(in30())});
 const keys=stripe.calls.filter(c=>c[1]==="sub_ws_2").map(c=>c[3]?.idempotencyKey);
 assert.ok(keys.length>=2);assert.equal(new Set(keys).size,1);
 assert.equal(stripe.effects.filter(e=>e[1]==="sub_ws_2").length,1);
});

// ---------- Invariant on every priced response ----------
async function http(f){
 const app=express();app.use(express.json({limit:"16kb"}));
 const auth=(req,res,next)=>{const t=(req.headers.authorization||"").replace(/^Bearer /,"");
  if(t==="owner"){req.user={uid:"owner"};return next();}
  if(t==="ownerbenefits"){req.user={uid:"owner"};req.ownerBenefits=true;return next();}
  res.status(401).end();};
 registerBillingV2({app,db:f.db,stripe:f.stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>Date.now()}}},auth,agreed:(_q,_s,n)=>n(),hash:()=>owner,prices:{},env,byoFetch:null});
 require("./paid_storage").registerPaidStorage({app,db:f.db,bucket:{file:()=>({})},accountKey:()=>owner,
  FieldValue:{increment:n=>({increment:n}),serverTimestamp:()=>Date.now()},apiKeys:{verify:async()=>null},getAuth:()=>({}),firebaseAuth:auth});
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
 const base="http://127.0.0.1:"+server.address().port;
 return {call:async(m,u,b,t="owner")=>{const r=await fetch(base+u,{method:m,headers:{authorization:"Bearer "+t,...(b?{"content-type":"application/json"}:{})},body:b?JSON.stringify(b):undefined});
  const x=await r.text();let j=null;try{j=JSON.parse(x);}catch(_){j=x;}return {status:r.status,body:j};},close:()=>new Promise(r=>server.close(r))};
}
function priced(body,out=[]){
 if(Array.isArray(body)){body.forEach(x=>priced(x,out));return out;}
 if(body&&typeof body==="object"){if("monthlyPriceCents" in body)out.push(body);for(const k of Object.keys(body))priced(body[k],out);}
 return out;
}
test("invariant on every priced response: feeWaived boolean present, and cents==0 iff isFree||grandfathered||feeWaived",async()=>{
 const f=fixture();
 f.db.rows.set(f.p(idFor(9)),{accountHash:owner,name:"Old one-time",kind:"paid",projectBillingVersion:2,projectStatus:"active",projectFeeStatus:"paid",
  feeIsOneTime:true,provisioned:true,storageActive:false,performanceActive:false,usedBytes:0,reservedBytes:0,createdAt:Date.parse("2026-09-01T00:00:00Z")});
 const h=await http(f);const seen=[];
 const keep=(l,r)=>{for(const i of priced(r.body))seen.push([l,r.status,i]);return r;};
 try{
  keep("create1",await h.call("POST","/v2/projects",{name:"First",intentId:idFor(1)}));
  keep("create2",await h.call("POST","/v2/projects",{name:"Second",intentId:idFor(2)}));
  keep("create3-owner",await h.call("POST","/v2/projects",{name:"Owner",intentId:idFor(3)},"ownerbenefits"));
  keep("byo9-grandfathered",await h.call("POST","/v2/workspaces/"+idFor(9)+"/byo/register",byoBody));
  keep("byo1-free",await h.call("POST","/v2/workspaces/"+idFor(1)+"/byo/register",byoBody));
  keep("make-hosted1",await h.call("POST","/v2/projects/"+idFor(1)+"/make-hosted"));
  for(const u of ["/v2/workspaces","/v2/projects","/v2/projects?includeArchived=true"])keep("list "+u,await h.call("GET",u));
  for(const n of [1,2,3,9]){keep("getp"+n,await h.call("GET","/v2/projects/"+idFor(n)));keep("getw"+n,await h.call("GET","/v2/workspaces/"+idFor(n)));}
 }finally{await h.close();}
 assert.ok(seen.length>20,String(seen.length));
 const bad=seen.filter(([,,i])=>typeof i.feeWaived!=="boolean"||typeof i.isFree!=="boolean"||
  (i.monthlyPriceCents===0)!==(i.isFree===true||i.grandfathered===true||i.feeWaived===true)||![0,500].includes(i.monthlyPriceCents));
 assert.deepEqual(bad.map(([l,s,i])=>l+":"+s+":"+JSON.stringify({id:i.id||i.workspaceId,isFree:i.isFree,c:i.monthlyPriceCents,gf:i.grandfathered,fw:i.feeWaived})),[]);
});

// ---------- No price literals in server code ----------
test("no $5 / 500-cent literals in server modules (price comes from catalog.WORKSPACE_FEE_CENTS)",()=>{
 const hits=[];
 for(const file of fs.readdirSync(__dirname).filter(x=>x.endsWith(".js")&&!x.includes("test")&&x!=="catalog.js")){
  fs.readFileSync(path.join(__dirname,file),"utf8").split("\n").forEach((line,i)=>{
   const code=line.replace(/\[[0-9,\s]*\]\.includes/g,"").replace(/status(Code)?\s*[<>=!]+\s*500/g,"");
   if(/\$5\b|(?<![\w.])500(?![\w.])/.test(code)&&!/"500GB"|gb:500/.test(code))hits.push(file+":"+(i+1));});
 }
 assert.deepEqual(hits,[]);
});
