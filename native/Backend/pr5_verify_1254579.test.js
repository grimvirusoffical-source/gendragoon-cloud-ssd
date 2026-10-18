"use strict";
// QA verification of PR #5 @ 1254579/119e41b (Riley's N1-N8 fixes). Casey.
// Local only: in-memory Firestore, the real Stripe SDK and the real @google-cloud/storage SDK pointed at
// local HTTP fakes on 127.0.0.1, and (optional) the Firestore EMULATOR with a demo- project. No credentials.
// FINDING(...) tests are node:test todo: they assert the expected behaviour and fail today.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const http=require("node:http"),fs=require("node:fs"),path=require("node:path");
const express=require("express");
const Stripe=require("stripe");
const {Storage}=require("@google-cloud/storage");
const {memoryFirestore}=require("./test_firestore");
const {createProjectService,effectiveStorageQuota}=require("./projects");
const jobs=require("./billing_jobs");
const {registerBillingV2,sweepTokenMatches}=require("./billing_v2");
const {gcsObjectStore}=require("./object_store");
const {scopeFromWorkspace}=require("./paid_storage");
const {LAPSE_GRACE_MS,evaluateLapse,summarizeProjects}=require("./workspace_policy");
const {STRIPE_API_VERSION}=require("./billing_gateway");

const owner=crypto.createHash("sha256").update("casey-verify-1254579").digest("hex");
const idFor=n=>"66666666-6666-4666-8666-"+String(n).padStart(12,"0");
const env={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_WORKSPACE_MONTHLY_READY:"true",STRIPE_WORKSPACE_MONTHLY_PRICE_ID:"price_month",
 STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example"};
const price={id:"price_month",active:true,type:"recurring",recurring:{interval:"month"},currency:"usd",unit_amount:500,
 billing_scheme:"per_unit",livemode:false,product:{active:true}};
const byoBody={provider:"s3",endpoint:"https://bucket.s3.us-east-1.amazonaws.com",bucketFingerprint:"cd".repeat(8)};
const stripeErr=f=>Object.assign(new Error(f.message||f.code||"stripe"),f);
const sub=(n,status="active",id)=>({id:id||"sub_ws_"+n,status,customer:"cus_own",metadata:{kind:"workspace_fee",accountHash:owner,workspaceId:idFor(n)}});
const inv=end=>({lines:{data:[{period:{end}}]}});
const in30=()=>Math.floor(Date.now()/1000)+30*86400;
async function quiet(fn){const e=console.error;console.error=()=>{};try{return await fn();}finally{console.error=e;}}

function stripeDouble({cancel,expire,sessionStatus="open"}={}){
 const calls=[];let sessions=0;
 return {calls,prices:{retrieve:async()=>({...price})},customers:{create:async()=>({id:"cus_own"})},
  checkout:{sessions:{create:async()=>{sessions++;return {id:"cs_"+sessions,url:"https://checkout.stripe.com/c/pay/cs_"+sessions,status:"open",expires_at:Math.floor(Date.now()/1000)+86400};},
   retrieve:async id=>{calls.push(["checkout.retrieve",id]);return {id,status:typeof sessionStatus==="function"?sessionStatus(id):sessionStatus,url:"https://checkout.stripe.com/c/pay/"+id,metadata:{}};},
   expire:async id=>{calls.push(["checkout.expire",id]);if(expire)return expire(id);return {id,status:"expired"};}}},
  subscriptions:{cancel:async(id,params,opts)=>{calls.push(["subscriptions.cancel",id,params,opts]);if(cancel)return cancel(id,params,opts);return {id,status:"canceled"};}}};
}
function fixture({stripe=stripeDouble(),objectStore=null,objectStoreRequired=false}={}){
 const db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_own"}]]);
 let clock=Date.parse("2026-10-18T00:00:00Z");
 const make=(o={})=>createProjectService({db,stamp:()=>clock,hash:()=>owner,stripe,env,ensureCustomer:async()=>"cus_own",objectStore,objectStoreRequired,...o});
 const service=make(),req={user:{uid:"owner"}},p=id=>"gd_accounts/"+owner+"/workspaces/"+id;
 return {db,stripe,service,make,req,p,tick:(ms=1000)=>{clock+=ms;},
  create:(n,name,svc=service)=>svc.create(req,{name:name||"Project "+n,intentId:idFor(n)}),
  record:n=>db.rows.get(p(idFor(n))),set:(n,patch)=>db.rows.set(p(idFor(n)),{...db.rows.get(p(idFor(n))),...patch}),
  account:()=>db.rows.get("gd_accounts/"+owner),
  list:()=>[...db.rows.entries()].filter(([k])=>k.startsWith("gd_accounts/"+owner+"/workspaces/")&&k.split("/").length===4).map(([k,v])=>({id:k.split("/")[3],...v}))};
}
async function paidSecond(f){
 await f.create(1,"Free");f.tick();await f.create(2,"Paid");
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:inv(in30())});
}
// Demote workspace 2: 1 is the free one, goes BYO (2 promoted), then back to hosted (2 demoted onto $5 with grace).
async function demoted(f){
 await f.create(1,"Oldest");f.tick();await f.create(2,"Second");
 await f.service.registerByo(f.req,idFor(1),byoBody);
 return f.service.makeHosted(f.req,idFor(1));
}
function listen(handler){
 const server=http.createServer(handler);
 return new Promise(r=>server.listen(0,"127.0.0.1",()=>r({server,port:server.address().port,close:()=>new Promise(c=>{server.closeAllConnections?.();server.close(c);})})));
}
function realStripe(port,{timeout=10000}={}){
 return new Stripe("sk_test_123",{apiVersion:STRIPE_API_VERSION,host:"127.0.0.1",port,protocol:"http",maxNetworkRetries:0,timeout});
}

// ======================= N1 =======================
test("N1 wire: the real SDK sends DELETE /v1/subscriptions/:id with only prorate=true&invoice_now=true and the outbox idempotency key",async()=>{
 const seen=[];
 const s=await listen((req,res)=>{let body="";req.on("data",c=>body+=c);req.on("end",()=>{
  seen.push({method:req.method,url:req.url,body,key:req.headers["idempotency-key"]});
  res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"sub_wire",object:"subscription",status:"canceled"}));});});
 try{
  const cleared=[];
  const next=await jobs.sweepSubscriptionCancels({stripe:realStripe(s.port),now:Date.now(),onCleared:async i=>{cleared.push(i.subscriptionId);},
   pending:[{subscriptionId:"sub_wire",workspaceId:"w",attempts:0,status:"pending",nextAttemptAt:0}]});
  assert.deepEqual(next,[]);assert.deepEqual(cleared,["sub_wire"]);
 }finally{await s.close();}
 assert.equal(seen.length,1);
 assert.equal(seen[0].method,"DELETE");assert.equal(seen[0].url.split("?")[0],"/v1/subscriptions/sub_wire");
 const raw=seen[0].body||new URL("http://x"+seen[0].url).search.slice(1);
 const params=Object.fromEntries(new URLSearchParams(raw));
 assert.deepEqual(params,{invoice_now:"true",prorate:"true"});
 assert.ok(!raw.includes("proration_behavior"));
 assert.equal(seen[0].key,"gd-sub-cancel-sub_wire");
});

const ERROR_MATRIX=[
 // [label, status, error body, expected kind, expected calls, expected alerts, expected final status]
 ["resource_missing 404",404,{type:"invalid_request_error",code:"resource_missing",message:"No such subscription"},"cleared",1,0,null],
 ["400 invalid_request_error",400,{type:"invalid_request_error",code:"parameter_unknown",message:"Received unknown parameter"},"permanent",1,1,"failed"],
 ["401",401,{type:"invalid_request_error",message:"Invalid API Key provided"},"permanent",1,1,"failed"],
 ["403",403,{type:"invalid_request_error",message:"The provided key does not have access"},"permanent",1,1,"failed"],
 ["bare 404 (no code)",404,{type:"invalid_request_error",message:"Unrecognized request URL"},"permanent",1,1,"failed"],
 ["429",429,{type:"invalid_request_error",code:"rate_limit",message:"Too many requests"},"transient",5,1,"failed"],
 ["500",500,{type:"api_error",message:"boom"},"transient",5,1,"failed"],
 ["503",503,{type:"api_error",message:"unavailable"},"transient",5,1,"failed"],
];
for(const [label,status,error,_kind,calls,alerts,final] of ERROR_MATRIX){
 test("N1 classes (real SDK error objects): "+label+" -> "+calls+" call(s), "+alerts+" alert(s)",async()=>{
  let n=0;
  const s=await listen((req,res)=>{req.resume();req.on("end",()=>{n++;res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify({error}));});});
  const got=[];let cleared=0;
  try{
   let pending=[{subscriptionId:"sub_m",workspaceId:"w",attempts:0,status:"pending",nextAttemptAt:0}];
   let now=Date.now();
   for(let i=0;i<8&&pending.length&&pending[0].status==="pending";i++){
    pending=await jobs.sweepSubscriptionCancels({stripe:realStripe(s.port),pending,now,alert:(c,d)=>got.push([c,d.stripeCode]),onCleared:async()=>{cleared++;}});
    now+=120_000;
   }
   assert.equal(n,calls,"HTTP calls");
   assert.equal(got.length,alerts,"alerts "+JSON.stringify(got));
   if(alerts)assert.equal(got[0][0],"subscription_cancel_failed");
   if(final===null){assert.deepEqual(pending,[]);assert.equal(cleared,1);}else assert.equal(pending[0].status,final);
  }finally{await s.close();}
 });
}
test("N1 classes: a timeout and a refused connection are transient (5 tries, then one alert)",async()=>{
 const hang=await listen(()=>{});   // never answers
 const closed=await listen(()=>{});const deadPort=closed.port;await closed.close();
 try{
  for(const [label,stripe] of [["timeout",realStripe(hang.port,{timeout:150})],["ECONNREFUSED",realStripe(deadPort)]]){
   assert.equal(jobs.classifyStripeError(await stripe.subscriptions.cancel("sub_t",jobs.cancelParams()).then(()=>null,e=>e)),"transient",label);
   const alerts=[];let pending=[{subscriptionId:"sub_t",workspaceId:"w",attempts:0,status:"pending",nextAttemptAt:0}],now=Date.now();
   for(let i=0;i<6&&pending[0].status==="pending";i++){pending=await jobs.sweepSubscriptionCancels({stripe,pending,now,alert:c=>alerts.push(c)});now+=120_000;}
   assert.equal(pending[0].attempts,5,label);assert.equal(pending[0].status,"failed",label);assert.deepEqual(alerts,["subscription_cancel_failed"],label);
  }
 }finally{await hang.close();}
});

// ======================= N2 =======================
function app(f,{routeEnv=env,bucket=null,stripe=f.stripe}={}){
 const a=express();a.use(express.json({limit:"16kb"}));
 const auth=(req,res,next)=>{if((req.headers.authorization||"")==="Bearer owner"){req.user={uid:"owner"};return next();}res.status(401).end();};
 registerBillingV2({app:a,db:f.db,stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>Date.now()}}},auth,agreed:(_q,_s,n)=>n(),
  hash:()=>owner,prices:{},env:routeEnv,byoFetch:null,bucket});
 return a;
}
async function serve(a){
 const server=a.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
 const base="http://127.0.0.1:"+server.address().port;
 return {post:async(u,headers={})=>{const r=await fetch(base+u,{method:"POST",headers});return {status:r.status,body:await r.json().catch(()=>null)};},
  close:()=>new Promise(r=>server.close(r))};
}
test("N2: with BILLING_SWEEP_TOKEN unset or empty the sweep endpoint fails closed for every header shape",async()=>{
 const f=fixture();await paidSecond(f);
 for(const routeEnv of [env,{...env,BILLING_SWEEP_TOKEN:""},{...env,BILLING_SWEEP_TOKEN:undefined}]){
  const h=await serve(app(f,{routeEnv}));
  try{
   for(const headers of [{},{authorization:"Bearer "},{authorization:"Bearer undefined"},{authorization:"Bearer null"},{authorization:"Bearer"},{authorization:"Basic eDp5"}]){
    const r=await h.post("/internal/billing-jobs/sweep",headers);
    assert.equal(r.status,401,JSON.stringify([routeEnv.BILLING_SWEEP_TOKEN,headers]));assert.deepEqual(r.body,{error:"unauthorized"});
   }
  }finally{await h.close();}
 }
 assert.equal(sweepTokenMatches({},"Bearer "),false);
});
test("N2: the right token works, lowercase scheme / extra whitespace / prefix of the token are rejected",async()=>{
 const token="qa-sweep-"+"x".repeat(12);   // test-only placeholder, not a secret
 assert.equal(sweepTokenMatches({BILLING_SWEEP_TOKEN:token},"Bearer "+token),true);
 for(const h of ["bearer "+token,"Bearer  "+token,"Bearer "+token+" ","Bearer "+token.slice(0,-1),"Bearer "+token+"x"])
  assert.equal(sweepTokenMatches({BILLING_SWEEP_TOKEN:token},h),false,h);
});
test("FINDING N2-a (Low): a Secret Manager value with a trailing newline can never match, so the sweep 401s forever",{todo:"token is not trimmed (billing_v2.js:65)"},()=>{
 const token="qa-sweep-"+"x".repeat(12);   // test-only placeholder, not a secret
 assert.equal(sweepTokenMatches({BILLING_SWEEP_TOKEN:token+"\n"},"Bearer "+token),true);
});
test("FINDING N2-b (Medium): on Cloud Run with no BILLING_SWEEP_TOKEN nothing refuses to start, so the outbox is never drained",{todo:"no startup gate (billing_v2.js:84, free_server.js:325)"},()=>{
 const f=fixture();
 assert.throws(()=>app(f,{routeEnv:{...env,K_SERVICE:"gendragoon-free",STRIPE_SECRET_KEY:"sk_test_x"},bucket:{file(){},deleteFiles(){}}}),/BILLING_SWEEP_TOKEN/);
});
test("FINDING N2-c (Low): flagged accounts that never drain starve every other account (limit 50, no cursor, expires retried forever)",{todo:"sweepBillingJobs has no cursor; pendingCheckoutExpires has no attempt cap or alert (projects.js:171-205)"},async()=>{
 const stripe=stripeDouble({expire:async()=>{throw stripeErr({statusCode:503,type:"StripeAPIError"});}});
 const f=fixture({stripe});
 for(let i=0;i<50;i++)f.db.rows.set("gd_accounts/"+"0".repeat(62)+String(i).padStart(2,"0"),{billingJobsPending:true,pendingSubscriptionCancels:[],pendingCheckoutExpires:[{sessionId:"cs_stuck_"+i,workspaceId:idFor(1)}]});
 f.db.rows.set("gd_accounts/"+"f".repeat(64),{billingJobsPending:true,pendingCheckoutExpires:[],pendingSubscriptionCancels:[{subscriptionId:"sub_late",workspaceId:idFor(9),attempts:0,status:"pending",nextAttemptAt:0}]});
 for(let run=0;run<10;run++)await quiet(()=>f.service.sweepBillingJobs());
 assert.ok(stripe.calls.some(c=>c[0]==="subscriptions.cancel"&&c[1]==="sub_late"),"sub_late was never attempted after 10 scheduled sweeps");
});

// ======================= N3 =======================
test("N3: a cancel queued and retried during a slow sweep survives the slow sweep's write (the 0715b1a repro)",async()=>{
 let release,first=false;const gate=new Promise(r=>{release=r;});
 const stripe=stripeDouble({cancel:async id=>{
  if(id==="sub_ws_2"&&!first){first=true;await gate;return {id,status:"canceled"};}
  if(id==="sub_ws_3")throw stripeErr({statusCode:503,type:"StripeAPIError"});
  return {id,status:"canceled"};}});
 const f=fixture({stripe});
 await f.create(1,"Free");f.tick();await f.create(2,"Bravo");f.tick();await f.create(3,"Charlie");
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:inv(in30())});
 await f.service.reconcileWorkspaceFee(sub(3),{eventType:"invoice.paid",invoice:inv(in30())});
 const del2=f.service.remove(f.req,idFor(2));              // sweep 1 blocks on Stripe for sub_ws_2
 await new Promise(r=>setTimeout(r,30));
 await quiet(()=>f.service.remove(f.req,idFor(3)));         // sweep 2: 503 on sub_ws_3, stays queued with attempts=1
 const mid=f.account().pendingSubscriptionCancels.find(i=>i.subscriptionId==="sub_ws_3");
 assert.equal(mid.attempts,1);
 release();await del2;
 const after=f.account().pendingSubscriptionCancels;
 assert.deepEqual(after.map(i=>i.subscriptionId),["sub_ws_3"],"slow sweep dropped the retrying cancel");
 assert.equal(after[0].attempts,1);assert.equal(f.account().billingJobsPending,true);
});

const EMU=process.env.FIRESTORE_EMULATOR_HOST||"",EMU_PROJECT=process.env.GD_QA_EMULATOR_PROJECT||"demo-casey-pr5-verify";
const emuSkip=!/^(127\.0\.0\.1|localhost):\d+$/.test(EMU)||!EMU_PROJECT.startsWith("demo-")?"set FIRESTORE_EMULATOR_HOST (emulator only)":false;
function emuDevice(o,stripe){
 const {Firestore,FieldValue}=require("@google-cloud/firestore");
 const db=new Firestore({projectId:EMU_PROJECT,ignoreUndefinedProperties:true});
 return {db,service:createProjectService({db,stamp:()=>FieldValue.serverTimestamp(),hash:()=>o,stripe,env,ensureCustomer:async()=>"cus_own"}),req:{user:{uid:"owner"}}};
}
async function emuOwner(){
 const o=crypto.createHash("sha256").update("emu-casey-"+crypto.randomUUID()).digest("hex");
 const d=emuDevice(o,stripeDouble());await d.db.collection("gd_accounts").doc(o).set({stripeCustomerId:"cus_own"});return o;
}
test("N3 emulator: two clients; a cancel queued by another client while the first sweep waits on Stripe is kept (real transactions)",{skip:emuSkip},async()=>{
 const o=await emuOwner();
 let release;const gate=new Promise(r=>{release=r;});
 const slow=emuDevice(o,stripeDouble({cancel:async id=>{if(id.endsWith("_2")){await gate;}return {id,status:"canceled"};}}));
 // The other device gets 503 for everything, so sub_emu_2 (also visible to it) stays pending there and sub_emu_3 is retried.
 const other=emuDevice(o,stripeDouble({cancel:async id=>{throw stripeErr({statusCode:503,type:"StripeAPIError"});}}));
 const W=n=>crypto.createHash("md5").update(o+n).digest("hex").replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/,"$1-$2-4$3-8$4-$5");
 const subOf=(n)=>({id:"sub_emu_"+n,status:"active",customer:"cus_own",metadata:{kind:"workspace_fee",accountHash:o,workspaceId:W(n)}});
 await slow.service.create(slow.req,{name:"Free",intentId:W(1)});
 await slow.service.create(slow.req,{name:"Bravo",intentId:W(2)});
 await slow.service.create(slow.req,{name:"Charlie",intentId:W(3)});
 await slow.service.reconcileWorkspaceFee(subOf(2),{eventType:"invoice.paid",invoice:inv(in30())});
 await slow.service.reconcileWorkspaceFee(subOf(3),{eventType:"invoice.paid",invoice:inv(in30())});
 const del2=slow.service.remove(slow.req,W(2));
 await new Promise(r=>setTimeout(r,400));
 await quiet(()=>other.service.remove(other.req,W(3)).catch(()=>{}));
 release();await del2;
 const acct=(await other.db.collection("gd_accounts").doc(o).get()).data();
 assert.deepEqual((acct.pendingSubscriptionCancels||[]).map(i=>i.subscriptionId),["sub_emu_3"]);
 assert.equal(acct.billingJobsPending,true);
});
test("FINDING N3-a (Medium): the deleted-workspace webhook path still does read-then-set outside a transaction and drops a cancel queued meanwhile",{skip:emuSkip,todo:"projects.js:743-747 queues with a stale account read"},async()=>{
 const {DocumentReference}=require("@google-cloud/firestore");
 const o=await emuOwner();
 const svc=emuDevice(o,stripeDouble({cancel:async id=>{if(id==="sub_emu_2")throw stripeErr({statusCode:503,type:"StripeAPIError"});return {id,status:"canceled"};}}));
 const W=n=>crypto.createHash("md5").update(o+n).digest("hex").replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/,"$1-$2-4$3-8$4-$5");
 await svc.service.create(svc.req,{name:"Free",intentId:W(1)});await svc.service.create(svc.req,{name:"Bravo",intentId:W(2)});
 await svc.service.reconcileWorkspaceFee({id:"sub_emu_2",status:"active",customer:"cus_own",metadata:{kind:"workspace_fee",accountHash:o,workspaceId:W(2)}},{eventType:"invoice.paid",invoice:inv(in30())});
 // A late event for a workspace that no longer exists (W(9)) reads the account, then, before its set lands, the user deletes W(2).
 const orig=DocumentReference.prototype.set;let armed=true;
 DocumentReference.prototype.set=async function(value,opts){
  if(armed&&this.path==="gd_accounts/"+o&&value&&Object.hasOwn(value,"pendingSubscriptionCancels")&&!Object.hasOwn(value,"pendingCheckoutExpires")){
   armed=false;await quiet(()=>svc.service.remove(svc.req,W(2)));
  }
  return orig.call(this,value,opts);
 };
 try{
  await svc.service.reconcileWorkspaceFee({id:"sub_emu_9",status:"active",customer:"cus_own",metadata:{kind:"workspace_fee",accountHash:o,workspaceId:W(9)}},{eventType:"customer.subscription.updated"});
 }finally{DocumentReference.prototype.set=orig;}
 assert.equal(armed,false,"interleaving did not happen");
 const acct=(await svc.db.collection("gd_accounts").doc(o).get()).data();
 assert.ok((acct.pendingSubscriptionCancels||[]).some(i=>i.subscriptionId==="sub_emu_2"),"sub_emu_2 (deleted workspace W2) lost from the outbox: "+JSON.stringify(acct.pendingSubscriptionCancels));
});

// ======================= N4 / N6 (real GCS SDK) =======================
async function fakeGcs(objects,{failList=0,failStatus=403,deleteMissingOnce=null}={}){
 const log=[];let lists=0;
 const s=await listen((req,res)=>{
  const u=new URL(req.url,"http://x");log.push(req.method+" "+decodeURIComponent(u.pathname)+" prefix="+(u.searchParams.get("prefix")??""));let m;
  if(req.method==="GET"&&(m=/^\/storage\/v1\/b\/([^/]+)\/o$/.exec(u.pathname))){
   lists++;if(lists<=failList){res.writeHead(failStatus,{"content-type":"application/json"});return res.end(JSON.stringify({error:{code:failStatus,message:"denied"}}));}
   const pfx=u.searchParams.get("prefix")||"";
   const items=[...objects.keys()].filter(k=>k.startsWith(pfx)).map(name=>({kind:"storage#object",name,bucket:m[1],size:"1",generation:"1"}));
   res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({kind:"storage#objects",items}));
  }
  if(req.method==="DELETE"&&(m=/^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/.exec(u.pathname))){
   const k=decodeURIComponent(m[2]);
   if(deleteMissingOnce===k){deleteMissingOnce=null;objects.delete(k);}  // deleted by someone else between list and delete
   if(!objects.has(k)){res.writeHead(404,{"content-type":"application/json"});return res.end(JSON.stringify({error:{code:404,message:"No such object: "+k}}));}
   objects.delete(k);res.writeHead(204);return res.end();
  }
  res.writeHead(501);res.end("{}");
 });
 return {...s,log,bucket:new Storage({apiEndpoint:"http://127.0.0.1:"+s.port,projectId:"demo-casey"}).bucket("demo-bucket")};
}
test("N4: deletePrefix through the real GCS SDK removes ws1/ only; ws10/, ws1-x/, other owners and the account root are untouched",async()=>{
 const other=crypto.createHash("sha256").update("someone-else").digest("hex");
 const P=(o,w)=>"customer/"+o+"/managed/"+w+"/";
 const objects=new Map([[P(owner,"ws1")+"files/a",1],[P(owner,"ws1")+"tmp-v3/u/0",1],[P(owner,"ws10")+"files/b",1],[P(owner,"ws1-x")+"files/c",1],
  [P(other,"ws1")+"files/d",1],["customer/"+owner+"/free/files/e",1],["customer/"+owner+"/managed/ws1",1]]);
 const g=await fakeGcs(objects);
 try{
  const store=gcsObjectStore(g.bucket);
  await store.deletePrefix(P(owner,"ws1"));
  for(const bad of ["customer/"+owner+"/managed/ws1","customer/"+owner+"/managed/","customer/"+owner+"/managed/ws1/files/","customer/"+owner+"/managed/ws*/","customer/"+owner.toUpperCase()+"/managed/ws1/"])
   await assert.rejects(()=>store.deletePrefix(bad),e=>e.code==="object_store_prefix_rejected",bad);
 }finally{await g.close();}
 assert.deepEqual([...objects.keys()].sort(),[P(owner,"ws10")+"files/b",P(owner,"ws1-x")+"files/c",P(other,"ws1")+"files/d","customer/"+owner+"/free/files/e","customer/"+owner+"/managed/ws1"].sort());
 assert.ok(g.log.every(l=>!l.startsWith("GET")||l.endsWith("prefix="+P(owner,"ws1"))),g.log.join("\n"));
});
test("N4: delete with the real GCS SDK store (gcsObjectStore) purges the workspace prefix only, fails closed on a GCS error (403; the SDK itself retries 5xx), and the retry finishes",async()=>{
 const f=fixture();
 await f.create(1,"Free");f.tick();await f.create(2,"Doomed");f.tick();await f.create(3,"Keeper");
 const P=n=>"customer/"+owner+"/managed/"+idFor(n)+"/";
 const objects=new Map([[P(2)+"files/f1",1],[P(2)+"tmp-v3/u/0",1],[P(3)+"files/k",1]]);
 const g=await fakeGcs(objects,{failList:1});
 const svc=createProjectService({db:f.db,stamp:()=>Date.now(),hash:()=>owner,stripe:f.stripe,env,ensureCustomer:async()=>"cus_own",objectStore:gcsObjectStore(g.bucket),objectStoreRequired:true});
 try{
  await quiet(()=>assert.rejects(()=>svc.remove(f.req,idFor(2)),e=>e.code==="WORKSPACE_PURGE_PENDING"));
  assert.equal(f.record(2).projectStatus,"deleting");assert.equal(objects.size,3);
  const marker=f.db.rows.get("gd_accounts/"+owner+"/workspace_purges/"+idFor(2));assert.equal(marker.steps.objects,"error");
  const r=await svc.remove(f.req,idFor(2));
  assert.equal(r.deleted,true);
 }finally{await g.close();}
 assert.deepEqual([...objects.keys()],[P(3)+"files/k"]);assert.equal(f.record(2),undefined);
});
test("N6: an object deleted by someone else between list and delete (GCS 404) only delays the purge; the retry completes",async()=>{
 const f=fixture();
 await f.create(1,"Free");f.tick();await f.create(2,"Doomed");
 const P="customer/"+owner+"/managed/"+idFor(2)+"/";
 const objects=new Map([[P+"files/a",1],[P+"files/b",1]]);
 const g=await fakeGcs(objects,{deleteMissingOnce:P+"files/a"});
 const svc=createProjectService({db:f.db,stamp:()=>Date.now(),hash:()=>owner,stripe:f.stripe,env,ensureCustomer:async()=>"cus_own",objectStore:gcsObjectStore(g.bucket),objectStoreRequired:true});
 try{
  let first=null;try{first=await quiet(()=>svc.remove(f.req,idFor(2)));}catch(e){first=e;}
  const r=first&&first.deleted?first:await svc.remove(f.req,idFor(2));
  assert.equal(r.deleted,true);
 }finally{await g.close();}
 assert.equal(objects.size,0);
});
test("FINDING N4-a (Low): the per-record delete loop has no prefix guard, so a file record pointing outside its workspace deletes that object",{todo:"workspace_purge.js:110-112 deletes objectKey values without assertWorkspacePrefix"},async()=>{
 const deleted=[];
 const store={deletePrefix:async()=>{},delete:async k=>{deleted.push(k);}};
 const f=fixture({objectStore:store});
 await f.create(1,"Free");f.tick();await f.create(2,"Doomed");
 f.db.rows.set(f.p(idFor(2))+"/files/x",{name:"x",sizeBytes:1,objectKey:"customer/"+owner+"/managed/"+idFor(1)+"/files/shared"});
 await quiet(()=>f.service.remove(f.req,idFor(2)).catch(()=>{}));
 assert.deepEqual(deleted.filter(k=>!k.startsWith("customer/"+owner+"/managed/"+idFor(2)+"/")),[]);
});

// ======================= N5 =======================
test("N5: expired Checkout never blocks; open first Checkout, failed lookup (500) and bare 404 all block (fail closed)",async()=>{
 for(const [label,retrieve,expect] of [
  ["expired",async id=>({id,status:"expired"}),null],
  ["resource_missing",async()=>{throw stripeErr({code:"resource_missing",statusCode:404});},null],
  ["open",async id=>({id,status:"open"}),"checkout_open"],
  ["500",async()=>{throw stripeErr({statusCode:500,type:"StripeAPIError"});},"checkout_open"],
  ["timeout",async()=>{throw stripeErr({type:"StripeConnectionError",message:"Request timed out"});},"checkout_open"],
  ["bare 404",async()=>{throw stripeErr({statusCode:404});},"checkout_open"],
  ["401",async()=>{throw stripeErr({statusCode:401,type:"StripeAuthenticationError"});},"checkout_open"]]){
  const stripe=stripeDouble();stripe.checkout.sessions.retrieve=retrieve;
  const f=fixture({stripe});
  await f.create(1,"Free");f.tick();await f.create(2,"Paying");
  assert.equal(f.record(2).projectStatus,"pending_payment",label);
  f.set(2,{workspaceFeeCheckoutSessionId:"cs_first",checkoutExpiresAtMs:Date.now()+3600_000});    // stored expiry says "still open": Stripe's answer must win
  if(expect===null){const r=await f.service.remove(f.req,idFor(2));assert.equal(r.deleted,true,label);}
  else await assert.rejects(()=>f.service.remove(f.req,idFor(2)),e=>e.code==="workspace_busy"&&e.reason===expect,label);
 }
});
test("N5: an expired first Checkout does not count toward the cap (10 slots) and paying for it later re-checks the cap",async()=>{
 const f=fixture();
 await f.create(1,"Free");for(let n=2;n<=10;n++){f.tick();await f.create(n,"Project "+n);}
 await assert.rejects(()=>f.create(11,"Project 11"),e=>e.code==="PROJECT_LIMIT_REACHED");
 f.set(10,{workspaceFeeCheckoutSessionId:"cs_10",checkoutExpiresAtMs:Date.now()+3600_000});
 assert.equal(summarizeProjects(f.list()).used,10,"an open first Checkout still holds its slot");
 f.set(10,{checkoutExpiresAtMs:Date.now()-1});
 await f.create(11,"Project 11");
 assert.equal(summarizeProjects(f.list()).used,10);
 f.stripe.checkout.sessions.retrieve=async id=>({id,status:"expired"});
 await assert.rejects(()=>f.service.checkout(f.req,idFor(10)),e=>e.code==="PROJECT_LIMIT_REACHED");
});
test("FINDING N5-a (Low): a workspace whose first Checkout was opened before this deploy (no checkoutExpiresAtMs) keeps counting toward the cap after it expired",{todo:"abandonedCheckout needs a stored expiry (workspace_purge.js:20-24)"},async()=>{
 const f=fixture();
 await f.create(1,"Free");f.tick();await f.create(2,"Legacy pending");
 const w=f.record(2);w.workspaceFeeCheckoutSessionId="cs_legacy";delete w.checkoutExpiresAtMs;f.db.rows.set(f.p(idFor(2)),{...w,updatedAt:Date.now()-40*86400_000});
 assert.equal(summarizeProjects(f.list()).used,1);
});
test("FINDING N5-b (High): deleting a workspace in grace while its renewal Checkout completes leaves a live $5 subscription on a deleted workspace",{todo:"remove() resume path and reconcileWorkspaceFee bind a subscription to a 'deleting' workspace and never queue its cancel (projects.js:520-524, 750-787)"},async()=>{
 // Checkout completes just as the delete runs: Stripe refuses to expire a complete session (400).
 const stripe=stripeDouble({expire:async()=>{throw stripeErr({statusCode:400,type:"StripeInvalidRequestError",rawType:"invalid_request_error",message:"Only Checkout Sessions with a status in [\"open\"] can be expired"});}});
 const f=fixture({stripe,objectStoreRequired:true});           // first purge attempt fails closed (no store yet)
 await demoted(f);
 assert.equal(f.record(2).projectStatus,"active");
 await quiet(()=>assert.rejects(()=>f.service.remove(f.req,idFor(2)),e=>e.code==="WORKSPACE_PURGE_PENDING"));
 assert.equal(f.record(2).projectStatus,"deleting");
 // The completed Checkout's subscription webhooks arrive while the workspace is still 'deleting'.
 await f.service.reconcileWorkspaceFee(sub(2,"active","sub_renewal"),{eventType:"invoice.paid",invoice:inv(in30())});
 const fixed=createProjectService({db:f.db,stamp:()=>Date.now(),hash:()=>owner,stripe,env,ensureCustomer:async()=>"cus_own",objectStore:{deletePrefix:async()=>{},delete:async()=>{}},objectStoreRequired:true});
 const r=await fixed.remove(f.req,idFor(2));assert.equal(r.deleted,true);
 const cancelled=stripe.calls.some(c=>c[0]==="subscriptions.cancel"&&c[1]==="sub_renewal");
 const queued=(f.account().pendingSubscriptionCancels||[]).some(i=>i.subscriptionId==="sub_renewal");
 assert.ok(cancelled||queued,"sub_renewal is neither cancelled nor queued; the workspace record is gone");
});

// ======================= N7 =======================
test("N7: every event type for a retired subscription id is ignored, including a newer 'active' one",async()=>{
 const f=fixture();await paidSecond(f);
 await f.service.registerByo(f.req,idFor(1),byoBody);   // 2 promoted, sub_ws_2 cancelled + retired
 await f.service.makeHosted(f.req,idFor(1));            // 2 demoted
 assert.ok(f.record(2).retiredSubscriptionIds.includes("sub_ws_2"));
 await f.service.reconcileWorkspaceFee(sub(2,"active","sub_new"),{eventType:"invoice.paid",invoice:inv(in30())});
 const before=JSON.stringify(f.record(2));
 for(const [status,eventType] of [["active","customer.subscription.updated"],["canceled","customer.subscription.deleted"],["past_due","invoice.payment_failed"],["active","invoice.paid"]])
  await f.service.reconcileWorkspaceFee(sub(2,status,"sub_ws_2"),{eventType,invoice:inv(in30()+86400*60)});
 const after=f.record(2);
 assert.equal(after.workspaceFeeSubscriptionId,"sub_new");assert.equal(after.workspaceFeeStatus,"active");
 assert.equal(JSON.stringify({...after,updatedAt:0}),JSON.stringify({...JSON.parse(before),updatedAt:0}));
});

// ======================= N8 =======================
test("N8: an open renewal Checkout cannot extend access past 3 days in total; at +3 days it locks with the Checkout still open",async()=>{
 const f=fixture();
 const t0=Date.now();
 const back=await demoted(f);
 const w=f.record(2);
 assert.ok(back.demoted.graceEndsAt-t0<=LAPSE_GRACE_MS+5_000&&back.demoted.graceEndsAt-t0>=LAPSE_GRACE_MS-5_000);
 assert.equal(w.paidThroughMs,back.demoted.paidThroughMs);
 // Re-open Checkout late in grace (the first one expired): no clock moves.
 f.stripe.checkout.sessions.retrieve=async id=>({id,status:"expired"});
 const realNow=Date.now;
 try{
  Date.now=()=>t0+LAPSE_GRACE_MS-3600_000;
  const c=await f.service.checkout(f.req,idFor(2));assert.ok(c.url);
  const w2=f.record(2);
  assert.equal(w2.paidThroughMs,w.paidThroughMs,"Checkout must not move paidThroughMs");
  assert.equal(w2.projectStatus,"active");assert.equal(w2.workspaceFeeStatus,"unpaid");
  f.stripe.checkout.sessions.retrieve=async id=>({id,status:"open"});
  Date.now=()=>back.demoted.graceEndsAt;               // exactly 3 days, Checkout still open
  assert.equal(evaluateLapse(w2).lapsed,true);
  const summary=summarizeProjects(f.list());
  assert.ok((summary.selfLockedWorkspaceIds||[]).includes(idFor(2))||summary.locked,"not locked at +3d: "+JSON.stringify(summary));
  const inventory=await f.service.inventory(f.req);
  assert.ok(JSON.stringify(inventory).length>0);
  // Paying afterwards unlocks.
  Date.now=()=>back.demoted.graceEndsAt+3600_000;
  await f.service.reconcileWorkspaceFee(sub(2,"active","sub_paid"),{eventType:"invoice.paid",invoice:inv(Math.floor(Date.now()/1000)+30*86400)});
  assert.equal(evaluateLapse(f.record(2)).lapsed,false);
 }finally{Date.now=realNow;}
});
test("FINDING N8-a (High): the demoted workspace has 0 storage quota during its 'grace', so every file read and upload fails at once",{todo:"effectiveStorageQuota returns 0 because projectFeeStatus is 'pending' (projects.js:35, demotion at projects.js:633-635)"},async()=>{
 const f=fixture();
 await demoted(f);
 const w=f.record(2);
 assert.equal(w.projectStatus,"active");assert.equal(evaluateLapse(w).withinGrace,true);
 assert.ok(effectiveStorageQuota(w)>0,"quota is "+effectiveStorageQuota(w));
 assert.ok(scopeFromWorkspace(w,owner,idFor(2),f.list()),"transfer_v3 answers 403 Active provisioned storage required");
});

// ======================= Merge path (still open; Riley's outbox fix pending) =======================
async function mergeFixture(cancel){
 const stripe=stripeDouble({cancel});
 const store={objects:new Map(),async copy(a,b){this.objects.set(b,this.objects.get(a));return {size:1};},async stat(){return {size:1};},async delete(k){this.objects.delete(k);},async read(k){return Buffer.from(String(this.objects.get(k)));},async deletePrefix(){}};
 const f=fixture({stripe,objectStore:store});
 await f.create(1,"Free target");f.tick();await f.create(2,"Paid source");
 await f.service.reconcileWorkspaceFee(sub(2),{eventType:"invoice.paid",invoice:inv(in30())});
 return {f,stripe,store};
}
test("FINDING M-1 (Medium): the merge cancel sends no prorate/invoice_now, unlike the outbox cancel, so the unused month is never credited",{todo:"projects.js:958 passes {}"},async()=>{
 const {f,stripe}=await mergeFixture();
 await f.service.merge(f.req,idFor(2),{targetId:idFor(1),confirmName:"Paid source"});
 const c=stripe.calls.find(x=>x[0]==="subscriptions.cancel"&&x[1]==="sub_ws_2");
 assert.deepEqual(c[2],jobs.cancelParams());
});
test("FINDING M-2 (High): a source subscription the user already cancelled in Stripe (resource_missing) makes the merge fail on every retry",{todo:"merge throws the raw Stripe error before the source is removed (projects.js:896, 953-959)"},async()=>{
 const {f}=await mergeFixture(async()=>{throw stripeErr({code:"resource_missing",statusCode:404,type:"StripeInvalidRequestError"});});
 for(let i=0;i<3;i++)await f.service.merge(f.req,idFor(2),{targetId:idFor(1),confirmName:"Paid source"}).catch(()=>{});
 assert.equal(f.record(2),undefined,"source workspace still exists after 3 merge attempts");
});
test("FINDING M-3 (High): a Stripe 503 on the merge cancel is not queued, retried or alerted; the merge just fails",{todo:"no outbox entry, no billingAlerts (projects.js:953-959)"},async()=>{
 const {f}=await mergeFixture(async()=>{throw stripeErr({statusCode:503,type:"StripeAPIError"});});
 let err=null;try{await f.service.merge(f.req,idFor(2),{targetId:idFor(1),confirmName:"Paid source"});}catch(e){err=e;}
 assert.ok(err);
 const queued=(f.account().pendingSubscriptionCancels||[]).some(i=>i.subscriptionId==="sub_ws_2");
 const alerted=(f.account().billingAlerts||[]).length>0;
 assert.ok(queued||alerted,"Stripe failure left no outbox entry and no alert");
});
test("FINDING M-4 (High): when the merge cancels the subscription and then its final step fails, the surviving source workspace has no subscription and locks 3 days after its paid period",{todo:"cancel happens before the commit, outside the outbox (projects.js:896 vs 912-937)"},async()=>{
 let f;
 const ctx=await mergeFixture(async id=>{
  // Stripe succeeds; then the merge lock is lost before the final transaction (e.g. lock expired and another request took it).
  const row=f.record(2);f.set(2,{mergeLock:{...row.mergeLock,token:"someone-else"}});return {id,status:"canceled"};});
 f=ctx.f;
 await assert.rejects(()=>f.service.merge(f.req,idFor(2),{targetId:idFor(1),confirmName:"Paid source"}),e=>e.code==="MERGE_LOCK_LOST");
 assert.ok(f.record(2),"source survived");
 await f.service.reconcileWorkspaceFee(sub(2,"canceled"),{eventType:"customer.subscription.deleted"});
 const w=f.record(2);
 assert.equal(ctx.stripe.calls.filter(c=>c[0]==="subscriptions.cancel").length,0,"Stripe cancel ran although the merge did not commit");
 assert.equal(evaluateLapse(w,w.paidThroughMs+LAPSE_GRACE_MS+1).lapsed,false,"surviving source locks 3 days after its paid period: status "+w.workspaceFeeStatus);
});
test("FINDING M-5 (High, pre-existing): merging real uploads (transfer_v3 records have no objectKey) copies no objects, so merged files are unreadable",{todo:"merge only copies when file.data.objectKey is set (projects.js:861-874); transfer_v3 reads <prefix>/files/<fileId> (transfer_v3.js:302)"},async()=>{
 const {f,store}=await mergeFixture();
 const src="customer/"+owner+"/managed/"+idFor(2)+"/files/";
 const fileId="77777777-7777-4777-8777-000000000001";
 store.objects.set(src+fileId,"payload");
 // Exactly what transfer_v3.js:255 writes on upload completion: no objectKey.
 f.db.rows.set(f.p(idFor(2))+"/files/"+fileId,{name:"photo.jpg",sizeBytes:7,kind:"file",generation:"1",crc32c:"AAAAAA==",createdAt:Date.now()});
 await f.service.merge(f.req,idFor(2),{targetId:idFor(1),confirmName:"Paid source"});
 const dest=[...f.db.rows.keys()].filter(k=>k.startsWith(f.p(idFor(1))+"/files/")).map(k=>k.split("/").at(-1));
 assert.equal(dest.length,1);
 const readable="customer/"+owner+"/managed/"+idFor(1)+"/files/"+dest[0];
 assert.ok(store.objects.has(readable),"target object "+readable+" missing; objects: "+[...store.objects.keys()].join(", "));
});
