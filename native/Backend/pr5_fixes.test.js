"use strict";
// Regression tests for the PR #5 blockers N1-N8 (fix/backend-workspace-policy).
// Local only: in-memory Firestore, Stripe doubles and an in-memory bucket. No network, no credentials.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const fs=require("node:fs"),path=require("node:path");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {createProjectService}=require("./projects");
const jobs=require("./billing_jobs");
const {registerBillingV2,sweepTokenMatches}=require("./billing_v2");
const {gcsObjectStore}=require("./object_store");
const {LAPSE_GRACE_MS,summarizeProjects,byoLapsed,evaluateLapse}=require("./workspace_policy");
const {busyReason,abandonedCheckout}=require("./workspace_purge");

const owner=crypto.createHash("sha256").update("pr5-fixes-owner").digest("hex");
const idFor=n=>"44444444-4444-4444-8444-"+String(n).padStart(12,"0");
const env={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_WORKSPACE_MONTHLY_READY:"true",STRIPE_WORKSPACE_MONTHLY_PRICE_ID:"price_month",
 STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example"};
const price={id:"price_month",active:true,type:"recurring",recurring:{interval:"month"},currency:"usd",unit_amount:500,
 billing_scheme:"per_unit",livemode:false,product:{active:true}};
const byoBody={provider:"s3",endpoint:"https://bucket.s3.us-east-1.amazonaws.com",bucketFingerprint:"ef".repeat(8)};
const stripeErr=f=>Object.assign(new Error(f.message||f.code||"stripe"),f);
const sub=(n,status="active",id)=>({id:id||"sub_ws_"+n,status,customer:"cus_own",metadata:{kind:"workspace_fee",accountHash:owner,workspaceId:idFor(n)}});
const inv=end=>({lines:{data:[{period:{end}}]}});
const in30=()=>Math.floor(Date.now()/1000)+30*86400;

function stripeDouble({cancel,sessionStatus="open"}={}){
 const calls=[];let sessions=0;
 return {calls,prices:{retrieve:async()=>({...price})},customers:{create:async()=>({id:"cus_own"})},
  checkout:{sessions:{create:async()=>{sessions++;return {id:"cs_"+sessions,url:"https://checkout.stripe.com/c/pay/cs_"+sessions,status:"open"};},
   retrieve:async id=>{calls.push(["checkout.retrieve",id]);return {id,status:typeof sessionStatus==="function"?sessionStatus(id):sessionStatus,metadata:{}};},
   expire:async id=>{calls.push(["checkout.expire",id]);return {id,status:"expired"};}}},
  subscriptions:{cancel:async(id,params,opts)=>{calls.push(["subscriptions.cancel",id,params,opts]);if(cancel)return cancel(id,params,opts);return {id,status:"canceled"};}}};
}
function fixture({stripe=stripeDouble(),objectStore=null,objectStoreRequired=false}={}){
 const db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_own"}]]);
 let clock=Date.parse("2026-10-18T00:00:00Z");
 const make=(s=stripe)=>createProjectService({db,stamp:()=>clock,hash:()=>owner,stripe:s,env,ensureCustomer:async()=>"cus_own",objectStore,objectStoreRequired});
 const service=make(),req={user:{uid:"owner"}},p=id=>"gd_accounts/"+owner+"/workspaces/"+id;
 return {db,stripe,service,make,req,p,tick:(ms=1000)=>{clock+=ms;},
  create:(n,name,svc=service)=>svc.create(req,{name:name||"Project "+n,intentId:idFor(n)}),
  record:n=>db.rows.get(p(idFor(n))),set:(n,patch)=>db.rows.set(p(idFor(n)),{...db.rows.get(p(idFor(n))),...patch}),
  account:()=>db.rows.get("gd_accounts/"+owner)};
}
async function paidSecond(f,svc=f.service){
 await f.create(1,"Free",svc);f.tick();await f.create(2,"Paid",svc);
 await svc.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:inv(in30())});
}
async function quiet(fn){const orig=console.error;console.error=()=>{};try{return await fn();}finally{console.error=orig;}}

// ---------- N1 ----------
test("N1: cancel sends only prorate and invoice_now", ()=>{
 assert.deepEqual(jobs.cancelParams(),{invoice_now:true,prorate:true});
});
test("N1: only resource_missing is already done; a bare 404 is permanent",()=>{
 assert.equal(jobs.classifyStripeError(stripeErr({code:"resource_missing",statusCode:404,rawType:"invalid_request_error"})),"missing");
 assert.equal(jobs.classifyStripeError(stripeErr({statusCode:404})),"permanent");
});
test("N1: 400 invalid_request_error, 401 and 403 are permanent",()=>{
 for(const e of [{statusCode:400,rawType:"invalid_request_error",type:"StripeInvalidRequestError",code:"parameter_unknown"},
  {statusCode:401,type:"StripeAuthenticationError"},{statusCode:403,type:"StripePermissionError"}])
  assert.equal(jobs.classifyStripeError(stripeErr(e)),"permanent",JSON.stringify(e));
});
test("N1: 5xx, 429, network errors and timeouts are transient",()=>{
 for(const e of [{statusCode:500},{statusCode:502},{statusCode:503,type:"StripeAPIError"},{statusCode:429,type:"StripeRateLimitError"},
  {code:"ECONNRESET"},{code:"ETIMEDOUT"},{type:"StripeConnectionError",message:"Request timed out"},{message:"socket hang up"}])
  assert.equal(jobs.classifyStripeError(stripeErr(e)),"transient",JSON.stringify(e));
});
for(const [label,error] of [["401",{statusCode:401,type:"StripeAuthenticationError"}],["403",{statusCode:403,type:"StripePermissionError"}],
 ["bare 404",{statusCode:404,rawType:"invalid_request_error"}]]){
 test("N1: a "+label+" alerts subscription_cancel_failed once and is never retried",async()=>{
  const alerts=[];let calls=0;
  const stripe={subscriptions:{cancel:async()=>{calls++;throw stripeErr(error);}}};
  let pending=[{subscriptionId:"sub_p",workspaceId:"w",attempts:0,status:"pending",nextAttemptAt:0}];
  for(let i=0;i<4;i++)pending=await jobs.sweepSubscriptionCancels({stripe,pending,now:1e15,alert:c=>alerts.push(c)});
  assert.equal(calls,1);assert.deepEqual(alerts,["subscription_cancel_failed"]);assert.equal(pending[0].status,"failed");
 });
}
test("N1: a transient error is tried 5 times, then alerts once",async()=>{
 const alerts=[];let calls=0;
 const stripe={subscriptions:{cancel:async()=>{calls++;throw stripeErr({statusCode:503,type:"StripeAPIError"});}}};
 let pending=[{subscriptionId:"sub_t",workspaceId:"w",attempts:0,status:"pending",nextAttemptAt:0}];
 for(let i=0;i<8;i++)pending=await jobs.sweepSubscriptionCancels({stripe,pending,now:1e15+i*1e6,alert:c=>alerts.push(c)});
 assert.equal(calls,jobs.MAX_ATTEMPTS);assert.equal(jobs.MAX_ATTEMPTS,5);
 assert.deepEqual(alerts,["subscription_cancel_failed"]);assert.equal(pending[0].status,"failed");
});
test("N1: resource_missing clears the queued cancel and the workspace's subscription id",async()=>{
 const stripe=stripeDouble({cancel:async()=>{throw stripeErr({code:"resource_missing",statusCode:404});}});
 const f=fixture({stripe});
 await paidSecond(f);await f.service.registerByo(f.req,idFor(1),byoBody);
 assert.deepEqual(f.account().pendingSubscriptionCancels,[]);
 assert.equal(f.record(2).workspaceFeeSubscriptionId,null);
});

// ---------- N2 ----------
function http(f,{routeEnv=env,bucket=null}={}){
 const app=express();app.use(express.json({limit:"16kb"}));
 const auth=(req,res,next)=>{if((req.headers.authorization||"")==="Bearer owner"){req.user={uid:"owner"};return next();}res.status(401).end();};
 registerBillingV2({app,db:f.db,stripe:f.stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>Date.now()}}},auth,agreed:(_q,_s,n)=>n(),
  hash:()=>owner,prices:{},env:routeEnv,byoFetch:null,bucket});
 const server=app.listen(0,"127.0.0.1");
 return new Promise(r=>server.once("listening",r)).then(()=>{
  const base="http://127.0.0.1:"+server.address().port;
  return {call:async(m,u,{token="owner",body}={})=>{
    const r=await fetch(base+u,{method:m,headers:{...(token!==null?{authorization:"Bearer "+token}:{}),...(body?{"content-type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
    const x=await r.text();let j=null;try{j=JSON.parse(x);}catch(_){j=x;}return {status:r.status,body:j};},
   close:()=>new Promise(r=>server.close(r))};
 });
}
test("N2: the internal sweep endpoint needs a Bearer token of at least 16 characters",async()=>{
 const f=fixture();
 for(const [routeEnv,token] of [[env,null],[env,"anything-long-enough"],[{...env,BILLING_SWEEP_TOKEN:"short"},"short"],
  [{...env,BILLING_SWEEP_TOKEN:"0123456789abcdef"},"0123456789abcdeX"],[{...env,BILLING_SWEEP_TOKEN:"0123456789abcdef"},null]]){
  const h=await http(f,{routeEnv});
  try{const r=await h.call("POST","/internal/billing-jobs/sweep",{token});
   assert.equal(r.status,401);assert.deepEqual(r.body,{error:"unauthorized"});}finally{await h.close();}
 }
 assert.equal(sweepTokenMatches({BILLING_SWEEP_TOKEN:"0123456789abcdef"},"Bearer 0123456789abcdef"),true);
});
test("N2: after a restart the scheduled sweep drains a queue nobody touched",async()=>{
 const f=fixture({stripe:{prices:{retrieve:async()=>({...price})}}});   // the process dies before Stripe
 await paidSecond(f);await f.service.remove(f.req,idFor(1));
 assert.equal(f.account().pendingSubscriptionCancels.length,1);
 assert.equal(f.account().billingJobsPending,true);
 f.stripe=stripeDouble();
 const token="sweep-token-0123456789";
 const h=await http(f,{routeEnv:{...env,BILLING_SWEEP_TOKEN:token}});
 try{
  const r=await h.call("POST","/internal/billing-jobs/sweep",{token});
  assert.equal(r.status,200);assert.equal(r.body.ok,true);assert.equal(r.body.swept,1);
 }finally{await h.close();}
 assert.deepEqual(f.stripe.calls.filter(c=>c[0]==="subscriptions.cancel").map(c=>[c[1],c[2]]),[["sub_ws_2",{invoice_now:true,prorate:true}]]);
 assert.deepEqual(f.account().pendingSubscriptionCancels,[]);
 assert.equal(f.account().billingJobsPending,false);
});
test("N2: the pre-activation router (empty secret key) leaves queued cancels pending instead of failing them",async()=>{
 const stripe=stripeDouble({cancel:async()=>{throw stripeErr({statusCode:401,type:"StripeAuthenticationError"});}});
 const f=fixture({stripe});
 await paidSecond(f);
 const svc=createProjectService({db:f.db,stamp:()=>Date.now(),hash:()=>owner,stripe,env,ensureCustomer:async()=>"cus_own",stripeCallsEnabled:false});
 await svc.registerByo(f.req,idFor(1),byoBody);
 assert.equal(stripe.calls.filter(c=>c[0]==="subscriptions.cancel").length,0);
 assert.equal(f.account().pendingSubscriptionCancels[0].status,"pending");
});
test("N2: free_server runs the in-process sweep only off Cloud Run, and the README documents the Scheduler job",()=>{
 const src=fs.readFileSync(path.join(__dirname,"free_server.js"),"utf8");
 assert.match(src,/if\(!process\.env\.K_SERVICE\)\{[\s\S]*sweepRegisteredBillingJobs/);
 const readme=fs.readFileSync(path.join(__dirname,"README.md"),"utf8");
 assert.match(readme,/\/internal\/billing-jobs\/sweep/);assert.match(readme,/Cloud Scheduler/);assert.match(readme,/release blocker/i);
});

// ---------- N3 ----------
test("N3: a sweep writes only outbox fields and keeps account changes made while Stripe was slow",async()=>{
 let release;const gate=new Promise(r=>{release=r;});
 const stripe=stripeDouble({cancel:async id=>{await gate;return {id,status:"canceled"};}});
 const f=fixture({stripe});
 await paidSecond(f);
 const del=f.service.registerByo(f.req,idFor(1),byoBody);   // promotes 2, queues sub_ws_2, sweep waits on Stripe
 await new Promise(r=>setTimeout(r,20));
 f.db.rows.set("gd_accounts/"+owner,{...f.account(),projectRevision:99,freeWorkspaceId:idFor(2),somethingElse:"kept",
  pendingSubscriptionCancels:[...f.account().pendingSubscriptionCancels,{subscriptionId:"sub_other",workspaceId:idFor(9),reason:"workspace_deleted",attempts:0,status:"pending",nextAttemptAt:0}]});
 release();await del;
 assert.equal(f.account().projectRevision,99);assert.equal(f.account().somethingElse,"kept");
 assert.deepEqual(f.account().pendingSubscriptionCancels.map(i=>i.subscriptionId),["sub_other"]);
 assert.equal(f.account().billingJobsPending,true);
});

// ---------- N4 / N6 ----------
function fakeBucket(){
 const objects=new Map(),calls=[];
 const file=key=>({
  delete:async(opts)=>{calls.push(["delete",key,opts]);if(!objects.has(key)&&!opts?.ignoreNotFound)throw Object.assign(new Error("No such object"),{code:404});objects.delete(key);},
  copy:async dest=>{calls.push(["copy",key,dest.key]);objects.set(dest.key,objects.get(key));},
  getMetadata:async()=>[{size:String((objects.get(key)||"").length)}],
  download:async()=>[Buffer.from(objects.get(key)||"")],key});
 return {objects,calls,file,deleteFiles:async({prefix})=>{calls.push(["deleteFiles",prefix]);for(const k of [...objects.keys()])if(k.startsWith(prefix))objects.delete(k);}};
}
test("N4: billing_v2 wires the real bucket into delete, so objects are gone from the bucket",async()=>{
 const f=fixture(),bucket=fakeBucket();
 const h=await http(f,{bucket});
 try{
  await h.call("POST","/v2/projects",{body:{name:"Free",intentId:idFor(1)}});
  const prefix="customer/"+owner+"/managed/"+idFor(1)+"/";
  bucket.objects.set(prefix+"files/a","aa");bucket.objects.set(prefix+"tmp/u1/part","x");bucket.objects.set("customer/"+owner+"/managed/"+idFor(7)+"/files/b","keep");
  f.db.rows.set(f.p(idFor(1))+"/files/a",{name:"a",sizeBytes:2,objectKey:prefix+"files/a"});
  const r=await h.call("DELETE","/v2/projects/"+idFor(1));
  assert.equal(r.status,200,JSON.stringify(r.body));
 }finally{await h.close();}
 assert.deepEqual([...bucket.objects.keys()],["customer/"+owner+"/managed/"+idFor(7)+"/files/b"]);
 assert.ok(bucket.calls.some(c=>c[0]==="deleteFiles"&&c[1]==="customer/"+owner+"/managed/"+idFor(1)+"/"));
});
test("N4: the GCS store refuses to delete outside one workspace prefix",async()=>{
 const store=gcsObjectStore(fakeBucket());
 for(const bad of ["","customer/","customer/"+owner+"/","customer/"+owner+"/managed/","customer/"+owner+"/managed/../x/"])
  await assert.rejects(()=>store.deletePrefix(bad),e=>e.code==="object_store_prefix_rejected");
});
test("N4: with no object store, a workspace with files is never marked purged",async()=>{
 const f=fixture();
 await f.create(1,"Free");f.tick();await f.create(2,"Files");
 f.db.rows.set(f.p(idFor(2))+"/files/f1",{name:"f1",sizeBytes:1,objectKey:"customer/"+owner+"/managed/"+idFor(2)+"/files/f1"});
 await quiet(()=>assert.rejects(()=>f.service.remove(f.req,idFor(2)),e=>e.code==="WORKSPACE_PURGE_PENDING"));
 const marker=f.db.rows.get("gd_accounts/"+owner+"/workspace_purges/"+idFor(2));
 assert.equal(marker.steps.objects,"error");assert.notEqual(marker.phase,"completed");
 assert.equal(f.record(2).projectStatus,"deleting");
 assert.ok(f.db.rows.get(f.p(idFor(2))+"/files/f1"));
});
test("N4: in production (store required) a missing store fails closed even with no file records",async()=>{
 const f=fixture({objectStoreRequired:true});
 await f.create(1,"Free");f.tick();await f.create(2,"Empty");
 await quiet(()=>assert.rejects(()=>f.service.remove(f.req,idFor(2)),e=>e.code==="WORKSPACE_PURGE_PENDING"));
 assert.equal(f.record(2).projectStatus,"deleting");
});
test("N4: billing_v2 requires the store on Cloud Run (K_SERVICE set)",async()=>{
 const f=fixture();
 const h=await http(f,{routeEnv:{...env,K_SERVICE:"gendragoon-free"}});
 try{
  await h.call("POST","/v2/projects",{body:{name:"Free",intentId:idFor(1)}});
  const r=await quiet(()=>h.call("DELETE","/v2/projects/"+idFor(1)));
  assert.equal(r.status,503);
 }finally{await h.close();}
 assert.equal(f.record(1).projectStatus,"deleting");
});
test("N6: a 404 from the store on a purge retry counts as already deleted",async()=>{
 const objects=new Set(["k1","k2"]);let n=0;
 const store={async delete(k){n++;if(n===2)throw Object.assign(new Error("gcs 503"),{code:503});
  if(!objects.delete(k))throw Object.assign(new Error("Not Found"),{code:404});}};
 const f=fixture({objectStore:store});
 await f.create(1,"Free");f.tick();await f.create(2,"Files");
 f.db.rows.set(f.p(idFor(2))+"/files/a",{name:"a",sizeBytes:1,objectKey:"k1"});
 f.db.rows.set(f.p(idFor(2))+"/files/b",{name:"b",sizeBytes:1,objectKey:"k2"});
 await quiet(()=>assert.rejects(()=>f.service.remove(f.req,idFor(2))));
 const r=await f.service.remove(f.req,idFor(2));
 assert.equal(r.deleted,true);assert.equal(objects.size,0);
});

// ---------- N5 ----------
test("N5: an expired first Checkout does not count toward the cap; an open one does",()=>{
 const now=Date.now();
 const base=n=>({id:idFor(n),kind:"paid",projectBillingVersion:2,projectStatus:"active",projectFeeStatus:"paid",provisioned:true});
 const pending=(n,expiresAt)=>({id:idFor(n),kind:"paid",projectBillingVersion:2,projectStatus:"pending_payment",projectFeeStatus:"pending",
  workspaceFeeModel:"monthly",workspaceFeeStatus:"pending",workspaceFeeCheckoutSessionId:"cs_"+n,checkoutExpiresAtMs:expiresAt});
 const list=[...Array.from({length:9},(_,i)=>base(i+1)),pending(10,now-1)];
 assert.equal(abandonedCheckout(list[9]),true);
 assert.equal(summarizeProjects(list).used,9);
 assert.equal(summarizeProjects([...list.slice(0,9),pending(10,now+60_000)]).used,10);
});
test("N5: an expired first Checkout frees its slot for a new workspace",async()=>{
 const f=fixture();
 await f.create(1,"Free");
 for(let n=2;n<=10;n++){f.tick();await f.create(n,"Project "+n);}
 await assert.rejects(()=>f.create(11,"Project 11"),e=>e.code==="PROJECT_LIMIT_REACHED");
 f.set(10,{workspaceFeeCheckoutSessionId:"cs_10",checkoutExpiresAtMs:Date.now()-1});
 const r=await f.create(11,"Project 11");
 assert.equal(r.project.id,idFor(11));
});
test("N5: an open first Checkout and a completed unreconciled one still answer 409 checkout_open",async()=>{
 for(const status of ["open","complete"]){
  const f=fixture({stripe:stripeDouble({sessionStatus:status})});
  await f.create(1,"Free");f.tick();await f.create(2,"Paying");
  f.set(2,{workspaceFeeCheckoutSessionId:"cs_x",checkoutExpiresAtMs:Date.now()+3600_000});
  await assert.rejects(()=>f.service.remove(f.req,idFor(2)),e=>e.status===409&&e.code==="workspace_busy"&&e.reason==="checkout_open");
  assert.equal(f.stripe.calls.filter(c=>c[0]==="checkout.expire").length,0);
 }
});
test("N5: a Stripe lookup error fails closed as checkout_open; resource_missing counts as expired",async()=>{
 const stripe=stripeDouble();
 stripe.checkout.sessions.retrieve=async()=>{throw stripeErr({statusCode:503,type:"StripeAPIError"});};
 const f=fixture({stripe});
 await f.create(1,"Free");f.tick();await f.create(2,"Paying");
 f.set(2,{workspaceFeeCheckoutSessionId:"cs_x",checkoutExpiresAtMs:Date.now()-1});
 await assert.rejects(()=>f.service.remove(f.req,idFor(2)),e=>e.reason==="checkout_open");
 stripe.checkout.sessions.retrieve=async()=>{throw stripeErr({code:"resource_missing",statusCode:404});};
 const r=await f.service.remove(f.req,idFor(2));
 assert.equal(r.deleted,true);
});
test("N5: deleting a workspace in grace expires its open renewal Checkout",async()=>{
 const stripe=stripeDouble();const f=fixture({stripe});
 await f.create(1,"Oldest");f.tick();await f.create(2,"Second");
 await f.service.registerByo(f.req,idFor(1),byoBody);
 const back=await f.service.makeHosted(f.req,idFor(1));
 assert.equal(f.record(2).projectStatus,"active","demoted workspace keeps working during grace");
 const session=f.record(2).workspaceFeeCheckoutSessionId;
 const r=await f.service.remove(f.req,back.demoted.workspaceId);
 assert.equal(r.deleted,true);
 assert.deepEqual(stripe.calls.filter(c=>c[0]==="checkout.expire").map(c=>c[1]),[session]);
 assert.deepEqual(f.account().pendingCheckoutExpires,[]);
});
test("N5: busyReason keeps merge_active and uploads_pending",()=>{
 assert.equal(busyReason({mergeLock:{phase:"copying"}}),"merge_active");
 assert.equal(busyReason({reservedBytes:1}),"uploads_pending");
 assert.equal(busyReason({},{uploadsEmpty:false}),"uploads_pending");
 assert.equal(busyReason({checkoutLease:{expiresAtMs:Date.now()+1000}}),"checkout_open");
 assert.equal(busyReason({projectStatus:"pending_payment",projectFeeStatus:"pending",projectCheckoutSessionId:"cs"},{sessions:{cs:"expired"}}),null);
});

// ---------- N7 ----------
test("N7: a late invoice.paid for the cancelled subscription does not rebind the workspace",async()=>{
 const stripe=stripeDouble();const f=fixture({stripe});
 await paidSecond(f);
 await f.service.registerByo(f.req,idFor(1),byoBody);      // 2 promoted, sub_ws_2 cancelled and retired
 await f.service.makeHosted(f.req,idFor(1));               // 2 demoted again
 assert.ok(f.record(2).retiredSubscriptionIds.includes("sub_ws_2"));
 await f.service.reconcileWorkspaceFee(sub(2,"active","sub_ws_2"),{eventType:"invoice.paid",invoice:inv(in30())});
 assert.equal(f.record(2).workspaceFeeSubscriptionId??null,null);
 assert.notEqual(f.record(2).workspaceFeeStatus,"active");
});
test("N7: an event for another subscription cannot overwrite the current active one",async()=>{
 const f=fixture();
 await paidSecond(f);
 await f.service.reconcileWorkspaceFee(sub(2,"past_due","sub_other"),{eventType:"customer.subscription.updated"});
 assert.equal(f.record(2).workspaceFeeSubscriptionId,"sub_ws_2");assert.equal(f.record(2).workspaceFeeStatus,"active");
 await f.service.reconcileWorkspaceFee(sub(2,"canceled","sub_other"),{eventType:"customer.subscription.deleted"});
 assert.equal(f.record(2).workspaceFeeSubscriptionId,"sub_ws_2");assert.equal(f.record(2).workspaceFeeStatus,"active");
 await f.service.reconcileWorkspaceFee(sub(2,"canceled"),{eventType:"customer.subscription.deleted"});
 assert.equal(f.record(2).workspaceFeeStatus,"canceled");
});

// ---------- N8 ----------
test("N8: grace is 3 days in total for demoted, BYO and hosted alike",async()=>{
 assert.equal(LAPSE_GRACE_MS,3*24*60*60*1000);
 const f=fixture();
 await f.create(1,"Oldest");f.tick();await f.create(2,"Second");
 await f.service.registerByo(f.req,idFor(1),byoBody);
 const before=Date.now();
 const back=await f.service.makeHosted(f.req,idFor(1));
 const demoted=f.record(2);
 assert.ok(back.demoted.graceEndsAt-before<=LAPSE_GRACE_MS+5000);
 assert.equal(evaluateLapse(demoted,before+LAPSE_GRACE_MS-60_000).lapsed,false);
 assert.equal(evaluateLapse(demoted,Date.now()+LAPSE_GRACE_MS+1).lapsed,true);
 const byo={kind:"paid",providerType:"s3",byoRegistered:true,workspaceFeeModel:"monthly",workspaceFeeStatus:"unpaid",workspaceFeePaid:false,
  paidThroughMs:before,createdAt:before};
 assert.equal(byoLapsed(byo,before+LAPSE_GRACE_MS-1),false);assert.equal(byoLapsed(byo,before+LAPSE_GRACE_MS),true);
 const hosted={kind:"paid",workspaceFeeModel:"monthly",workspaceFeeStatus:"past_due",workspaceFeePaid:false,paidThroughMs:before,createdAt:before};
 assert.equal(evaluateLapse(hosted,before+LAPSE_GRACE_MS-1).lapsed,false);assert.equal(evaluateLapse(hosted,before+LAPSE_GRACE_MS).lapsed,true);
});
test("N8: no other grace length is defined in server code",()=>{
 const hits=[];
 for(const file of fs.readdirSync(__dirname).filter(x=>x.endsWith(".js")&&!x.includes("test")))
  fs.readFileSync(path.join(__dirname,file),"utf8").split("\n").forEach((line,i)=>{if(/GRACE[A-Z_]*\s*=/.test(line))hits.push(file+":"+(i+1));});
 assert.deepEqual(hits,["workspace_policy.js:"+(fs.readFileSync(path.join(__dirname,"workspace_policy.js"),"utf8").split("\n").findIndex(l=>/const LAPSE_GRACE_MS=/.test(l))+1)]);
});

// ---------- Lows ----------
test("Lows: the legacy draft endpoint no longer says the fee is paid once",()=>{
 const src=fs.readFileSync(path.join(__dirname,"billing_v2.js"),"utf8");
 assert.doesNotMatch(src,/costs \$"\+\(WORKSPACE_FEE_CENTS\/100\)\+" once/);
 assert.match(src,/WORKSPACE_FEE_LABEL\+" a month\."/);
});

// ---------- Deploy ----------
test("deploy_free.py ships every module free_server.js requires (billing_jobs, workspace_purge, object_store)",()=>{
 const seen=new Set();
 (function walk(file){
  if(seen.has(file))return;seen.add(file);
  for(const m of fs.readFileSync(path.join(__dirname,file),"utf8").matchAll(/require\(["']\.\/([^"']+)["']\)/g)){
   const name=/\.(js|json)$/.test(m[1])?m[1]:m[1]+".js";walk(name);}
 })("free_server.js");
 const deploy=fs.readFileSync(path.join(__dirname,"deploy_free.py"),"utf8");
 const listed=new Set([...deploy.slice(deploy.indexOf("RUNTIME_FILES"),deploy.indexOf(")",deploy.indexOf("RUNTIME_FILES"))).matchAll(/"([^"]+)"/g)].map(m=>m[1]));
 assert.deepEqual([...seen].filter(f=>!listed.has(f)),[]);
});
