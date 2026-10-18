"use strict";
// Regression tests for Avery's PR #5 review, blockers 2-8 (plus BYO SFTP refusal).
// Written against e9ef0e3 (fix/backend-workspace-policy): every test in this file is
// EXPECTED TO FAIL on e9ef0e3 for the reason in its name, and pass once that blocker is fixed.
// No credentials, network, Stripe or Firebase: in-memory Firestore, stub Stripe, stub object store.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),express=require("express");
const Stripe=require("stripe");
const {memoryFirestore}=require("./test_firestore");
const {createProjectService}=require("./projects");
const {installedBilling,STRIPE_API_VERSION}=require("./billing_gateway");
const {registerBillingV2,byoQuote,effectiveWorkers}=require("./billing_v2");
const {evaluateLapse,LAPSE_GRACE_MS,fileDigest}=require("./workspace_policy");

const owner=crypto.createHash("sha256").update("pr5-review-owner").digest("hex");
const idFor=n=>"12345678-1234-4000-8000-"+String(n).padStart(12,"0");
const DAY=24*60*60*1000;
const sha=buf=>crypto.createHash("sha256").update(buf).digest("hex");
const md5=buf=>crypto.createHash("md5").update(buf).digest("base64");
const base={kind:"paid",accountHash:owner,name:"Existing",projectBillingVersion:2,projectStatus:"active",projectFeeStatus:"paid",
  provisioned:true,storageActive:false,performanceActive:false,usedBytes:0,reservedBytes:0};
const WEBHOOK_SECRET="whsec_disposableFixtureOnly123";
const verifier=new Stripe("sk_test_dummyABC123",{apiVersion:STRIPE_API_VERSION});

function fixture({db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_test"}]]),stripe,objectStore=null,options={}}={}){
  stripe=stripe||{prices:{retrieve:async()=>{throw Error("no Stripe in review tests");}},checkout:{sessions:{}},subscriptions:{}};
  const service=createProjectService({db,stamp:()=>1,hash:()=>owner,stripe,env:{},ensureCustomer:async()=>"cus_test",objectStore,...options});
  const path=id=>"gd_accounts/"+owner+"/workspaces/"+id;
  const put=(id,v={})=>db.rows.set(path(id),{...base,name:"P"+id.slice(-2),...v});
  const file=(id,rowId,data)=>db.rows.set(path(id)+"/files/"+rowId,data);
  return {db,service,req:{user:{uid:"owner"}},put,file,path,record:id=>db.rows.get(path(id))};
}
// Real billing_gateway webhook route with signed Stripe test events; subscriptions.retrieve returns `sub`.
async function webhookHarness(t,f,sub){
  const stripe={webhooks:verifier.webhooks,subscriptions:{retrieve:async id=>{if(id!==sub.id)throw Error("missing subscription");return structuredClone(sub);}},
    customers:{create:async()=>({id:"cus_test"})},checkout:{sessions:{create:async()=>{throw Error("no checkout");},retrieve:async()=>{throw Error("no session");},listLineItems:async()=>({data:[]})}},
    paymentIntents:{retrieve:async()=>{throw Error("no intent");}},charges:{retrieve:async()=>{throw Error("no charge");}}};
  const app=express();
  installedBilling({app,db:f.db,bucket:{file:()=>({save:async()=>{}})},stripeOverride:stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>1}}},
    firebaseAuth:(_req,_res,next)=>next(),accountKey:()=>owner,env:{STRIPE_SECRET_KEY:"sk_test_dummyABC123",STRIPE_WEBHOOK_SECRET:WEBHOOK_SECRET,
      STRIPE_CHECKOUT_ENABLED:"true",STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example",STRIPE_PRICE_CATALOG_JSON:"{}"}});
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return async(type,object,eventId,created)=>{
    const payload=JSON.stringify({id:eventId,type,created,data:{object}});
    const signature=verifier.webhooks.generateTestHeaderString({payload,secret:WEBHOOK_SECRET});
    const response=await fetch("http://127.0.0.1:"+server.address().port+"/billing/stripe-webhook",{method:"POST",headers:{"Content-Type":"application/json","Stripe-Signature":signature},body:payload});
    assert.equal(response.status,200,"webhook "+type+" "+eventId+" -> "+response.status);
    return response.json();
  };
}
// registerBillingV2 routes (BYO register / checkout) with stub auth.
async function billingRoutes(t,f,{ownerBenefits=false}={}){
  const app=express();app.use(express.json());
  const stripe=new Proxy({},{get(){throw Error("Stripe must not be called in BYO route tests");}});
  registerBillingV2({app,db:f.db,stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>1}}},
    auth:(req,_res,next)=>{req.user={uid:"owner"};req.ownerBenefits=ownerBenefits;next();},agreed:(_req,_res,next)=>next(),hash:()=>owner,prices:{},env:{}});
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return async(path,body)=>{const r=await fetch("http://127.0.0.1:"+server.address().port+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})});
    return {status:r.status,body:await r.json().catch(()=>({}))};};
}
const monthly={workspaceFeeModel:"monthly",workspaceFeeStatus:"pending",projectFeeStatus:"pending",projectStatus:"active",provisioned:true};

// ---- 2. Lapse grace is anchored to what was actually paid, not Stripe's advanced period ----
test("2 lapse: failed renewal lapses at paidThroughMs (paid invoice period end) + 3 days, not advanced current_period_end + 3 days (~33 days)",async t=>{
  const f=fixture();const id=idFor(2);f.put(id,monthly);
  const P1=1_700_000_000,P2=P1+30*24*60*60;            // P1 = end of paid period; Stripe advances to P2 on renewal attempt
  const sub={id:"sub_ws2",customer:"cus_test",status:"active",current_period_end:P1,metadata:{kind:"workspace_fee",accountHash:owner,workspaceId:id}};
  const hook=await webhookHarness(t,f,sub);
  await hook("invoice.paid",{id:"in_paid",subscription:sub.id,status:"paid",period_end:P1,lines:{data:[{period:{start:P1-30*86400,end:P1}}]}},"evt_paid2",P1-30*86400);
  sub.status="past_due";sub.current_period_end=P2;   // renewal failed: Stripe already moved the period forward
  await hook("invoice.payment_failed",{id:"in_failed",subscription:sub.id,status:"open",period_end:P1,lines:{data:[{period:{start:P1,end:P2}}]}},"evt_failed2",P1+60);
  const w=f.record(id);
  assert.equal(evaluateLapse(w,P1*1000+LAPSE_GRACE_MS).lapsed,true,"must be lapsed at paidThrough+3d, not at advanced period_end+3d (~33 days)");
  assert.equal(evaluateLapse(w,P1*1000+LAPSE_GRACE_MS-1).lapsed,false,"still in grace 1 ms before paidThrough+3d");
  assert.equal(w.paidThroughMs,P1*1000,"paidThroughMs must come from the paid invoice period end");
});

// ---- 3. Out-of-order webhooks ----
test("3 webhooks: a late invoice.payment_failed (older event) must not override the latest active subscription status",async t=>{
  const f=fixture();const id=idFor(3);f.put(id,monthly);
  const sub={id:"sub_ws3",customer:"cus_test",status:"active",current_period_end:1_700_000_000,metadata:{kind:"workspace_fee",accountHash:owner,workspaceId:id}};
  const hook=await webhookHarness(t,f,sub);
  await hook("invoice.paid",{id:"in_retry_paid",subscription:sub.id,status:"paid"},"evt_paid3",2000);
  await hook("invoice.payment_failed",{id:"in_first_try",subscription:sub.id,status:"open"},"evt_failed3late",1000); // created earlier, delivered later
  assert.equal(f.record(id).workspaceFeeStatus,"active","late payment_failed overrode the latest (active) subscription status");
  assert.equal(f.record(id).workspaceFeePaid,true);
});
test("3 webhooks: a late invoice.paid (older event) must not mark a now past_due subscription as paid",async t=>{
  const f=fixture();const id=idFor(4);f.put(id,monthly);
  const sub={id:"sub_ws4",customer:"cus_test",status:"past_due",current_period_end:1_700_000_000,metadata:{kind:"workspace_fee",accountHash:owner,workspaceId:id}};
  const hook=await webhookHarness(t,f,sub);
  await hook("invoice.payment_failed",{id:"in_renewal",subscription:sub.id,status:"open"},"evt_failed4",2000);
  await hook("invoice.paid",{id:"in_previous_month",subscription:sub.id,status:"paid"},"evt_paid4late",1000);
  assert.equal(f.record(id).workspaceFeeStatus,"past_due","late invoice.paid overrode the latest (past_due) subscription status");
  assert.equal(f.record(id).workspaceFeePaid,false);
});

// ---- 4. BYO challenge: server-side read-back of the challenge object ----
const byoBase={kind:"byo",accountHash:owner,name:"BYO",projectBillingVersion:2,projectStatus:undefined,provisioned:true};
test("4 byo challenge: echoing the nonce alone must not verify the workspace",async()=>{
  const f=fixture();const id=idFor(5);f.put(id,byoBase);
  await f.service.registerByo(f.req,id,{provider:"s3",endpoint:"https://bucket.s3.us-east-1.amazonaws.com",bucketFingerprint:"ab".repeat(8)});
  const {nonce}=await f.service.issueByoChallenge(f.req,id);
  await assert.rejects(f.service.verifyByo(f.req,id,{readBack:nonce}),undefined,"nonce echo was accepted as proof of bucket control");
  assert.notEqual(f.record(id).byoChallengeVerified,true);
});
test("4 byo challenge: server fetches .gendragoon-challenge/<nonce> via the presigned GET, checks host == registered endpoint, derives fingerprint",async()=>{
  const fetched=[];const derived="cd".repeat(16);
  // Proposed injection point for the server-side fetch (name is part of the requested contract).
  const byoFetch=async url=>{fetched.push(url);const u=new URL(url);
    return {status:200,body:Buffer.from(u.pathname.split("/").pop()),headers:{etag:'"'+derived+'"'},host:u.host,fingerprint:derived};};
  const f=fixture({options:{byoFetch}});const id=idFor(6);f.put(id,byoBase);
  await f.service.registerByo(f.req,id,{provider:"s3",endpoint:"https://bucket.s3.us-east-1.amazonaws.com",bucketFingerprint:"ab".repeat(8)});
  const {nonce}=await f.service.issueByoChallenge(f.req,id);
  const good="https://bucket.s3.us-east-1.amazonaws.com/.gendragoon-challenge/"+nonce+"?X-Amz-Signature=x";
  const result=await f.service.verifyByo(f.req,id,{presignedUrl:good})
    .catch(error=>assert.fail("server did not fetch the challenge object via the presigned GET (rejected "+error.code+"); fetch calls: "+fetched.length));
  assert.equal(result.verified,true);
  assert.deepEqual(fetched,[good],"server must GET the challenge object itself");
  assert.equal(f.record(id).byoChallengeVerified,true);
  assert.equal(f.record(id).bucketFingerprint,derived,"fingerprint must be derived server-side from the fetched object");
  // A later re-check through a presigned URL on another host must be refused for host mismatch.
  const {nonce:n2}=await f.service.issueByoChallenge(f.req,id);
  const evil="https://attacker.example/.gendragoon-challenge/"+n2+"?X-Amz-Signature=x";
  await assert.rejects(f.service.verifyByo(f.req,id,{presignedUrl:evil}),err=>/ENDPOINT|HOST/i.test(err.code||""),"presigned URL on a foreign host must be refused for host mismatch");
});
test("4 byo challenge: re-registering the provider clears byoChallengeVerified / byoActive / manualProviderConfigured",async()=>{
  const f=fixture();const id=idFor(7);
  f.put(id,{...byoBase,providerType:"s3",endpoint:"https://old.s3.amazonaws.com",bucketFingerprint:"ab".repeat(8),
    byoRegistered:true,byoChallengeVerified:true,byoActive:true,manualProviderConfigured:true});
  await f.service.registerByo(f.req,id,{provider:"s3",endpoint:"https://new-bucket.s3.amazonaws.com",bucketFingerprint:"ef".repeat(8)});
  const w=f.record(id);
  assert.equal(w.byoChallengeVerified,false,"verification for the old endpoint carried over to the new one");
  assert.equal(w.byoActive,false);assert.equal(w.manualProviderConfigured,false);
});
test("4 byo provider: registering SFTP returns 422 byo_provider_unsupported and grants no storage (S3-compatible only at launch)",
  {todo:"EXPECTED FAIL on e9ef0e3: normalizeProvider accepts 'sftp' and registerByo stores it"},async t=>{
  const f=fixture();const id=idFor(8);f.put(id,byoBase);
  const post=await billingRoutes(t,f);
  const r=await post("/v2/workspaces/"+id+"/byo/register",{provider:"sftp",endpoint:"sftp.example.com:22",hostFingerprint:"ab".repeat(16)});
  assert.equal(r.status,422);assert.equal(r.body.code||r.body.error,"byo_provider_unsupported");
  const w=f.record(id);
  assert.notEqual(w.providerType,"sftp");assert.notEqual(w.byoActive,true);assert.equal(effectiveWorkers(w),0);
});

// ---- 5. BYO billing $5/month and no storage without a verified challenge ----
test("5 byo billing: BYO quote is $5/month like managed workspaces (billing_v2.js byoQuote is 1000 cents)",()=>{
  assert.equal(byoQuote("month").totalCents,500);
});
test("5 byo grant: no transfer workers / storage for a BYO workspace without byoChallengeVerified",()=>{
  const w={...byoBase,byoActive:true,manualProviderConfigured:true,byoChallengeVerified:false};
  assert.equal(effectiveWorkers(w),0,"effectiveWorkers grants BYO transfers on byoActive+manualProviderConfigured alone");
});
test("5 byo grant: owner BYO checkout (billing_v2.js ~line 304) must refuse to activate without byoChallengeVerified",async t=>{
  const f=fixture();const id=idFor(9);
  f.put(id,{...byoBase,projectStatus:"active",projectFeeStatus:"owner",manualProviderConfigured:true,byoChallengeVerified:false});
  const post=await billingRoutes(t,f,{ownerBenefits:true});
  const r=await post("/v2/workspaces/"+id+"/checkout/byo",{});
  assert.equal(r.status,409,"owner path activated BYO without a verified challenge: "+JSON.stringify(r.body));
  assert.notEqual(f.record(id).byoActive,true);
});

// ---- 6. Merge vs. billing on the source workspace ----
test("6 merge: source subscriptions are cancelled exactly once (idempotent) or merge is refused while billing is active",async()=>{
  const cancelled=[];
  const stripe={prices:{retrieve:async()=>{throw Error("no");}},checkout:{sessions:{}},
    subscriptions:{cancel:async id=>{cancelled.push(id);return {id,status:"canceled"};},del:async id=>{cancelled.push(id);return {id,status:"canceled"};},
      retrieve:async id=>({id,status:cancelled.includes(id)?"canceled":"active"})}};
  const f=fixture({stripe});const source=idFor(10),target=idFor(11);
  f.put(source,{name:"Src",storageActive:true,storageTier:"100GB",storageSubscriptionId:"sub_storage_src",storageStatus:"active",
    workspaceFeeModel:"monthly",workspaceFeeStatus:"active",workspaceFeePaid:true,workspaceFeeSubscriptionId:"sub_fee_src"});
  f.put(target,{name:"Dst"});
  let refused=null,result=null;
  try{result=await f.service.merge(f.req,source,{targetId:target,confirmName:"Src"});}catch(error){refused=error;}
  if(refused){
    assert.match(String(refused.code),/BILLING/,"merge refused, but not for active billing: "+refused.code);
    assert.ok(f.record(source),"refused merge must keep the source");return;
  }
  assert.equal(result.sourceDeleted,true);
  assert.deepEqual([...cancelled].sort(),["sub_fee_src","sub_storage_src"],"source was merged away while its subscriptions keep billing");
  await f.service.merge(f.req,source,{targetId:target,confirmName:"Src"});
  assert.equal(cancelled.length,2,"idempotent retry must not cancel again");
});

// ---- 7. Large merges: Firestore 500-write limit, tombstone first, consistent reads ----
function limitedFirestore(){
  const db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_test"}]]);
  const run=db.runTransaction.bind(db);db.outsideReadsInTx=0;let inTx=0;
  const collection=db.collection;
  // Count collection queries issued with .get() while a transaction body runs (i.e. not through tx.get).
  const wrapQuery=q=>new Proxy(q,{get(target,key){const v=target[key];
    if(key==="get")return async()=>{if(inTx>0)db.outsideReadsInTx++;return v();};
    if(["where","orderBy","limit"].includes(key))return(...a)=>wrapQuery(v(...a));
    if(key==="doc")return id=>wrapDoc(v(id));return v;}});
  const wrapDoc=d=>new Proxy(d,{get(target,key){const v=target[key];return key==="collection"?name=>wrapQuery(v(name)):v;}});
  db.collection=name=>wrapQuery(collection(name));
  db.runTransaction=fn=>run(async tx=>{
    let writes=0;const count=m=>(...a)=>{writes++;if(writes>500)throw Object.assign(Error("3 INVALID_ARGUMENT: maximum 500 writes allowed per request"),{code:3});return m(...a);};
    const limited={get:async ref=>{inTx--;try{return await tx.get(ref);}finally{inTx++;}},set:count(tx.set),update:count(tx.update),create:count(tx.create),delete:count(tx.delete)};
    inTx++;try{return await fn(limited);}finally{inTx--;}
  });
  return db;
}
test("7 merge: a source with 600 files completes under Firestore's 500-writes-per-transaction limit (resumable batches)",async()=>{
  const db=limitedFirestore();const f=fixture({db});const source=idFor(12),target=idFor(13);
  f.put(source,{name:"Big"});f.put(target,{name:"Into"});
  for(let n=0;n<600;n++){const buf=Buffer.from("file-"+n);f.file(source,"f"+n,{name:"f"+n+".txt",sizeBytes:buf.length,sha256:sha(buf)});}
  const result=await f.service.merge(f.req,source,{targetId:target,confirmName:"Big"});
  assert.equal(result.copied,600);assert.equal(f.record(source),undefined);
  assert.equal([...db.rows.keys()].filter(k=>k.startsWith(f.path(source)+"/files/")).length,0,"source file rows left behind");
});
test("7 merge: tombstone is written before source deletion starts",async()=>{
  const db=limitedFirestore();const f=fixture({db});const source=idFor(14),target=idFor(15);
  f.put(source,{name:"Small"});f.put(target,{name:"Dest"});
  for(let n=0;n<3;n++){const buf=Buffer.from("s-"+n);f.file(source,"f"+n,{name:"s"+n,sizeBytes:buf.length,sha256:sha(buf)});}
  const order=[];const tomb="gd_accounts/"+owner+"/workspace_merges/"+source;
  const del=db.rows.delete.bind(db.rows),set=db.rows.set.bind(db.rows);
  db.rows.delete=key=>{if(key.startsWith(f.path(source)+"/files/"))order.push("delete-source-file");return del(key);};
  db.rows.set=(key,value)=>{if(key===tomb)order.push("tombstone");return set(key,value);};
  await f.service.merge(f.req,source,{targetId:target,confirmName:"Small"});
  assert.equal(order[0],"tombstone","source files were deleted before a tombstone existed: "+order.join(","));
});
test("7 merge: the final transaction reads files/uploads through the transaction, not via listFiles outside its consistency",async()=>{
  const db=limitedFirestore();const f=fixture({db});const source=idFor(22),target=idFor(23);
  f.put(source,{name:"Cons"});f.put(target,{name:"Target"});
  for(let n=0;n<3;n++){const buf=Buffer.from("c-"+n);f.file(source,"f"+n,{name:"c"+n,sizeBytes:buf.length,sha256:sha(buf)});}
  await f.service.merge(f.req,source,{targetId:target,confirmName:"Cons"});
  assert.equal(db.outsideReadsInTx,0,"merge transaction body queried collections outside the transaction (listFiles/uploads)");
});

// ---- 8. Copy verification must use stored object checksums, not a size+name hash ----
function gcsLikeStore(corruptKeys=new Set()){
  // Object metadata like GCS: size, crc32c, md5Hash. No sha256 is available from the store.
  const blobs=new Map();
  const meta=buf=>({size:buf.length,md5Hash:md5(buf),crc32c:crypto.createHash("sha1").update(buf).digest("base64").slice(0,8)});
  return {blobs,put:(key,buf)=>blobs.set(key,Buffer.from(buf)),meta,
    async copy(from,to){const src=blobs.get(from);if(!src)throw Error("missing");
      const out=corruptKeys.has(from)?Buffer.from(src.map(b=>b^0xff)):Buffer.from(src);blobs.set(to,out);return meta(out);},
    async stat(key){const v=blobs.get(key);return v?meta(v):null;},async delete(key){blobs.delete(key);}};
}
test("8 merge: source without sha256 is verified against stored md5/crc32c: clean copy succeeds, same-size corrupted copy is detected",async()=>{
  const clean=Buffer.from("clean-bytes"),bad=Buffer.from("corrupt-me!");
  {
    const store=gcsLikeStore();store.put("s/clean",clean);
    const f=fixture({objectStore:store});const source=idFor(16),target=idFor(17);f.put(source,{name:"A"});f.put(target,{name:"B"});
    f.file(source,"c",{name:"clean.txt",sizeBytes:clean.length,objectKey:"s/clean",...store.meta(clean)});
    const r=await f.service.merge(f.req,source,{targetId:target,confirmName:"A"})
      .catch(error=>assert.fail("clean copy rejected ("+error.code+"): verification compares a store sha256 to H(size:name) instead of stored md5/crc32c"));
    assert.equal(r.copied,1);
  }
  {
    const store=gcsLikeStore(new Set(["s/bad"]));store.put("s/bad",bad);
    const f=fixture({objectStore:store});const source=idFor(18),target=idFor(19);f.put(source,{name:"C"});f.put(target,{name:"D"});
    f.file(source,"b",{name:"bad.txt",sizeBytes:bad.length,objectKey:"s/bad",...store.meta(bad)});
    await assert.rejects(f.service.merge(f.req,source,{targetId:target,confirmName:"C"}),{code:"MERGE_VERIFY_FAILED"});
    assert.ok(f.record(source),"source must survive a failed verification");
  }
});
test("8 merge: a file without sha256 must not be 'verified' by, or recorded with, a synthesized size+name hash",async()=>{
  const f=fixture();const source=idFor(20),target=idFor(21);f.put(source,{name:"E"});f.put(target,{name:"F"});
  f.file(source,"x",{name:"x.bin",sizeBytes:7,crc32c:"AAAAAA=="});
  const fake=fileDigest({name:"x.bin",sizeBytes:7});
  await f.service.merge(f.req,source,{targetId:target,confirmName:"E"}).catch(()=>{});
  const written=[...f.db.rows.entries()].filter(([k])=>k.startsWith(f.path(target)+"/files/")).map(([,v])=>v);
  for(const row of written){
    assert.notEqual(row.sha256,fake,"target record carries sha256 = H(size:name), so later checks pass trivially");
    assert.notEqual(row.copiedFrom?.sha256,fake);
  }
  assert.ok(written.length===0||written.every(r=>r.crc32c==="AAAAAA=="),"stored checksum (crc32c) must be carried over");
});
