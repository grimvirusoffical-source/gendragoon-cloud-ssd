"use strict";
// /provider/v1 against in-memory Firestore and blob store fakes. No network beyond 127.0.0.1, no credentials.
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {memoryBlobStore}=require("./provider_blobstore");
const {registerProviderV1,COLL}=require("./provider_v1");

const sha=b=>crypto.createHash("sha256").update(b).digest("hex");
async function rig({quotaBytes=1_000_000,limits={}}={}){
 const db=memoryFirestore(),blobs=memoryBlobStore(),clock={t:1_800_000_000_000};
 const app=express();
 const firebaseAuth=(req,res,next)=>{const uid=req.headers["x-test-uid"];if(!uid)return res.status(401).json({error:"Sign in with Google"});req.user={uid};next();};
 const accountKey=uid=>sha("gd-v1:"+uid);
 const resolveWorkspace=async(uid,id)=>id==="ws-1"&&uid!=="nobody"?{quotaBytes}:null;
 const api=registerProviderV1({app,db,blobs,firebaseAuth,accountKey,resolveWorkspace,now:()=>clock.t,limits});
 const server=await new Promise(r=>{const s=app.listen(0,"127.0.0.1",()=>r(s));});
 const base="http://127.0.0.1:"+server.address().port+"/provider/v1";
 const call=(path,{method="GET",uid,key,body,headers={}}={})=>{
  const h={...headers};if(uid)h["x-test-uid"]=uid;if(key)h.authorization="Bearer "+key;
  let b=body;if(body!==undefined&&!Buffer.isBuffer(body)&&typeof body!=="string"){b=JSON.stringify(body);h["content-type"]="application/json";}
  return fetch(base+path,{method,headers:h,body:b});
 };
 async function connect(uid="alice",scopes){
  const g=await (await call("/connect/grants",{method:"POST",uid,body:{workspaceId:"ws-1",scopes,requester:{name:"RedX on Mac",host:"127.0.0.1:7777"}}})).json();
  const r=await call("/connect/redeem",{method:"POST",body:{grant:g.grant,client:{name:"RedX"}}});
  assert.equal(r.status,201);return {...(await r.json()),grant:g.grant};
 }
 return {db,blobs,clock,api,call,connect,close:()=>server.close()};
}
const put=(t,key,data,headers={})=>t.call("/blobs/"+sha(data),{method:"PUT",key,body:Buffer.from(data),headers});

test("pair 1: grant -> redeem -> blob round trip, ids are SHA-256, grant is single use",async()=>{
 const t=await rig();try{
  const c=await t.connect();
  assert.match(c.apiKey,/^gdpk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  assert.equal(c.capabilities.maxBlobBytes,16*1024*1024);
  const again=await t.call("/connect/redeem",{method:"POST",body:{grant:c.grant}});
  assert.equal(again.status,400);assert.equal((await again.json()).error,"invalid_grant");
  let r=await put(t,c.apiKey,"hello chunk");assert.equal(r.status,201);
  r=await put(t,c.apiKey,"hello chunk");assert.equal(r.status,200);assert.equal((await r.json()).created,false);
  r=await t.call("/blobs/"+sha("hello chunk"),{key:c.apiKey});
  assert.equal(r.status,200);assert.equal(Buffer.from(await r.arrayBuffer()).toString(),"hello chunk");
  assert.equal(r.headers.get("x-content-sha256"),sha("hello chunk"));
  r=await t.call("/blobs/"+sha("hello chunk"),{method:"HEAD",key:c.apiKey});assert.equal(r.status,200);
  r=await t.call("/blobs/"+sha("nope"),{method:"HEAD",key:c.apiKey});assert.equal(r.status,404);
  r=await t.call("/blobs/"+sha("nope"),{key:c.apiKey});assert.equal(r.status,404);assert.equal((await r.json()).error,"not_found");
  r=await t.call("/blobs/"+sha("hello chunk"),{method:"DELETE",key:c.apiKey});assert.equal(r.status,204);
  r=await t.call("/blobs/"+sha("hello chunk"),{method:"DELETE",key:c.apiKey});assert.equal(r.status,204);
  const name=[...t.blobs.objects.keys()];assert.equal(name.length,0);
 }finally{t.close();}
});

test("checksums: content id must equal sha256(body); sealed mode needs a matching X-Content-SHA256",async()=>{
 const t=await rig();try{
  const c=await t.connect();
  let r=await t.call("/blobs/"+sha("a"),{method:"PUT",key:c.apiKey,body:Buffer.from("b")});
  assert.equal(r.status,422);assert.equal((await r.json()).error,"checksum_mismatch");
  r=await put(t,c.apiKey,"a",{"x-content-sha256":sha("other")});assert.equal(r.status,422);
  const sealedId="ab".repeat(32);
  r=await t.call("/blobs/"+sealedId,{method:"PUT",key:c.apiKey,body:Buffer.from("x"),headers:{"x-id-mode":"sealed"}});
  assert.equal(r.status,400);assert.equal((await r.json()).error,"checksum_required");
  r=await t.call("/blobs/"+sealedId,{method:"PUT",key:c.apiKey,body:Buffer.from("x"),headers:{"x-id-mode":"sealed","x-content-sha256":sha("x")}});
  assert.equal(r.status,201);
  r=await t.call("/blobs/NOTHEX",{method:"PUT",key:c.apiKey,body:Buffer.from("x")});assert.equal(r.status,400);
  assert.equal(t.blobs.objects.size,1,"nothing stored on a mismatch");
 }finally{t.close();}
});

test("pair 2: authorize code + PKCE S256 -> token; wrong verifier refused without burning the code",async()=>{
 const t=await rig();try{
  const verifier=crypto.randomBytes(32).toString("base64url");
  const challenge=crypto.createHash("sha256").update(verifier).digest("base64url");
  let r=await t.call("/connect/authorize",{method:"POST",uid:"alice",body:{workspaceId:"ws-1",codeChallenge:challenge,codeChallengeMethod:"plain"}});
  assert.equal(r.status,400);
  r=await t.call("/connect/authorize",{method:"POST",uid:"alice",body:{workspaceId:"ws-1",codeChallenge:challenge,codeChallengeMethod:"S256"}});
  const {code}=await r.json();
  r=await t.call("/connect/token",{method:"POST",body:{code,codeVerifier:crypto.randomBytes(32).toString("base64url")}});
  assert.equal(r.status,400);
  r=await t.call("/connect/redeem",{method:"POST",body:{grant:code}});assert.equal(r.status,400,"a code is not a grant");
  r=await t.call("/connect/token",{method:"POST",body:{code,codeVerifier:verifier}});
  assert.equal(r.status,201);const k=await r.json();
  r=await put(t,k.apiKey,"via pkce");assert.equal(r.status,201);
  r=await t.call("/connect/token",{method:"POST",body:{code,codeVerifier:verifier}});assert.equal(r.status,400,"code replay");
 }finally{t.close();}
});

test("grant expiry, unknown workspace, unauthenticated calls",async()=>{
 const t=await rig();try{
  let r=await t.call("/connect/grants",{method:"POST",body:{workspaceId:"ws-1"}});assert.equal(r.status,401);
  r=await t.call("/connect/grants",{method:"POST",uid:"alice",body:{workspaceId:"ws-9"}});assert.equal(r.status,404);
  r=await t.call("/connect/grants",{method:"POST",uid:"alice",body:{workspaceId:"ws-1",scopes:["admin"]}});assert.equal(r.status,400);
  const g=await (await t.call("/connect/grants",{method:"POST",uid:"alice",body:{workspaceId:"ws-1"}})).json();
  t.clock.t+=5*60*1000+1;
  r=await t.call("/connect/redeem",{method:"POST",body:{grant:g.grant}});assert.equal(r.status,400);
  r=await t.call("/blobs",{});assert.equal(r.status,401);
  r=await t.call("/blobs",{key:"gdpk_0123456789abcdef_"+"A".repeat(43)});assert.equal(r.status,401);
  r=await t.call("/capabilities");assert.equal(r.status,200);
 }finally{t.close();}
});

test("quota: reservation, 507, refund on delete, no charge for an idempotent re-put, refund on storage failure",async()=>{
 const t=await rig({quotaBytes:100});try{
  const c=await t.connect();
  const sixty="x".repeat(60),fifty="y".repeat(50);
  assert.equal((await put(t,c.apiKey,sixty)).status,201);
  assert.equal((await put(t,c.apiKey,sixty)).status,200);
  let r=await put(t,c.apiKey,fifty);assert.equal(r.status,507);
  const body=await r.json();assert.equal(body.error,"quota_exceeded");assert.equal(body.quotaBytes,100);
  let u=await (await t.call("/usage",{key:c.apiKey})).json();assert.equal(u.usedBytes,60);assert.equal(u.objectCount,1);
  await t.call("/blobs/"+sha(sixty),{method:"DELETE",key:c.apiKey});
  t.blobs.failNext("put");
  r=await put(t,c.apiKey,fifty);assert.equal(r.status,503);assert.equal((await r.json()).error,"storage_unavailable");
  u=await (await t.call("/usage",{key:c.apiKey})).json();assert.equal(u.usedBytes,0,"failed write refunded");assert.equal(u.objectCount,0);
  assert.equal((await put(t,c.apiKey,fifty)).status,201);
  u=await (await t.call("/usage",{key:c.apiKey})).json();assert.equal(u.usedBytes,50);
 }finally{t.close();}
});

test("blob size cap: 16 MiB accepted, 16 MiB + 1 is 413 blob_too_large",async()=>{
 const t=await rig({quotaBytes:64*1024*1024});try{
  const c=await t.connect();
  const ok=Buffer.alloc(16*1024*1024,1),big=Buffer.alloc(16*1024*1024+1,1);
  let r=await t.call("/blobs/"+sha(ok),{method:"PUT",key:c.apiKey,body:ok});assert.equal(r.status,201);
  r=await t.call("/blobs/"+sha(big),{method:"PUT",key:c.apiKey,body:big});
  assert.equal(r.status,413);assert.equal((await r.json()).error,"blob_too_large");
 }finally{t.close();}
});

test("manifests: atomic put, If-None-Match create, If-Match CAS, exactly one of 8 racing writers wins",async()=>{
 const t=await rig();try{
  const c=await t.connect();const key="cd".repeat(32),path="/manifests/"+key;
  let r=await t.call(path,{key:c.apiKey});assert.equal(r.status,404);
  r=await t.call(path,{method:"PUT",key:c.apiKey,body:Buffer.from("v1"),headers:{"if-none-match":"*"}});assert.equal(r.status,201);
  const e1=r.headers.get("etag");
  r=await t.call(path,{method:"PUT",key:c.apiKey,body:Buffer.from("v1b"),headers:{"if-none-match":"*"}});assert.equal(r.status,412);
  const racers=await Promise.all(Array.from({length:8},(_,i)=>t.call(path,{method:"PUT",key:c.apiKey,body:Buffer.from("v2-"+i),headers:{"if-match":e1}})));
  const statuses=racers.map(x=>x.status).sort();
  assert.deepEqual(statuses,[200,412,412,412,412,412,412,412]);
  r=await t.call(path,{key:c.apiKey});const now=Buffer.from(await r.arrayBuffer()).toString();assert.match(now,/^v2-\d$/);
  r=await t.call(path,{method:"PUT",key:c.apiKey,body:Buffer.from("v3"),headers:{"if-match":e1}});assert.equal(r.status,412,"stale etag");
  r=await t.call(path,{method:"PUT",key:c.apiKey,body:Buffer.from("v4")});assert.equal(r.status,200,"unconditional overwrite is atomic");
  const u=await (await t.call("/usage",{key:c.apiKey})).json();assert.equal(u.usedBytes,2);assert.equal(u.objectCount,1);
  r=await t.call("/manifests",{key:c.apiKey});assert.deepEqual((await r.json()).ids,[key]);
  r=await t.call(path,{method:"DELETE",key:c.apiKey,headers:{"if-match":'"999"'}});assert.equal(r.status,412);
  r=await t.call(path,{method:"DELETE",key:c.apiKey});assert.equal(r.status,204);
  r=await t.call(path,{key:c.apiKey});assert.equal(r.status,404);
 }finally{t.close();}
});

test("list pagination and batch-has",async()=>{
 const t=await rig();try{
  const c=await t.connect();const ids=[];
  for(let i=0;i<5;i++){const d="chunk"+i;ids.push(sha(d));await put(t,c.apiKey,d);}
  ids.sort();
  let r=await (await t.call("/blobs?limit=2",{key:c.apiKey})).json();
  assert.deepEqual(r.ids,ids.slice(0,2));
  r=await (await t.call("/blobs?limit=10&cursor="+r.next,{key:c.apiKey})).json();
  assert.deepEqual(r.ids,ids.slice(2));assert.equal(r.next,null);
  r=await (await t.call("/blobs/batch-has",{method:"POST",key:c.apiKey,body:{ids:[ids[0],sha("missing"),ids[3]]}})).json();
  assert.deepEqual(r.present,[ids[0],ids[3]]);
 }finally{t.close();}
});

test("scopes, tenant isolation, rotation grace, revoke",async()=>{
 const t=await rig();try{
  const ro=await t.connect("alice",["blobs:r"]);
  assert.equal((await put(t,ro.apiKey,"no")).status,403);
  const a=await t.connect("alice"),b=await t.connect("bob");
  await put(t,a.apiKey,"alice data");
  assert.equal((await t.call("/blobs/"+sha("alice data"),{key:b.apiKey})).status,404,"bob cannot see alice's blob");
  assert.equal((await t.call("/blobs/"+sha("alice data"),{key:ro.apiKey})).status,404,"bindings are separate namespaces");
  let r=await t.call("/connect/rotate",{method:"POST",key:a.apiKey});assert.equal(r.status,201);
  const fresh=(await r.json()).apiKey;
  r=await t.call("/connect/rotate",{method:"POST",key:a.apiKey});assert.equal(r.status,409);
  assert.equal((await t.call("/usage",{key:a.apiKey})).status,200,"old key in grace");
  t.clock.t+=10*60*1000+1;
  assert.equal((await t.call("/usage",{key:a.apiKey})).status,401,"old key after grace");
  assert.equal((await t.call("/usage",{key:fresh})).status,200);
  let list=await (await t.call("/bindings",{uid:"alice"})).json();
  assert.equal(list.bindings.length,2);assert.ok(list.bindings.every(x=>!("apiKey" in x)));
  assert.equal((await t.call("/bindings/"+a.bindingId,{method:"DELETE",uid:"bob"})).status,404);
  r=await t.call("/bindings/"+a.bindingId+"?deleteData=true",{method:"DELETE",uid:"alice"});
  assert.equal(r.status,200);assert.equal((await r.json()).purgedObjects,1);
  assert.equal((await t.call("/usage",{key:fresh})).status,401,"revoked binding");
 }finally{t.close();}
});

test("rate limit returns 429 with Retry-After",async()=>{
 const t=await rig({limits:{rps:1,burst:3}});try{
  const c=await t.connect();
  const codes=[];for(let i=0;i<5;i++)codes.push((await t.call("/usage",{key:c.apiKey})).status);
  assert.deepEqual(codes,[200,200,200,429,429]);
  const r=await t.call("/usage",{key:c.apiKey});assert.ok(Number(r.headers.get("retry-after"))>=1);
 }finally{t.close();}
});

test("reconcile repairs counters from the bucket; audit rows never hold secrets",async()=>{
 const t=await rig();try{
  const c=await t.connect();await put(t,c.apiKey,"12345");
  await t.db.collection(COLL.bindings).doc(c.bindingId).update({usedBytes:999,objectCount:7});
  const out=await t.api.reconcileBinding(c.bindingId);
  assert.deepEqual([out.usedBytes,out.objectCount,out.previousUsedBytes],[5,1,999]);
  await t.call("/blobs/"+sha("a"),{method:"PUT",key:c.apiKey,body:Buffer.from("b")});
  await new Promise(r=>setTimeout(r,20));
  const rows=[...t.db.rows.entries()].filter(([k])=>k.startsWith(COLL.audit+"/")).map(([,v])=>JSON.stringify(v));
  assert.ok(rows.length>=3);
  for(const row of rows)assert.doesNotMatch(row,/gdpk_|gdpg_|gdpc_|apiKey|digest/);
  const keyRows=[...t.db.rows.entries()].filter(([k])=>k.startsWith(COLL.keys+"/")).map(([,v])=>JSON.stringify(v));
  for(const row of keyRows)assert.ok(!row.includes(c.apiKey.split("_").slice(2).join("_")),"key secret not stored");
 }finally{t.close();}
});
