"use strict";
// Morgan's independent probes for PR #5 @1254579 (N1-N8, Lows, deploy, grace ruling, merge outbox).
// Written without reusing Casey's 5a9d6c5 tests or Riley's helpers. Local only: in-memory Firestore
// double, Stripe doubles, optional local stripe-mock (STRIPE_MOCK_URL). No credentials, no real Stripe.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const fs=require("node:fs"),path=require("node:path"),express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {createProjectService}=require("./projects");
const jobs=require("./billing_jobs");
const {registerBillingV2,sweepTokenMatches}=require("./billing_v2");
const {gcsObjectStore,assertWorkspacePrefix}=require("./object_store");
const policy=require("./workspace_policy");
const {busyReason,abandonedCheckout}=require("./workspace_purge");

const DAY=24*60*60*1000;
const ownerHash=crypto.createHash("sha256").update("morgan-pr5-probe").digest("hex");
const wid=n=>"5a5a5a5a-0000-4000-8000-"+String(n).padStart(12,"0");
// Fake token built from parts so no secret-looking literal lives in the repo.
const sweepToken=["probe","sweep","token","x".repeat(8)].join("-");
const baseEnv={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_WORKSPACE_MONTHLY_READY:"true",STRIPE_WORKSPACE_MONTHLY_PRICE_ID:"price_probeM",
 STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://probe.example",BILLING_SWEEP_TOKEN:sweepToken};
const monthly={id:"price_probeM",active:true,type:"recurring",recurring:{interval:"month"},currency:"usd",
 unit_amount:require("./catalog").WORKSPACE_FEE_CENTS,billing_scheme:"per_unit",livemode:false,product:{active:true}};
const err=fields=>Object.assign(new Error(fields.message||"stripe probe error"),fields);
const silent=async fn=>{const o=console.error;console.error=()=>{};try{return await fn();}finally{console.error=o;}};

function fakeStripe(over={}){
 const log=[];let n=0;
 const s={log,
  prices:{retrieve:async()=>({...monthly})},customers:{create:async()=>({id:"cus_probe"})},
  checkout:{sessions:{
   create:async()=>{n++;return {id:"cs_probe_"+n,url:"https://checkout.stripe.com/c/pay/cs_probe_"+n,status:"open",expires_at:Math.floor(Date.now()/1000)+DAY/1000};},
   retrieve:async id=>{log.push(["retrieve",id]);return {id,status:over.sessionStatus?over.sessionStatus(id):"open",url:"https://checkout.stripe.com/c/pay/"+id};},
   expire:async id=>{log.push(["expire",id]);return {id,status:"expired"};}}},
  subscriptions:{cancel:async function(id,params,opts){log.push(["cancel",id,params,opts]);if(over.cancel)return over.cancel.call(this,id,params,opts);return {id,status:"canceled"};}}};
 return s;
}
function world({stripe=fakeStripe(),objectStore=null,objectStoreRequired=false}={}){
 const db=memoryFirestore([["gd_accounts/"+ownerHash,{stripeCustomerId:"cus_probe"}]]);
 const svc=createProjectService({db,stamp:()=>Date.now(),hash:()=>ownerHash,stripe,env:baseEnv,ensureCustomer:async()=>"cus_probe",objectStore,objectStoreRequired});
 const req={user:{uid:"probe-user"}},key=n=>"gd_accounts/"+ownerHash+"/workspaces/"+wid(n);
 return {db,stripe,svc,req,
  make:async(n,name)=>{const r=await svc.create(req,{name:name||"Workspace "+n,intentId:wid(n)});await new Promise(r=>setTimeout(r,2));return r;},
  row:n=>db.rows.get(key(n)),patch:(n,p)=>db.rows.set(key(n),{...db.rows.get(key(n)),...p}),key,
  acct:()=>db.rows.get("gd_accounts/"+ownerHash),setAcct:p=>db.rows.set("gd_accounts/"+ownerHash,{...db.rows.get("gd_accounts/"+ownerHash),...p})};
}
const subEvt=(n,id,status="active")=>({id,status,customer:"cus_probe",metadata:{kind:"workspace_fee",accountHash:ownerHash,workspaceId:wid(n)}});
const periodEnd=()=>({lines:{data:[{period:{end:Math.floor(Date.now()/1000)+30*86400}}]}});
async function withHttp(w,fn,{env=baseEnv,bucket=null}={}){
 const app=express();app.use(express.json());
 const auth=(req,res,next)=>{if(req.headers.authorization==="Bearer user"){req.user={uid:"probe-user"};return next();}res.status(401).end();};
 registerBillingV2({app,db:w.db,stripe:w.stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>Date.now()}}},auth,agreed:(_a,_b,n)=>n(),
  hash:()=>ownerHash,prices:{},env,bucket});
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
 const base="http://127.0.0.1:"+server.address().port;
 const call=async(method,url,{auth:a="Bearer user",body}={})=>{
  const headers={};if(a!==null)headers.authorization=a;if(body)headers["content-type"]="application/json";
  const r=await fetch(base+url,{method,headers,body:body?JSON.stringify(body):undefined});const t=await r.text();
  let j;try{j=JSON.parse(t);}catch(_){j=t;}return {status:r.status,body:j};};
 try{return await fn(call);}finally{await new Promise(r=>server.close(r));}
}

// ================= N1 =================
test("N1 probe: cancel params are exactly {invoice_now:true, prorate:true}",()=>{
 assert.deepEqual(jobs.cancelParams(),{invoice_now:true,prorate:true});
 assert.equal("proration_behavior" in jobs.cancelParams(),false);
});
test("N1 probe: error classification table",()=>{
 const table=[
  [{code:"resource_missing",statusCode:404},"missing"],
  [{statusCode:404},"permanent"],                                        // bare 404 is not proof
  [{statusCode:404,type:"StripeInvalidRequestError",rawType:"invalid_request_error"},"permanent"],
  [{statusCode:400,type:"StripeInvalidRequestError",rawType:"invalid_request_error"},"permanent"],
  [{statusCode:401,type:"StripeAuthenticationError"},"permanent"],
  [{statusCode:403,type:"StripePermissionError"},"permanent"],
  [{statusCode:429,type:"StripeRateLimitError"},"transient"],
  [{statusCode:500,type:"StripeAPIError"},"transient"],
  [{statusCode:503},"transient"],
  [{code:"ETIMEDOUT"},"transient"],
  [{type:"StripeConnectionError",message:"Request aborted due to timeout"},"transient"],
 ];
 for(const [e,want] of table)assert.equal(jobs.classifyStripeError(err(e)),want,JSON.stringify(e));
});
async function drive(error,{rounds=8}={}){
 let calls=0;const alerts=[];
 const stripe={subscriptions:{cancel:async()=>{calls++;throw err(error);}}};
 let pending=[{subscriptionId:"sub_p",workspaceId:"w",attempts:0,status:"pending",nextAttemptAt:0}];
 let now=Date.now();
 for(let i=0;i<rounds;i++){pending=await jobs.sweepSubscriptionCancels({stripe,pending,now,alert:(c,d)=>alerts.push(c)});now+=10*60_000;}
 return {calls,alerts,pending};
}
for(const [label,e] of [["400 invalid_request_error",{statusCode:400,rawType:"invalid_request_error",type:"StripeInvalidRequestError"}],
 ["401",{statusCode:401,type:"StripeAuthenticationError"}],["403",{statusCode:403,type:"StripePermissionError"}],["bare 404",{statusCode:404}]])
 test("N1 probe: "+label+" alerts exactly once and stops after one call",async()=>{
  const r=await drive(e);
  assert.equal(r.calls,1);assert.equal(r.alerts.length,1);
  assert.ok(r.pending.every(p=>p.status!=="pending"),JSON.stringify(r.pending));
 });
for(const [label,e] of [["429",{statusCode:429}],["500",{statusCode:500}],["503",{statusCode:503}],["timeout",{code:"ETIMEDOUT"}]])
 test("N1 probe: "+label+" retries to 5 attempts, then alerts once",async()=>{
  const r=await drive(e,{rounds:12});
  assert.equal(r.calls,jobs.MAX_ATTEMPTS);assert.equal(r.alerts.length,1);
 });
test("N1 probe: resource_missing clears the entry with no alert",async()=>{
 const cleared=[];const alerts=[];
 const out=await jobs.sweepSubscriptionCancels({stripe:{subscriptions:{cancel:async()=>{throw err({code:"resource_missing",statusCode:404});}}},
  pending:[{subscriptionId:"sub_gone",workspaceId:"w",attempts:0,status:"pending",nextAttemptAt:0}],alert:c=>alerts.push(c),onCleared:async i=>cleared.push(i.subscriptionId)});
 assert.ok(out.every(p=>p.subscriptionId!=="sub_gone"||p.status==="done"));assert.deepEqual(alerts,[]);
});
test("N1 probe: the sweep calls cancel with its SDK object bound (this === stripe.subscriptions)",async()=>{
 const resource={_ok:true,cancel:async function(){if(!this||this._ok!==true)throw new TypeError("unbound");return {};}};
 const alerts=[];
 const out=await jobs.sweepSubscriptionCancels({stripe:{subscriptions:resource},alert:c=>alerts.push(c),
  pending:[{subscriptionId:"sub_b",workspaceId:"w",attempts:0,status:"pending",nextAttemptAt:0}]});
 assert.deepEqual(alerts,[]);assert.equal(out.filter(p=>p.status==="pending").length,0);
});

// stripe-mock (local only). Skips unless STRIPE_MOCK_URL points at a local stripe-mock.
const mockUrl=process.env.STRIPE_MOCK_URL||"";
const mockSkip=mockUrl?false:"STRIPE_MOCK_URL not set";
function mockClient(port){
 const Stripe=require("stripe"),u=new URL(mockUrl||"http://127.0.0.1:1");
 if(!["localhost","127.0.0.1"].includes(u.hostname))throw new Error("stripe-mock must be local");
 return new Stripe(["sk","test","probe"].join("_"),{host:u.hostname,port:port||Number(u.port),protocol:"http",maxNetworkRetries:0,timeout:1500});
}
test("stripe-mock probe: real SDK cancel through the sweep is accepted and clears",{skip:mockSkip},async()=>{
 const alerts=[],cleared=[];
 await jobs.sweepSubscriptionCancels({stripe:mockClient(),alert:c=>alerts.push(c),onCleared:async i=>cleared.push(i.subscriptionId),
  pending:[{subscriptionId:"sub_morgan_mock",workspaceId:"w",attempts:0,status:"pending",nextAttemptAt:0}]});
 assert.deepEqual(alerts,[]);assert.deepEqual(cleared,["sub_morgan_mock"]);
});
test("stripe-mock probe: the old proration_behavior param is a 400 that classifies permanent",{skip:mockSkip},async()=>{
 const e=await mockClient().subscriptions.cancel("sub_x",{prorate:true,invoice_now:true,proration_behavior:"create_prorations"}).then(()=>null,x=>x);
 assert.ok(e);assert.equal(e.statusCode,400);assert.equal(jobs.classifyStripeError(e),"permanent");
});
test("stripe-mock probe: an unreachable Stripe (connection refused) classifies transient",{skip:mockSkip},async()=>{
 const e=await mockClient(1).subscriptions.cancel("sub_x",jobs.cancelParams()).then(()=>null,x=>x);
 assert.ok(e);assert.equal(jobs.classifyStripeError(e),"transient",e.type+" "+e.code);
});

// ================= N2 =================
test("N2 probe: sweepTokenMatches rejects missing, wrong, prefix, padded and short-configured tokens",()=>{
 const env={BILLING_SWEEP_TOKEN:sweepToken};
 assert.equal(sweepTokenMatches(env,"Bearer "+sweepToken),true);
 for(const bad of [undefined,"","Bearer","Bearer ","bearer "+sweepToken,sweepToken,"Bearer "+sweepToken.slice(0,-1),"Bearer "+sweepToken+"x",
  "Bearer "+sweepToken+" ","Basic "+sweepToken,"Bearer "+sweepToken.toUpperCase()])assert.equal(sweepTokenMatches(env,bad),false,String(bad));
 assert.equal(sweepTokenMatches({BILLING_SWEEP_TOKEN:"short"},"Bearer short"),false);
 assert.equal(sweepTokenMatches({},"Bearer "),false);
});
test("N2 probe: the route answers 401 without/with a wrong token and 200 with the right one",async()=>{
 const w=world();
 await withHttp(w,async call=>{
  assert.equal((await call("POST","/internal/billing-jobs/sweep",{auth:null})).status,401);
  assert.equal((await call("POST","/internal/billing-jobs/sweep",{auth:"Bearer "+"y".repeat(sweepToken.length)})).status,401);
  assert.equal((await call("POST","/internal/billing-jobs/sweep",{auth:"Bearer user"})).status,401);
  const ok=await call("POST","/internal/billing-jobs/sweep",{auth:"Bearer "+sweepToken});
  assert.equal(ok.status,200);assert.equal(ok.body.ok,true);
 });
});
test("N2 probe: the token compare is constant-time (timingSafeEqual over digests, no === on the secret)",()=>{
 const src=fs.readFileSync(path.join(__dirname,"billing_v2.js"),"utf8");
 const fn=src.slice(src.indexOf("function sweepTokenMatches"),src.indexOf("function sweepRegisteredBillingJobs"));
 assert.match(fn,/timingSafeEqual/);
 assert.doesNotMatch(fn,/presented\s*===\s*expected|expected\s*===\s*presented/);
});

// ================= N3 =================
test("N3 probe: a cancel queued by another request while Stripe is in flight survives the sweep; non-outbox fields untouched",async()=>{
 let w;
 const stripe=fakeStripe({cancel:async id=>{
  if(id==="sub_first"){
   const a=w.acct();
   w.setAcct({pendingSubscriptionCancels:[...a.pendingSubscriptionCancels,{subscriptionId:"sub_concurrent",workspaceId:wid(9),attempts:0,status:"pending",nextAttemptAt:0}],
    billingJobsPending:true,freeWorkspaceId:"changed-concurrently",unrelatedMarker:"keep-me"});
  }
  return {id,status:"canceled"};
 }});
 w=world({stripe});
 w.setAcct({pendingSubscriptionCancels:[{subscriptionId:"sub_first",workspaceId:wid(8),attempts:0,status:"pending",nextAttemptAt:0}],billingJobsPending:true,freeWorkspaceId:"orig"});
 // stall the second cancel so only the snapshot-time entry is swept in this pass
 const orig=stripe.subscriptions.cancel;let first=true;
 stripe.subscriptions.cancel=async function(id,...rest){if(!first&&id==="sub_concurrent")throw err({statusCode:503});first=false;return orig.call(this,id,...rest);};
 await w.svc.sweepAccount(ownerHash);
 const a=w.acct();
 assert.ok(a.pendingSubscriptionCancels.some(p=>p.subscriptionId==="sub_concurrent"),"concurrent cancel lost: "+JSON.stringify(a.pendingSubscriptionCancels));
 assert.ok(!a.pendingSubscriptionCancels.some(p=>p.subscriptionId==="sub_first"));
 assert.equal(a.freeWorkspaceId,"changed-concurrently");assert.equal(a.unrelatedMarker,"keep-me");
 assert.equal(a.billingJobsPending,true);
});
test("N3 probe: the sweep's write happens inside a transaction (re-read before write)",async()=>{
 const w=world();
 w.setAcct({pendingSubscriptionCancels:[{subscriptionId:"sub_t",workspaceId:wid(8),attempts:0,status:"pending",nextAttemptAt:0}],billingJobsPending:true});
 const before=w.db.transactionCount;
 await w.svc.sweepAccount(ownerHash);
 assert.ok(w.db.transactionCount>before);
});

// ================= N4 =================
test("N4 probe: prefix guard rejects traversal, sibling, wrong-owner and malformed prefixes",()=>{
 const good="customer/"+ownerHash+"/managed/"+wid(1)+"/";
 assert.doesNotThrow(()=>assertWorkspacePrefix(good));
 for(const bad of [good.slice(0,-1),"customer/"+ownerHash+"/managed/../"+wid(1)+"/","customer/"+ownerHash+"/managed/"+wid(1)+"/../",
  "customer/"+ownerHash+"/managed/"+wid(1)+"/files/","customer/"+ownerHash+"/managed/./","customer/"+ownerHash+"/managed/%2e%2e/",
  "customer/"+ownerHash.toUpperCase()+"/managed/"+wid(1)+"/","customer/"+ownerHash+"/byo/"+wid(1)+"/","/customer/"+ownerHash+"/managed/"+wid(1)+"/",
  "customer/"+ownerHash+"/managed/"+wid(1)+"/\n",null,{}])
  assert.throws(()=>assertWorkspacePrefix(bad),e=>e.code==="object_store_prefix_rejected",String(bad));
});
test("N4 probe: deleting workspace 1 leaves sibling prefix <id>-x and other workspaces untouched",async()=>{
 const objects=new Map();
 const bucket={file:k=>({delete:async()=>{objects.delete(k);},getMetadata:async()=>[{}],download:async()=>[Buffer.alloc(0)],copy:async()=>{}}),
  deleteFiles:async({prefix})=>{for(const k of [...objects.keys()])if(k.startsWith(prefix))objects.delete(k);}};
 const w=world({objectStore:gcsObjectStore(bucket)});
 await w.make(1);await w.make(2);
 const p=n=>"customer/"+ownerHash+"/managed/"+wid(n)+"/";
 objects.set(p(2)+"files/a",1);objects.set(p(2).slice(0,-1)+"-x/files/b",1);objects.set(p(1)+"files/c",1);
 await w.svc.remove(w.req,wid(2));
 assert.deepEqual([...objects.keys()].sort(),[p(1)+"files/c",p(2).slice(0,-1)+"-x/files/b"].sort());
});
test("N4 probe: a traversal workspace id is rejected before any delete",async()=>{
 const w=world({objectStore:{deletePrefix:async()=>{throw new Error("must not be called");},delete:async()=>{throw new Error("must not be called");}}});
 await w.make(1);
 for(const id of ["../"+wid(1),wid(1)+"/..","..","%2e%2e"])await assert.rejects(()=>w.svc.remove(w.req,id),e=>[400,404].includes(e.status),id);
});
test("N4 probe (GAP): per-file deletes are not limited to the workspace prefix",{todo:"workspace_purge.js:111 deletes each files/*.objectKey with no assertWorkspacePrefix; a file record pointing at another workspace's object is deleted"},async()=>{
 const deleted=[];
 const w=world({objectStore:{deletePrefix:async()=>{},delete:async k=>{deleted.push(k);}}});
 await w.make(1);await w.make(2);
 const other="customer/"+ownerHash+"/managed/"+wid(1)+"/files/victim";
 w.db.rows.set(w.key(2)+"/files/f",{name:"f",sizeBytes:1,objectKey:other});
 await w.svc.remove(w.req,wid(2));
 assert.deepEqual(deleted.filter(k=>!k.startsWith("customer/"+ownerHash+"/managed/"+wid(2)+"/")),[]);
});
test("N4 probe: on Cloud Run (K_SERVICE) with no bucket, delete fails closed (503, nothing marked purged)",async()=>{
 const w=world();
 await withHttp(w,async call=>{
  await call("POST","/v2/projects",{body:{name:"Alpha",intentId:wid(1)}});
  const r=await silent(()=>call("DELETE","/v2/projects/"+wid(1)));
  assert.equal(r.status,503);
 },{env:{...baseEnv,K_SERVICE:"probe-svc"}});
 assert.equal(w.row(1).projectStatus,"deleting");
 const m=w.db.rows.get("gd_accounts/"+ownerHash+"/workspace_purges/"+wid(1));
 assert.notEqual(m?.phase,"completed");
});
test("N4 probe (GAP): registerBillingV2 refuses to start on Cloud Run without a store, like the webhook gate",{todo:"billing_v2.js:84-85 only marks the store required; no startup throw on K_SERVICE without bucket/objectStore, failure shows up per delete as 503"},()=>{
 const app=express();
 assert.throws(()=>registerBillingV2({app,db:memoryFirestore(),stripe:fakeStripe(),admin:{firestore:{FieldValue:{serverTimestamp:()=>0}}},
  auth:(_a,_b,n)=>n(),agreed:(_a,_b,n)=>n(),hash:()=>ownerHash,prices:{},env:{...baseEnv,K_SERVICE:"probe-svc"}}));
});

// ================= N5 =================
test("N5 probe: an expired activation checkout neither blocks delete nor uses a slot; open one does both",async()=>{
 const pend=(exp)=>({projectStatus:"pending_payment",projectFeeStatus:"pending",workspaceFeeStatus:"pending",workspaceFeeModel:"monthly",
  workspaceFeeCheckoutSessionId:"cs_q",checkoutExpiresAtMs:exp});
 assert.equal(busyReason(pend(Date.now()-1)),null);
 assert.equal(busyReason(pend(Date.now()+60_000)),"checkout_open");
 assert.equal(busyReason(pend(Date.now()+60_000),{sessions:{cs_q:"expired"}}),null);
 assert.equal(abandonedCheckout(pend(Date.now()-1)),true);assert.equal(abandonedCheckout(pend(Date.now()+60_000)),false);
});
for(const [label,thrown] of [["503",{statusCode:503,type:"StripeAPIError"}],["401",{statusCode:401,type:"StripeAuthenticationError"}],["timeout",{code:"ETIMEDOUT"}]])
 test("N5 probe: a failed Stripe session lookup ("+label+") blocks delete even if the stored expiry has passed",async()=>{
  const stripe=fakeStripe();stripe.checkout.sessions.retrieve=async()=>{throw err(thrown);};
  const w=world({stripe});await w.make(1);await w.make(2);
  w.patch(2,{workspaceFeeCheckoutSessionId:"cs_q",checkoutExpiresAtMs:Date.now()-1000});
  await assert.rejects(()=>w.svc.remove(w.req,wid(2)),e=>e.status===409&&e.reason==="checkout_open");
 });

// ================= N6 =================
test("N6 probe: purge retry treats a 404 per-object delete as done; a 403 stays an error",async()=>{
 let fail=true;const store={delete:async()=>{if(fail){fail=false;throw err({code:503,message:"backend"});}throw err({code:404,message:"No such object"});}};
 const w=world({objectStore:store});await w.make(1);await w.make(2);
 w.db.rows.set(w.key(2)+"/files/f",{name:"f",sizeBytes:1,objectKey:"customer/"+ownerHash+"/managed/"+wid(2)+"/files/f"});
 await silent(()=>assert.rejects(()=>w.svc.remove(w.req,wid(2))));
 assert.equal((await w.svc.remove(w.req,wid(2))).deleted,true);
 const w2=world({objectStore:{delete:async()=>{throw err({code:403,message:"forbidden"});}}});await w2.make(1);await w2.make(2);
 w2.db.rows.set(w2.key(2)+"/files/f",{name:"f",sizeBytes:1,objectKey:"customer/"+ownerHash+"/managed/"+wid(2)+"/files/f"});
 await silent(()=>assert.rejects(()=>w2.svc.remove(w2.req,wid(2))));
 assert.notEqual(w2.db.rows.get("gd_accounts/"+ownerHash+"/workspace_purges/"+wid(2)).phase,"completed");
});

// ================= N7 =================
test("N7 probe: events for a retired or foreign subscription id never change the workspace",async()=>{
 const w=world();await w.make(1);await w.make(2);
 await w.svc.reconcileWorkspaceFee(subEvt(2,"sub_cur"),{eventType:"invoice.paid",invoice:periodEnd()});
 assert.equal(w.row(2).workspaceFeeSubscriptionId,"sub_cur");
 w.patch(2,{retiredSubscriptionIds:["sub_old"]});
 const snap=JSON.stringify(w.row(2));
 for(const [id,status,type] of [["sub_old","active","invoice.paid"],["sub_old","canceled","customer.subscription.deleted"],
  ["sub_foreign","past_due","customer.subscription.updated"],["sub_foreign","active","customer.subscription.updated"]])
  await w.svc.reconcileWorkspaceFee(subEvt(2,id,status),{eventType:type,invoice:periodEnd()});
 assert.equal(JSON.stringify(w.row(2)),snap);
});

// ================= N8 =================
test("N8 probe: LAPSE_GRACE_MS is exactly 3 days and no other 3-/6-day duration exists in server code",()=>{
 assert.equal(policy.LAPSE_GRACE_MS,3*DAY);
 const pats=[/\b259_?200_?000\b/,/\b518_?400_?000\b/,/\b(3|6)\s*\*\s*24\s*\*\s*60\s*\*\s*60/,/\b(72|144)\s*\*\s*60\s*\*\s*60/,/\b(259200|518400)\b/,/\b(4320|8640)\s*\*\s*60/];
 const hits=[];
 for(const f of fs.readdirSync(__dirname).filter(x=>x.endsWith(".js")&&!x.includes(".test.")&&x!=="test_firestore.js"))
  fs.readFileSync(path.join(__dirname,f),"utf8").split("\n").forEach((l,i)=>{if(pats.some(p=>p.test(l)))hits.push(f+":"+(i+1));});
 assert.deepEqual(hits,["workspace_policy.js:13"]);
});

// ===== Grace ruling (Avery): demoted workspace active with open renewal checkout for full 3 days, locks at 3 days =====
async function demote(stripe=fakeStripe()){
 const w=world({stripe});await w.make(1);await w.make(2);
 await w.svc.registerByo(w.req,wid(1),{provider:"s3",endpoint:"https://b.s3.us-east-1.amazonaws.com",bucketFingerprint:"ab".repeat(8)});
 const t0=Date.now();const back=await w.svc.makeHosted(w.req,wid(1));
 return {w,t0,back,id:back.demoted.workspaceId};
}
test("Grace probe: demoted workspace stays active with its renewal checkout open, graceEndsAt <= 3 days from demotion",async()=>{
 const {w,t0,back}=await demote();
 assert.equal(back.demoted.workspaceId,wid(2));
 assert.ok(w.row(2).workspaceFeeCheckoutSessionId);
 assert.equal(w.row(2).projectStatus,"active");
 assert.ok(back.demoted.graceEndsAt<=Date.now()+policy.LAPSE_GRACE_MS&&back.demoted.graceEndsAt>=t0+policy.LAPSE_GRACE_MS-5000);
 const lapse=policy.evaluateLapse(w.row(2),back.demoted.graceEndsAt-1);
 assert.equal(lapse.lapsed,false);assert.equal(lapse.withinGrace,true);
});
test("Grace probe: an open checkout never extends grace past 3 days; the account locks (423 summary) at graceEndsAt",async()=>{
 const {w,back}=await demote();
 const rows=[w.row(1),w.row(2)].map((d,i)=>({...d,id:wid(i+1)}));
 const at=back.demoted.graceEndsAt;
 assert.equal(policy.evaluateLapse(rows[1],at).lapsed,true);
 assert.equal(policy.evaluateLapse(rows[1],at+DAY).lapsed,true);
 // Checkout re-requested late in grace must not move paidThroughMs.
 const paid=w.row(2).paidThroughMs;
 await w.svc.checkout(w.req,wid(2));
 assert.equal(w.row(2).paidThroughMs,paid);
 const realNow=Date.now;Date.now=()=>at+1;
 try{const s=policy.summarizeProjects(rows);assert.equal(s.locked,true);assert.deepEqual(s.unpaidWorkspaceIds,[wid(2)]);}finally{Date.now=realNow;}
});
test("Grace probe: checkout expiring mid-grace keeps the workspace active; a fresh checkout in grace stays active, grace unchanged",async()=>{
 let status="open";const stripe=fakeStripe({sessionStatus:()=>status});
 const {w,back}=await demote(stripe);
 const first=w.row(2).workspaceFeeCheckoutSessionId;status="expired";
 w.patch(2,{checkoutExpiresAtMs:Date.now()-1});
 assert.equal(w.row(2).projectStatus,"active");
 assert.equal(policy.evaluateLapse(w.row(2),back.demoted.graceEndsAt-1).lapsed,false);
 assert.equal(abandonedCheckout(w.row(2)),false,"an active demoted workspace must not be treated as abandoned");
 const r=await w.svc.checkout(w.req,wid(2));
 assert.notEqual(w.row(2).workspaceFeeCheckoutSessionId,first);assert.ok(r.url);
 assert.equal(w.row(2).projectStatus,"active");
 assert.equal(policy.evaluateLapse(w.row(2)).graceEndsAt,back.demoted.graceEndsAt);
});
test("Grace probe (GAP): when grace runs out the demoted workspace reports pending_payment",{todo:"nothing moves projectStatus off 'active' at graceEndsAt; projects.js:336 inGrace checks projectStatus==='active' only, so even a checkout opened after grace keeps it 'active'. The 423 lock does apply (workspace_policy.js:169)."},async()=>{
 let status="open";const stripe=fakeStripe({sessionStatus:()=>status});
 const {w,back}=await demote(stripe);
 status="expired";
 const realNow=Date.now;Date.now=()=>back.demoted.graceEndsAt+1000;
 try{
  await w.svc.checkout(w.req,wid(2));
  assert.equal(w.row(2).projectStatus,"pending_payment");
 }finally{Date.now=realNow;}
});

// ================= Merge path (Avery: must go through the outbox) =================
async function mergeWorld(cancel){
 const w=world({stripe:fakeStripe({cancel})});
 await w.make(1,"Keep ws");await w.make(2,"Source ws");
 await w.svc.reconcileWorkspaceFee(subEvt(2,"sub_src"),{eventType:"invoice.paid",invoice:periodEnd()});
 return w;
}
test("Merge probe: a Stripe 5xx on the source cancel aborts the merge with a raw error (current behaviour)",async()=>{
 const w=await mergeWorld(async()=>{throw err({statusCode:503,type:"StripeAPIError"});});
 const e=await w.svc.merge(w.req,wid(2),{targetId:wid(1),confirmName:"Source ws"}).then(()=>null,x=>x);
 assert.ok(e,"merge succeeded despite Stripe 503");
 assert.ok(w.row(2),"source still present");
 assert.equal((w.acct().pendingSubscriptionCancels||[]).some(p=>p.subscriptionId==="sub_src"),false,"documents: nothing queued");
});
test("Merge probe (GAP): merge queues the source subscription cancel in the outbox and completes despite Stripe 5xx",{todo:"projects.js:896/953-958 cancelSourceBilling calls Stripe inline with {} params (no prorate/invoice_now), outside the outbox; a 5xx or permanent error aborts the merge and a resource_missing blocks it forever. Avery: must use the outbox before #5 clears."},async()=>{
 const w=await mergeWorld(async()=>{throw err({statusCode:503,type:"StripeAPIError"});});
 const r=await w.svc.merge(w.req,wid(2),{targetId:wid(1),confirmName:"Source ws"});
 assert.equal(r.merged,true);
 assert.ok((w.acct().pendingSubscriptionCancels||[]).some(p=>p.subscriptionId==="sub_src"&&p.status==="pending"));
});
test("Merge probe (GAP): merge cancel uses the outbox params and idempotency key",{todo:"projects.js:958 sends {} and key gd-merge-<id>-cancel-<sub>, not cancelParams()/gd-sub-cancel-<sub>; a merge cancel and a later outbox cancel would not share one key"},async()=>{
 const w=await mergeWorld();
 await w.svc.merge(w.req,wid(2),{targetId:wid(1),confirmName:"Source ws"});
 const c=w.stripe.log.find(x=>x[0]==="cancel"&&x[1]==="sub_src");
 assert.deepEqual(c[2],jobs.cancelParams());assert.equal(c[3].idempotencyKey,jobs.idempotencyKey("sub_src"));
});

// ================= Zero-price invariant on every priced response =================
function pricedObjects(x,out=[]){
 if(x&&typeof x==="object"){if("monthlyPriceCents" in x)out.push(x);for(const v of Object.values(x))pricedObjects(v,out);}
 return out;
}
test("Invariant probe: monthlyPriceCents==0 exactly when isFree||grandfathered||feeWaived, on every response",async()=>{
 const w=world();const seen=[];
 await withHttp(w,async call=>{
  const keep=r=>{seen.push(...pricedObjects(r.body));return r;};
  keep(await call("POST","/v2/projects",{body:{name:"Alpha",intentId:wid(1)}}));
  keep(await call("POST","/v2/projects",{body:{name:"Bravo",intentId:wid(2)}}));
  keep(await call("POST","/v2/projects",{body:{name:"Charlie",intentId:wid(3)}}));
  w.patch(3,{projectFeeStatus:"owner"});                                       // owner benefit
  w.patch(2,{projectBillingVersion:1,projectFeeStatus:"legacy"});               // try grandfathered
  keep(await call("GET","/v2/projects"));
  for(const n of [1,2,3])keep(await call("GET","/v2/projects/"+wid(n)));
  keep(await call("POST","/v2/projects/"+wid(1)+"/archive"));
  keep(await call("GET","/v2/projects"));
 });
 assert.ok(seen.length>=8,"few priced objects: "+seen.length);
 for(const o of seen){
  assert.equal(typeof o.feeWaived,"boolean",JSON.stringify(o));
  const zero=o.isFree===true||o.grandfathered===true||o.feeWaived===true;
  if("grandfathered" in o||zero)assert.equal(o.monthlyPriceCents===0,zero,JSON.stringify(o));
  assert.ok([0,require("./catalog").WORKSPACE_FEE_CENTS].includes(o.monthlyPriceCents));
 }
});

// ================= Lows & deploy =================
test("Lows probe: no $5 / 500-cent literal outside catalog.js in server modules",()=>{
 const hits=[];
 for(const f of fs.readdirSync(__dirname).filter(x=>x.endsWith(".js")&&!x.includes(".test.")&&!["catalog.js","test_firestore.js"].includes(x)))
  fs.readFileSync(path.join(__dirname,f),"utf8").split("\n").forEach((l,i)=>{
   const code=l.replace(/\/\/.*$/,"");
   if(/\$5\b|\$5\.00|(?<![\w.])500(?![\w.])(?!\s*\*\s*1000)|unit_amount\s*[:=!]==?\s*500/.test(code)&&!/status\(500\)|statusCode|<\s*500|>=\s*500|500ms|\b500_000\b/.test(code))hits.push(f+":"+(i+1)+": "+l.trim().slice(0,90));
  });
 assert.deepEqual(hits,[]);
});
test("Deploy probe: deploy_free.py RUNTIME_FILES ships billing_jobs.js, workspace_purge.js and object_store.js",()=>{
 const py=fs.readFileSync(path.join(__dirname,"deploy_free.py"),"utf8");
 const block=py.slice(py.indexOf("RUNTIME_FILES"),py.indexOf(")",py.indexOf("RUNTIME_FILES")));
 for(const f of ["billing_jobs.js","workspace_purge.js","object_store.js","projects.js","billing_v2.js"])assert.ok(block.includes('"'+f+'"'),f);
});
